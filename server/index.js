// Echoes of the Hearth — authoritative co-op survival server.
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { genWorld, findSpawn, nearestLand, SIZE, T, MONOLITHS, CORE, DIGGABLE, WORLD_VERSION, ACTIVATION_I, ISLES } from '../shared/world.js';
import { NODE_DEF, RECIPES, STRUCT_HP, WOODEN, NAMES, canAfford, pay, emptyInv } from '../shared/defs.js';
import { TICK_MS, DAY_LENGTH_SEC, isNightTime } from '../shared/time.js';

const PORT = 8081;
const SEED = process.env.SEED || 'hearth-1';
const world = genWorld(SEED);
const spawn = findSpawn(world);
const ti = (x, y) => (y | 0) * SIZE + (x | 0);

// --- world state ---
const nodeHp = new Map();            // i -> remaining hp (only while damaged)
const removed = new Map();           // i -> respawn timestamp
const mudTiles = new Set();
const sectorChops = {};
const structures = new Map();        // i -> {kind, hp, owner}
const mono = [false, false, false, false];
const players = new Map();           // id -> player
const creatures = new Map();         // id -> {x,y,hp}
const animals = new Map();           // id -> {x,y,hp,dx,dy,tw,type,home} — huntable wildlife
// type -> [home tile, island x0, y0, hp, meat, flee radius, flee speed]
const ANIMAL_TYPES = {
  deer:   [T.GRASS, ISLES[0][0] - 35, ISLES[0][1] - 35, 2, 2, 4, 0.42],   boar: [T.GRASS, ISLES[0][0] - 35, ISLES[0][1] - 35, 4, 3, 3, 0.3],
  lizard: [T.SAND,  ISLES[1][0] - 35, ISLES[1][1] - 35, 2, 1, 4, 0.5],    crab: [T.SAND,  ISLES[1][0] - 35, ISLES[1][1] - 35, 1, 1, 5, 0.35],
  fox:    [T.SNOW,  ISLES[2][0] - 35, ISLES[2][1] - 35, 2, 2, 6, 0.42],   hare: [T.SNOW,  ISLES[2][0] - 35, ISLES[2][1] - 35, 1, 1, 7, 0.55],
  toad:   [T.MUD,   ISLES[3][0] - 35, ISLES[3][1] - 35, 2, 1, 2.5, 0.25]
};
// monster type -> [hp base, hp/strength, speed, contact dmg]
const CRE_TYPES = { crawler: [1, 1, 0.44, 1], stalker: [2, 1, 0.68, 1], brute: [6, 3, 0.3, 2], wisp: [3, 0, 0.2, 0] };
let weather = { kind: null, until: 0 };
const infected = new Map();          // tile -> cure timestamp (wisp-spread corruption)
const digs = new Set();              // underground tiles carved out by players
const torches = new Set();           // torch-lit underground tiles
const furn = new Map();              // shelter furniture: tile -> {kind, owner}
const brokenBergs = new Set();       // icebergs smashed by reinforced boats
let nextCre = 1, nextAni = 1, time = 0.3, day = 1, won = false, tickN = 0;
let wave = null;                     // {until, engineI}
const profiles = {};                 // persistent player data keyed by browser token

// --- persistence: JSON snapshot on disk (swap for a real DB later) ---
const SAVE_PATH = 'server/save.json';
function loadSave() {
  if (!existsSync(SAVE_PATH)) return;
  try {
    const s = JSON.parse(readFileSync(SAVE_PATH, 'utf8'));
    if (s.version !== WORLD_VERSION || s.seed !== SEED) return console.log('[hearth] save.json version/seed mismatch — starting fresh');
    day = s.day; time = s.time; won = s.won;
    s.mono.forEach((v, i) => (mono[i] = v));
    for (const [i, rem] of s.removed) removed.set(i, Date.now() + rem);
    s.mud.forEach((i) => mudTiles.add(i));
    Object.assign(sectorChops, s.sectorChops || {});
    for (const [i, st] of s.structures) structures.set(i, st);
    s.digs.forEach((i) => digs.add(i));
    s.torches.forEach((i) => torches.add(i));
    for (const [i, f] of s.furn || []) furn.set(i, f);
    (s.brokenBergs || []).forEach((i) => brokenBergs.add(i));
    Object.assign(profiles, s.profiles || {});
    console.log(`[hearth] save loaded: day ${day}, ${structures.size} structures, ${Object.keys(profiles).length} profiles`);
  } catch (e) { console.log('[hearth] failed to load save:', e.message); }
}
function saveGame() {
  for (const p of players.values()) if (p.tok) profiles[p.tok] = snapshot(p);
  const s = {
    version: WORLD_VERSION, layout: 'v' + WORLD_VERSION + ':' + SIZE + ':' + SEED,
    seed: SEED, day, time, won, mono,
    removed: [...removed].map(([i, at]) => [i, Math.max(0, at - Date.now())]),
    mud: [...mudTiles], sectorChops,
    structures: [...structures], digs: [...digs], torches: [...torches],
    furn: [...furn], brokenBergs: [...brokenBergs], profiles
  };
  try { writeFileSync(SAVE_PATH, JSON.stringify(s)); } catch (e) { console.log('[hearth] save failed:', e.message); }
}
const snapshot = (p) => ({ inv: p.inv, tools: [...p.tools], gear: [...p.gear], wornGear: p.wornGear || null, hp: p.hp, hunger: p.hunger, thirst: p.thirst, x: p.x, y: p.y, name: p.name || 'Keeper' });
loadSave();
setInterval(saveGame, 30000);
process.on('SIGINT', () => { saveGame(); console.log('\n[hearth] saved. bye'); process.exit(0); });

const wss = new WebSocketServer({ port: PORT });
console.log(`[hearth] server on ws://0.0.0.0:${PORT} seed=${SEED}`);

const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const bcast = (m) => { const s = JSON.stringify(m); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); };
const isNight = () => isNightTime(time);
const blocked = (x, y) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return true;
  if (world.tiles[ti(x, y)] === T.WATER) return true;
  return structures.has(ti(x, y));
};
const nearAnyStruct = (p, r) => {
  for (const [i] of structures)
    if (Math.hypot((i % SIZE) - p.x, ((i / SIZE) | 0) - p.y) <= r) return true;
  return false;
};
const nearStruct = (p, kind, r = 4) => {
  for (const [i, s] of structures)
    if (s.kind === kind && Math.hypot((i % SIZE) - p.x, ((i / SIZE) | 0) - p.y) <= r) return true;
  return false;
};
const sendInv = (id, p) => send(p.ws, { t: 'inv', inv: p.inv, tools: [...p.tools], gear: [...p.gear], wornGear: p.wornGear || null });
const respawnPoint = (id) => {
  for (const [i, f] of furn)   // own bed wins
    if (f.kind === 'bed' && f.owner === id) return [i % SIZE, ((i / SIZE) | 0) + 1];
  let best = spawn, bd = 1e9;
  for (const [i, s] of structures)
    if (s.kind === 'campfire' && s.owner === id) {
      const x = i % SIZE, y = (i / SIZE) | 0;
      const d = Math.hypot(x - spawn[0], y - spawn[1]);
      if (d < bd) { bd = d; best = [x, y + 1]; }
    }
  return best;
};

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 8);
  let p = null;   // created on hello (so saved profiles can be restored first)

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();

    if (m.t === 'hello') {
      if (p) return;
      const rawName = String(m.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 18);
      const helloName = rawName.length >= 2 ? rawName : 'Keeper';
      p = { ws, x: spawn[0], y: spawn[1], z: 0, hp: 10, hunger: 10, thirst: 10, inv: emptyInv(), tools: new Set(), gear: new Set(), equip: null, wornGear: null, name: helloName, lastGather: 0, lastAtk: 0, tok: typeof m.tok === 'string' ? m.tok.slice(0, 64) : null, lastLandX: spawn[0], lastLandY: spawn[1], b: 0, thermN: 0 };
      const prof = p.tok && profiles[p.tok];
      if (prof) {
        Object.assign(p.inv, prof.inv);
        prof.tools.forEach((t) => p.tools.add(t));
        prof.gear.forEach((g) => p.gear.add(g));
        p.hp = prof.hp; p.hunger = prof.hunger; p.thirst = prof.thirst;
        if (world.tiles[ti(prof.x, prof.y)] !== T.WATER) { p.x = prof.x; p.y = prof.y; }
        p.wornGear = prof.wornGear && p.gear.has(prof.wornGear) ? prof.wornGear : null;
        if (prof.name && helloName === 'Keeper') p.name = prof.name;
      }
      players.set(id, p);
      send(ws, {
        t: 'init', id, seed: SEED, x: p.x, y: p.y, time, day, mono, won,
        name: p.name,
        weather: weather.kind, infected: [...infected.keys()], digs: [...digs],
        torches: [...torches], brokenBergs: [...brokenBergs],
        furn: [...furn].map(([i, f]) => [i, f.kind]),
        removed: [...removed.keys()], mud: [...mudTiles],
        structures: [...structures].map(([i, s]) => [i, s.kind, s.hp, s.dir || 0, s.lvl || 1]),
        inv: p.inv, tools: [...p.tools], gear: [...p.gear], wornGear: p.wornGear || null,
        players: [...players].filter(([pid]) => pid !== id).map(([pid, q]) => [pid, q.x, q.y, q.equip, q.z, q.name, q.b | 0])
      });
      bcast({ t: 'pj', id, x: p.x, y: p.y, name: p.name });
      console.log(`[hearth] ${id} (${p.name}) joined${prof ? ' (profile restored)' : ''} (${players.size} online)`);
      return;
    }
    if (!p) return;

    if (m.t === 'dev') {
      if (!process.env.DEV) return send(ws, { t: 'msg', s: 'Dev mode is off — start the server with: npm run server:dev' });
      Object.assign(p.inv, {
        wood: 500, stone: 500, fiber: 200, crystal: 100, iron: 100, diamond: 50, starmetal: 50,
        essence: 100, water: 10, meat: 5, cookedmeat: 10, wall: 50, campfire: 5, workbench: 3,
        forge: 2, mineshaft: 3, shelter: 9, engine: 1, core: 4, boat: 2, sboat: 1, torch: 30
      });
      ['axe', 'pick', 'spick', 'sword', 'isword'].forEach((t) => p.tools.add(t));
      ['heatcloak', 'furcloak'].forEach((g) => p.gear.add(g));
      p.hp = 10; p.hunger = 10; p.thirst = 10;
      sendInv(id, p);
      send(ws, { t: 'stat', hunger: 10, thirst: 10 });
      send(ws, { t: 'msg', s: '🛠 DEV KIT granted: all tools, gear and materials.' });
      return;
    }

    if (m.t === 'pos') {
      // fall damage: dropping 2+ elevation levels in one step hurts (drop − 1 hp)
      const moved = Math.hypot(m.x - p.x, m.y - p.y);
      if (p.z === 0 && !m.b && moved > 0.01 && moved < 3) {
        const drop = world.elev[ti(p.x, p.y)] - world.elev[ti(m.x, m.y)];
        if (drop >= 2 && world.tiles[ti(m.x, m.y)] !== T.WATER) {
          p.hp = Math.max(0, p.hp - (drop - 1));
          if (p.hp <= 0) { p.hp = 10; p.z = 0; [m.x, m.y] = respawnPoint(id); }
          send(ws, { t: 'hp', hp: p.hp, x: m.x, y: m.y });
          send(ws, { t: 'msg', s: '💥 You fell hard!' });
        }
      }
      p.x = m.x; p.y = m.y; p.z = m.z | 0;
      p.b = m.b | 0;
      // track last land position for boat-wreck recovery
      if (world.tiles[ti(p.x, p.y)] !== T.WATER) { p.lastLandX = p.x; p.lastLandY = p.y; }
      bcast({ t: 'pos', id, x: m.x, y: m.y, z: p.z, b: p.b });
      // sailing hazards: icebergs and scalding water. Losing the boat leaves the
      // player swimming in place — no teleport.
      const b = p.b;
      const wreckBoat = (reason) => {
        if (p.inv.boat > 0) p.inv.boat--;
        p.hp = Math.max(1, p.hp - 2);
        p.b = 0;
        send(ws, { t: 'boat', r: reason });
        send(ws, { t: 'hp', hp: p.hp });
        sendInv(id, p);
      };
      if (b === 1 && world.waterTemp[ti(p.x, p.y)] === 2) {
        wreckBoat('burn');                             // wooden hulls ignite in the Core's scalding sea
      } else if (b) {
        outer: for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const bi = ti(p.x + dx, p.y + dy);
            if (!world.bergs.has(bi) || brokenBergs.has(bi)) continue;
            if (b === 2) {                             // reinforced hull smashes through
              brokenBergs.add(bi);
              bcast({ t: 'berg', i: bi, pid: id });
            } else {                                   // wooden boat shatters
              wreckBoat('berg');
              break outer;
            }
          }
      }
    }

    else if (m.t === 'furn') {
      const kind = m.kind, i = m.i;
      if (p.z !== 2 || !['chest', 'bed', 'torch'].includes(kind) || !p.inv[kind] || furn.has(i)) return;
      const x = i % SIZE, y = (i / SIZE) | 0;
      let room = false;   // tile must be inside a shelter's interior (Chebyshev ≤ its level)
      for (const [si, s] of structures)
        if (s.kind === 'shelter' && Math.max(Math.abs((si % SIZE) - x), Math.abs(((si / SIZE) | 0) - y)) <= (s.lvl || 1)) { room = true; break; }
      if (!room || Math.hypot(x - p.x, y - p.y) > 5) return;
      p.inv[kind]--;
      furn.set(i, { kind, owner: id });
      bcast({ t: 'furn', i, kind });
      sendInv(id, p);
      if (kind === 'bed') send(ws, { t: 'msg', s: '🛏 You will now respawn at your bed.' });
    }

    else if (m.t === 'torch') {
      if (p.z !== 1 || p.inv.torch < 1) return;
      const i = ti(p.x, p.y);
      if (!digs.has(i) || torches.has(i)) return;
      p.inv.torch--;
      torches.add(i);
      bcast({ t: 'torch', i });
      sendInv(id, p);
    }

    else if (m.t === 'dig') {
      if (now - p.lastGather < 250 || p.z !== 1) return;
      p.lastGather = now;
      const i = m.i;
      if (digs.has(i) || !DIGGABLE(world, i)) return;
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 2) return;
      if (!p.tools.has('pick') && !p.tools.has('spick'))
        return send(ws, { t: 'msg', s: 'You need a Pickaxe to dig.' });
      digs.add(i);
      const v = world.veins[i];
      let got = '';
      if (v === 1) { const n = 2 + (Math.random() < 0.5 ? 1 : 0); p.inv.iron += n; got = `+${n} Iron!`; }
      else if (v === 2) { const n = 1 + (Math.random() < 0.3 ? 1 : 0); p.inv.diamond += n; got = `+${n} 🔷 DIAMOND!`; }
      else if (Math.random() < 0.25) { p.inv.stone += 1; got = '+1 Stone'; }
      bcast({ t: 'dig', tiles: [i] });
      sendInv(id, p);
      if (got) send(ws, { t: 'msg', s: got });
    }

    else if (m.t === 'anim') bcast({ t: 'anim', id, a: m.a });

    else if (m.t === 'eq') {
      if (m.k !== null && !p.tools.has(m.k)) return;
      p.equip = m.k;
      bcast({ t: 'eq', id, k: m.k });
    }

    else if (m.t === 'wear') {
      const k = m.k === null ? null : String(m.k);
      if (k !== null && !['heatcloak', 'furcloak'].includes(k)) return;
      if (k !== null && !p.gear.has(k)) return;
      p.wornGear = p.wornGear === k ? null : k;
      sendInv(id, p);
      send(ws, { t: 'msg', s: p.wornGear ? 'You wrap yourself in the ' + NAMES[p.wornGear] + '.' : 'You remove your cloak.' });
    }

    else if (m.t === 'gather') {
      if (now - p.lastGather < 250) return;
      p.lastGather = now;
      const i = m.i;
      if (!world.nodes.has(i) || removed.has(i)) return;
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 2.5) return;
      const def = NODE_DEF[world.nodes.get(i)];
      if (def.tool === 'pick' && !p.tools.has('pick') && !p.tools.has('spick'))
        return send(ws, { t: 'msg', s: 'You need a Pickaxe for this.' });
      if (def.tool === 'spick' && !p.tools.has('spick'))
        return send(ws, { t: 'msg', s: 'You need a Stone Pickaxe for this.' });
      let dmg = 1;
      if (def.axeBonus && p.tools.has('axe')) dmg = 3;
      if (def.tool === 'pick' && p.tools.has('spick')) dmg = 2;
      const hp = (nodeHp.get(i) ?? def.hp) - dmg;
      if (hp > 0) { nodeHp.set(i, hp); bcast({ t: 'node', i, hp }); return; }
      nodeHp.delete(i);
      removed.set(i, now + def.respawn * 1000);
      p.inv[def.res] += def.n;
      bcast({ t: 'node', i, hp: 0 });
      sendInv(id, p);
      if (world.nodes.get(i) === 0) {   // tree: ecosystem reaction
        const sk = ((x >> 4) << 8) | (y >> 4);
        sectorChops[sk] = (sectorChops[sk] || 0) + 1;
        if (sectorChops[sk] % 8 === 0) {
          const newMud = [], bx = (x >> 4) << 4, by = (y >> 4) << 4;
          for (let n = 0; n < 40 && newMud.length < 14; n++) {
            const mi = ti(bx + Math.random() * 16, by + Math.random() * 16);
            if (world.tiles[mi] === T.GRASS && !mudTiles.has(mi) && !world.nodes.has(mi)) { mudTiles.add(mi); newMud.push(mi); }
          }
          if (newMud.length) bcast({ t: 'mud', tiles: newMud });
        }
      }
    }

    else if (m.t === 'craft') {
      const r = RECIPES[m.r];
      if (!r || !canAfford(p.inv, r.cost)) return;
      if (r.station && !nearStruct(p, r.station))
        return send(ws, { t: 'msg', s: `You must stand near a ${r.station} to craft this.` });
      pay(p.inv, r.cost);
      if (r.tool) p.tools.add(m.r);
      else if (r.gear) p.gear.add(m.r);
      else p.inv[m.r] = (p.inv[m.r] || 0) + 1;
      sendInv(id, p);
    }

    else if (m.t === 'build') {
      const kind = m.kind, i = m.i;
      if (!STRUCT_HP[kind] || !p.inv[kind]) return;
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 6) return;
      const existing = structures.get(i);
      if (existing) {                 // stack: walls to 2, shelters to 3 stories
        const maxLvl = kind === 'wall' ? 2 : kind === 'shelter' ? 3 : 0;
        if (kind !== existing.kind || (existing.lvl || 1) >= maxLvl) return;
        p.inv[kind]--;
        existing.lvl = (existing.lvl || 1) + 1;
        existing.hp += STRUCT_HP[kind];
        bcast({ t: 'build', i, kind, hp: existing.hp, dir: existing.dir || 0, lvl: existing.lvl });
        sendInv(id, p);
        return;
      }
      if (blocked(x, y) || world.nodes.has(i) && !removed.has(i)) return;
      if (kind === 'mineshaft' && !DIGGABLE(world, i))
        return send(ws, { t: 'msg', s: 'Mines can only be dug in the Woods, Dunes or Spire.' });
      if (kind === 'engine' && i !== ACTIVATION_I)
        return send(ws, { t: 'msg', s: 'The World Engine must be built on the activation dais at the temple heart.' });
      if (kind === 'engine' && !mono.every(Boolean))
        return send(ws, { t: 'msg', s: 'All 4 Monoliths must be awakened first.' });
      p.inv[kind]--;
      const dir = m.dir ? 1 : 0;
      structures.set(i, { kind, hp: STRUCT_HP[kind], owner: id, dir, lvl: 1 });
      bcast({ t: 'build', i, kind, hp: STRUCT_HP[kind], dir, lvl: 1 });
      sendInv(id, p);
      if (kind === 'engine') {
        wave = { until: Date.now() + 4 * 60 * 1000, engineI: i };
        bcast({ t: 'wave', secs: 240 });
      }
      if (kind === 'mineshaft') {     // carve the starting chamber below the entrance
        const opened = [];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const di = ti(x + dx, y + dy);
            if (DIGGABLE(world, di) && !digs.has(di)) { digs.add(di); opened.push(di); }
          }
        if (opened.length) bcast({ t: 'dig', tiles: opened });
      }
    }

    else if (m.t === 'usecore') {
      const i = m.i;
      if (i < 0 || i > 3 || mono[i] || p.inv.core < 1) return;
      const [mx, my] = MONOLITHS[i];
      if (Math.hypot(mx - p.x, my - p.y) > 3) return;
      p.inv.core--; mono[i] = true;
      bcast({ t: 'mono', i });
      sendInv(id, p);
    }

    else if (m.t === 'atk') {
      if (now - p.lastAtk < 400) return;
      if (p.z !== 0) return;          // nothing to strike underground/indoors — protects structures
      p.lastAtk = now;
      const dmg = p.equip === 'isword' ? 5 : p.equip === 'sword' ? 3 : p.equip === 'axe' ? 2 : 1;
      let best = null, bid = null, bd = 2.4, isAnimal = false;
      for (const [cid, c] of creatures) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < bd) { bd = d; best = c; bid = cid; isAnimal = false; }
      }
      for (const [aid, a] of animals) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d < bd) { bd = d; best = a; bid = aid; isAnimal = true; }
      }
      if (!best) {
        // no creature in range: strike a structure to demolish it (half materials refunded)
        let bsi = -1, bsd = 2.4;
        for (const [si, s] of structures) {
          const d = Math.hypot((si % SIZE) - p.x, ((si / SIZE) | 0) - p.y);
          if (d < bsd) { bsd = d; bsi = si; }
        }
        if (bsi < 0) return;
        const s = structures.get(bsi);
        s.hp -= dmg * 2;                         // demolition is quick work
        if (s.hp <= 0) {
          structures.delete(bsi);
          const mult = s.kind === 'wall' ? (s.lvl || 1) : 1;
          const back = [];
          for (const [k, v] of Object.entries(RECIPES[s.kind]?.cost || {})) {
            const n = Math.floor(v / 2) * mult;
            if (n) { p.inv[k] += n; back.push(`${n} ${k}`); }
          }
          bcast({ t: 'sd', i: bsi, hp: 0 });
          sendInv(id, p);
          send(ws, { t: 'msg', s: `Demolished ${s.kind}${back.length ? ' — recovered ' + back.join(', ') : ''}` });
          if (wave && bsi === wave.engineI) { wave = null; bcast({ t: 'msg', s: 'You destroyed your own World Engine!' }); }
        } else bcast({ t: 'sd', i: bsi, hp: s.hp });
        return;
      }
      best.hp -= dmg;
      if (best.hp <= 0) {
        if (isAnimal) {
          animals.delete(bid);
          const drop = ANIMAL_TYPES[best.type][4] + (Math.random() < 0.4 ? 1 : 0);
          p.inv.meat += drop;
          send(ws, { t: 'msg', s: `+${drop} Raw Meat — cook it at a campfire` });
        } else {
          creatures.delete(bid);
          const drop = (best.type === 'brute' ? 4 : best.type === 'wisp' ? 3 : 1) + (Math.random() < 0.4 ? 1 : 0);
          p.inv.essence += drop;
          send(ws, { t: 'msg', s: `+${drop} Blight Essence` });
        }
        sendInv(id, p);
      } else bcast({ t: 'chit', id: bid });
    }

    else if (m.t === 'water') {
      if (now - p.lastGather < 250) return;
      p.lastGather = now;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (world.tiles[ti(p.x + dx, p.y + dy)] === T.WATER) { near = true; break; }
      if (!near) return;
      if (p.inv.water >= 10) return send(ws, { t: 'msg', s: 'You cannot carry more water.' });
      p.inv.water++;
      sendInv(id, p);
    }

    else if (m.t === 'use') {
      if (m.k === 'water' && p.inv.water > 0) {
        p.inv.water--; p.thirst = Math.min(10, p.thirst + 4);
      } else if (m.k === 'cookedmeat' && p.inv.cookedmeat > 0) {
        p.inv.cookedmeat--; p.hunger = Math.min(10, p.hunger + 5);
      } else return;
      sendInv(id, p);
      send(ws, { t: 'stat', hunger: Math.ceil(p.hunger), thirst: Math.ceil(p.thirst) });
    }
  });

  ws.on('close', () => {
    if (p && p.tok) profiles[p.tok] = snapshot(p);
    players.delete(id);
    bcast({ t: 'pl', id });
  });
});

// --- sim tick TICK_MS ---
setInterval(() => {
  tickN++;
  const prev = time;
  time = (time + (TICK_MS / 1000) / DAY_LENGTH_SEC) % 1;
  if (time < prev) { day++; bcast({ t: 'msg', s: `Day ${day} dawns over The Hearth.` }); }

  // node respawns
  if (tickN % 25 === 0) {
    const now = Date.now();
    for (const [i, at] of removed)
      if (now > at) { removed.delete(i); bcast({ t: 'node', i, hp: -1 }); }
  }

  // weather events: rain (Woods/Marsh), sandstorm (Dunes), snowstorm (Spire)
  const nowMs = Date.now();
  if (weather.kind && nowMs > weather.until) { weather.kind = null; bcast({ t: 'wx', kind: null }); }
  else if (!weather.kind && Math.random() < (TICK_MS / 1000) / 180) {   // ~every 180s on average
    weather.kind = ['rain', 'sandstorm', 'snowstorm'][(Math.random() * 3) | 0];
    weather.until = nowMs + (45 + Math.random() * 45) * 1000;
    bcast({ t: 'wx', kind: weather.kind });
  }

  // infection spread by wisps decays over time
  if (tickN % 25 === 0) {
    const cured = [];
    for (const [i, at] of infected) if (nowMs > at) { infected.delete(i); cured.push(i); }
    if (cured.length) bcast({ t: 'cure', tiles: cured });
  }

  // monsters: crawlers always; stalkers at night; brutes once 2+ monoliths; rare wisps that infect land
  const strength = 1 + mono.filter(Boolean).length;
  const cap = won ? 0 : wave ? 20 : (isNight() ? 6 + 3 * strength : 2 + strength);
  if (creatures.size < cap && players.size > 0 && tickN % 3 === 0) {
    const roll = Math.random();
    let type = 'crawler';
    const wisps = [...creatures.values()].filter((c) => c.type === 'wisp').length;
    if (roll > 0.97 && wisps < 2) type = 'wisp';
    else if (strength >= 3 && roll > 0.85) type = 'brute';
    else if (isNight() && roll < 0.3) type = 'stalker';
    const a = Math.random() * Math.PI * 2, r = Math.random() * 13;
    let sx = CORE[0] + Math.cos(a) * r, sy = CORE[1] + Math.sin(a) * r, ok = true;
    if (infected.size && roll < 0.25) {              // corruption breeds crawlers far from the core
      const keys = [...infected.keys()];
      const fi = keys[(Math.random() * keys.length) | 0];
      sx = fi % SIZE; sy = (fi / SIZE) | 0; type = 'crawler';
    } else if (isNight() && roll < 0.55) {           // islands are distant: night horrors rise near players
      const qs = [...players.values()].filter((q) => q.z === 0);
      if (qs.length) {
        const q = qs[(Math.random() * qs.length) | 0];
        sx = Math.round(q.x + (Math.random() - 0.5) * 36);
        sy = Math.round(q.y + (Math.random() - 0.5) * 36);
        ok = sx >= 0 && sy >= 0 && sx < SIZE && sy < SIZE &&
          world.tiles[ti(sx, sy)] !== T.WATER && Math.hypot(sx - q.x, sy - q.y) > 9;
      }
    }
    const [hb, hs] = CRE_TYPES[type];
    if (ok) creatures.set('c' + nextCre++, { x: sx, y: sy, hp: hb + hs * strength, type });
  }
  for (const c of creatures.values()) {
    const [, , baseSp, cdmg] = CRE_TYPES[c.type || 'crawler'];
    let tx, ty;
    if (c.type === 'wisp') {                          // drifts, corrupting the land
      c.tw = (c.tw || 0) - 1;
      if (c.tw <= 0) { const ang = Math.random() * Math.PI * 2; c.dx = Math.cos(ang); c.dy = Math.sin(ang); c.tw = 20 + Math.random() * 30; }
      const nx = c.x + c.dx * baseSp, ny = c.y + c.dy * baseSp;
      if (nx > 1 && ny > 1 && nx < SIZE - 1 && ny < SIZE - 1) { c.x = nx; c.y = ny; }
      if (tickN % 25 === 0) {
        const i = ti(c.x, c.y);
        if (world.tiles[i] !== T.WATER && world.tiles[i] !== T.BLIGHT && !infected.has(i) && !structures.has(i)) {
          infected.set(i, nowMs + 120000);
          bcast({ t: 'infect', tiles: [i] });
        }
      }
      continue;
    }
    if (wave) { tx = wave.engineI % SIZE; ty = (wave.engineI / SIZE) | 0; }
    else if (c.type === 'brute') {                    // siege beast: prefers structures
      let bd = 45;
      for (const [si] of structures) {
        const d = Math.hypot((si % SIZE) - c.x, ((si / SIZE) | 0) - c.y);
        if (d < bd) { bd = d; tx = si % SIZE; ty = (si / SIZE) | 0; }
      }
      if (tx === undefined) for (const q of players.values()) {
        const d = Math.hypot(q.x - c.x, q.y - c.y);
        if (d < bd) { bd = d; tx = q.x; ty = q.y; }
      }
    } else {
      let bd = 26;
      for (const q of players.values()) {
        if (q.z !== 0) continue;      // underground/indoor players are hidden from surface hunters
        // scent: carrying essence or raw meat attracts hunters from farther away
        const rad = q.inv.essence > 0 || q.inv.meat > 0 ? 40 : 26;
        const d = Math.hypot(q.x - c.x, q.y - c.y);
        if (d < Math.min(bd, rad)) { bd = d; tx = q.x; ty = q.y; }
      }
    }
    if (tx === undefined) continue;
    const d = Math.hypot(tx - c.x, ty - c.y) || 0.001;
    const sp = Math.min(baseSp + strength * 0.03, d);
    const nx = c.x + ((tx - c.x) / d) * sp, ny = c.y + ((ty - c.y) / d) * sp;
    const si = ti(nx, ny);
    const s = structures.get(si);
    if (s && d > 1.2) {                               // structure in the way: attack it
      if (tickN % 5 === 0) {
        s.hp -= c.type === 'brute' ? 3 : 1;
        if (s.hp <= 0) {
          structures.delete(si);
          bcast({ t: 'sd', i: si, hp: 0 });
          if (wave && si === wave.engineI) { wave = null; bcast({ t: 'msg', s: 'THE WORLD ENGINE WAS DESTROYED! Rebuild it to try again.' }); }
        } else bcast({ t: 'sd', i: si, hp: s.hp });
      }
    } else { c.x = nx; c.y = ny; }
    // contact damage
    if (tickN % 5 === 0 && cdmg) {
      for (const [pid, q] of players) {
        if (q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 1.1) {
          q.hp -= cdmg;
          if (q.hp <= 0) { q.hp = 10; q.z = 0; [q.x, q.y] = respawnPoint(pid); }
          send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y });
        }
      }
    }
  }

  // wildlife: one species per biome — deer/Woods, lizard/Dunes, fox/Spire, toad/Marsh.
  // Spawns biased near players so wildlife is actually encountered.
  if (animals.size < 20 && tickN % 5 === 0 && players.size > 0) {
    const types = Object.keys(ANIMAL_TYPES);
    for (let n = 0; n < 3; n++) {
      const type = types[(Math.random() * types.length) | 0];
      const [home, qx, qy, hp] = ANIMAL_TYPES[type];
      let x, y;
      if (Math.random() < 0.6) {
        const qs = [...players.values()];
        const q = qs[(Math.random() * qs.length) | 0];
        x = Math.round(q.x + (Math.random() - 0.5) * 36);
        y = Math.round(q.y + (Math.random() - 0.5) * 36);
        if (Math.hypot(x - q.x, y - q.y) < 7) continue;   // not on top of the player
      } else {
        x = qx + ((Math.random() * 60) | 0); y = qy + ((Math.random() * 60) | 0);
      }
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const i = ti(x, y);
      if (world.tiles[i] === home && !world.nodes.has(i) && !structures.has(i)) {
        animals.set('a' + nextAni++, { x, y, hp, dx: 0, dy: 0, tw: 0, type, home });
        break;
      }
    }
  }
  for (const a of animals.values()) {
    let fleeing = false;
    const [, , , , , fleeR, fleeSp] = ANIMAL_TYPES[a.type];
    for (const q of players.values()) {
      const d = Math.hypot(q.x - a.x, q.y - a.y);
      if (d < fleeR && d > 0.1) { a.dx = (a.x - q.x) / d; a.dy = (a.y - q.y) / d; fleeing = true; break; }
    }
    if (!fleeing && --a.tw <= 0) {
      a.tw = 10 + Math.random() * 25;
      if (Math.random() < 0.4) { a.dx = 0; a.dy = 0; }
      else { const ang = Math.random() * Math.PI * 2; a.dx = Math.cos(ang); a.dy = Math.sin(ang); }
    }
    const sp = fleeing ? fleeSp : 0.1;
    const nx = a.x + a.dx * sp, ny = a.y + a.dy * sp;
    if (!blocked(nx, ny) && world.tiles[ti(nx, ny)] === a.home) { a.x = nx; a.y = ny; }
    else { a.dx = -a.dx; a.dy = -a.dy; }
  }

  // environmental damage, hunger/thirst, campfire regen (every 5s)
  if (tickN % 25 === 0) {
    for (const [pid, q] of players) {
      q.hunger = Math.max(0, q.hunger - 0.055);   // empty in ~15 min
      q.thirst = Math.max(0, q.thirst - 0.083);   // empty in ~10 min
      send(q.ws, { t: 'stat', hunger: Math.ceil(q.hunger), thirst: Math.ceil(q.thirst) });
      const t = world.tiles[ti(q.x, q.y)];
      // Thermal water damage (BEFORE weather checks) — boats protect
      if (t === T.WATER && q.z === 0 && !q.b) {
        const wt = world.waterTemp[ti(q.x, q.y)];
        if (wt > 0) {
          q.thermN = (q.thermN || 0) + 1;
          const protected_ = (wt === 1 && q.wornGear === 'furcloak') || (wt === 2 && q.wornGear === 'heatcloak');
          if (!protected_ || (protected_ && q.thermN % 2 === 0)) {
            q.hp -= 1;
            const msg = wt === 1 ? 'The freezing water saps your life!' : 'The scalding water burns!';
            send(q.ws, { t: 'msg', s: msg });
            if (q.hp <= 0) { q.hp = 10; q.z = 0; q.hunger = 10; q.thirst = 10; q.thermN = 0; [q.x, q.y] = respawnPoint(pid); }
            send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y });
          }
        } else { q.thermN = 0; }
      } else { q.thermN = 0; }
      let delta = 0;
      if (q.z !== 0) { /* underground or indoors: sheltered from weather */ }
      else if (weather.kind === 'sandstorm' && t === T.SAND && !nearAnyStruct(q, 2)) { delta = -1; send(q.ws, { t: 'msg', s: 'The sandstorm flays you — shelter beside a structure!' }); }
      else if (weather.kind === 'snowstorm' && t === T.SNOW && !nearStruct(q, 'campfire', 6)) { delta = -1; send(q.ws, { t: 'msg', s: 'The blizzard freezes you — get to a campfire!' }); }
      else if (t === T.SAND && !isNight() && q.wornGear !== 'heatcloak') { delta = -1; send(q.ws, { t: 'msg', s: 'The desert heat sears you! Craft a Heat Cloak.' }); }
      else if (t === T.SNOW && q.wornGear !== 'furcloak') { delta = -1; send(q.ws, { t: 'msg', s: 'The glacial cold bites! Craft a Fur Cloak.' }); }
      else if (q.hunger <= 0 || q.thirst <= 0) { delta = -1; send(q.ws, { t: 'msg', s: q.thirst <= 0 ? 'You are dying of thirst!' : 'You are starving!' }); }
      else if (q.hp < 10 && nearStruct(q, 'campfire', 4)) delta = 1;
      if (delta) {
        q.hp = Math.min(10, q.hp + delta);
        if (q.hp <= 0) { q.hp = 10; q.z = 0; q.hunger = 10; q.thirst = 10; [q.x, q.y] = respawnPoint(pid); }
        send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y });
      }
    }
  }

  // Blight Storm erosion: wooden structures decay at night unless near a campfire (every 20s)
  if (tickN % 100 === 0 && isNight() && !won) {
    for (const [i, s] of structures) {
      if (!WOODEN.has(s.kind)) continue;
      const x = i % SIZE, y = (i / SIZE) | 0;
      let safe = false;
      for (const [j, s2] of structures)
        if (s2.kind === 'campfire' && Math.hypot((j % SIZE) - x, ((j / SIZE) | 0) - y) <= 6) { safe = true; break; }
      if (!safe) {
        s.hp--;
        if (s.hp <= 0) { structures.delete(i); bcast({ t: 'sd', i, hp: 0 }); }
        else bcast({ t: 'sd', i, hp: s.hp });
      }
    }
  }

  // wave victory
  if (wave && Date.now() > wave.until) {
    wave = null; won = true;
    bcast({ t: 'win' });
  }

  bcast({
    t: 'cre',
    c: [...creatures].map(([cid, c]) => [cid, +c.x.toFixed(2), +c.y.toFixed(2), c.type || 'crawler']),
    a: [...animals].map(([aid, a]) => [aid, +a.x.toFixed(2), +a.y.toFixed(2), a.type]),
    time: +time.toFixed(4), day
  });
}, TICK_MS);
