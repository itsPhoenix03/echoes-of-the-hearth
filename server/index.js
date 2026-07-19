// Echoes of the Hearth — authoritative co-op survival server.
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { genWorld, findSpawn, nearestLand, SIZE, T, MONOLITHS, CORE, DIGGABLE, WORLD_VERSION, ACTIVATION_I, ISLES } from '../shared/world.js';
import { NODE_DEF, RECIPES, STRUCT_HP, WOODEN, NAMES, canAfford, pay, emptyInv, DECOR_NONBLOCKING, CROPS } from '../shared/defs.js';
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
const farms = new Map();             // i -> {crop, plantedTick, owner}
const chestInv = new Map();          // i -> {res:count}
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
const CRE_TYPES = {
  crawler:      [1, 1, 0.44,  1],
  stalker:      [2, 1, 0.68,  1],
  brute:        [6, 3, 0.3,   2],
  wisp:         [3, 0, 0.2,   0],
  husk_wolf:    [3, 1, 0.62,  1],
  bog_shambler: [8, 2, 0.22,  2],
  frost_wraith: [2, 1, 0.5,   1],
};
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
    for (const [i, st] of s.structures) {
      if (!RECIPES[st.kind] && !STRUCT_HP[st.kind]) continue;  // unknown kind guard
      structures.set(i, st);
    }
    s.digs.forEach((i) => digs.add(i));
    s.torches.forEach((i) => torches.add(i));
    for (const [i, f] of s.furn || []) furn.set(i, f);
    (s.brokenBergs || []).forEach((i) => brokenBergs.add(i));
    for (const [i, fm] of s.farms || []) farms.set(i, fm);
    for (const [i, ci] of s.chestInv || []) chestInv.set(i, ci);
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
    furn: [...furn], brokenBergs: [...brokenBergs],
    farms: [...farms], chestInv: [...chestInv], profiles
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
const GROW_DIV = process.env.DEV ? 30 : 1;
const blocked = (x, y) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return true;
  if (world.tiles[ti(x, y)] === T.WATER) return true;
  const s = structures.get(ti(x, y));
  if (!s) return false;
  // non-blocking decor and farmplots do not obstruct movement
  if (DECOR_NONBLOCKING.has(s.kind) || s.kind === 'farmplot') return false;
  return true;
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
        furn: [...furn].map(([i, f]) => [i, f.kind, f.z ?? 2]),
        removed: [...removed.keys()], mud: [...mudTiles],
        structures: [...structures].map(([i, s]) => [i, s.kind, s.hp, s.dir || 0, s.lvl || 1]),
        farms: [...farms].map(([i, fm]) => {
          const crop = CROPS[fm.crop];
          if (!crop) return null;
          const growTicks = (crop.growTicks / GROW_DIV) | 0;
          const stage = Math.min(2, Math.floor(3 * (tickN - fm.plantedTick) / growTicks));
          return [i, fm.crop, Math.max(0, stage)];
        }).filter(Boolean),
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
      const r = RECIPES[kind];
      // allowed: explicit furniture set OR decor with zone 'in' or 'both'
      const isFurni = ['chest', 'bed', 'torch'].includes(kind) || (r && r.decor && (r.zone === 'in' || r.zone === 'both'));
      if (!isFurni || !p.inv[kind] || furn.has(i)) return;
      if (r && r.zone === 'out') return;  // extra safety: zone:out decor never inside
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (p.z === 2) {
        // SHELTER interior: Chebyshev <= lvl + 2 (FIX 1 + FEATURE 1 room expansion)
        let room = false;
        for (const [si, s] of structures)
          if (s.kind === 'shelter' && Math.max(Math.abs((si % SIZE) - x), Math.abs(((si / SIZE) | 0) - y)) <= (s.lvl || 1) + 2) { room = true; break; }
        if (!room || Math.hypot(x - p.x, y - p.y) > 5) return;
      } else if (p.z === 1) {
        // FEATURE 2: furniture in mines — tile must be dug, no torch check (torches use own flow)
        if (!digs.has(i)) return;
        if (kind === 'torch') return;   // torches in mines use the 'torch' message
        if (Math.hypot(x - p.x, y - p.y) > 5) return;
      } else {
        return;   // z===0: furn not allowed
      }
      p.inv[kind]--;
      furn.set(i, { kind, owner: id, z: p.z });   // remember WHICH layer it lives on
      if (kind === 'chest' && !chestInv.has(i)) chestInv.set(i, {});
      bcast({ t: 'furn', i, kind, z: p.z });
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
      const r = RECIPES[kind];
      // zone enforcement: zone:'in' decor cannot be built outdoors (furn path handles them)
      if (r && r.zone === 'in') return;
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
      // for non-blocking decor and farmplot: allow placement on occupied tile (just no water/existing blocking struct)
      const isNonBlock = DECOR_NONBLOCKING.has(kind) || kind === 'farmplot';
      if (isNonBlock) {
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
        if (world.tiles[ti(x, y)] === T.WATER) return;
        // can coexist with non-blocking, but not with blocking structures
        if (existing && !DECOR_NONBLOCKING.has(existing.kind) && existing.kind !== 'farmplot') return;
      } else {
        if (blocked(x, y) || (world.nodes.has(i) && !removed.has(i))) return;
      }
      if (kind === 'mineshaft' && !DIGGABLE(world, i))
        return send(ws, { t: 'msg', s: 'Mines can only be dug in the Woods, Dunes or Spire.' });
      if (kind === 'shelter')                     // rooms are (lvl+2)-radius: keep them from overlapping
        for (const [si, s2] of structures)
          if (s2.kind === 'shelter' && Math.max(Math.abs((si % SIZE) - x), Math.abs(((si / SIZE) | 0) - y)) <= 10)
            return send(ws, { t: 'msg', s: 'Too close to another shelter — their rooms would overlap.' });
      if (kind === 'engine' && i !== ACTIVATION_I)
        return send(ws, { t: 'msg', s: 'The World Engine must be built on the activation dais at the temple heart.' });
      if (kind === 'engine' && !mono.every(Boolean))
        return send(ws, { t: 'msg', s: 'All 4 Monoliths must be awakened first.' });
      p.inv[kind]--;
      const dir = m.dir ? 1 : 0;
      structures.set(i, { kind, hp: STRUCT_HP[kind], owner: id, dir, lvl: 1 });
      bcast({ t: 'build', i, kind, hp: STRUCT_HP[kind], dir, lvl: 1 });
      // farmplot: create empty chest inv stub not needed, but if chest placed, init chestInv
      if (kind === 'chest') chestInv.set(i, {});
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

    else if (m.t === 'plant') {
      const i = m.i, cropName = m.crop;
      const cropDef = CROPS[cropName];
      if (!cropDef) return;
      const s = structures.get(i);
      if (!s || s.kind !== 'farmplot') return send(ws, { t: 'msg', s: 'No farm plot here.' });
      if (farms.has(i)) return send(ws, { t: 'msg', s: 'Something is already growing here.' });
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 2.5) return;
      if (!canAfford(p.inv, cropDef.seedCost)) return send(ws, { t: 'msg', s: 'Not enough seeds.' });
      pay(p.inv, cropDef.seedCost);
      farms.set(i, { crop: cropName, plantedTick: tickN, owner: id });
      bcast({ t: 'crop', i, crop: cropName, stage: 0 });
      sendInv(id, p);
    }

    else if (m.t === 'harvest') {
      const i = m.i;
      const fm = farms.get(i);
      if (!fm) return send(ws, { t: 'msg', s: 'Nothing to harvest here.' });
      const cropDef = CROPS[fm.crop];
      if (!cropDef) return;
      const growTicks = (cropDef.growTicks / GROW_DIV) | 0;
      const stage = Math.min(2, Math.floor(3 * (tickN - fm.plantedTick) / growTicks));
      if (stage < 2) return send(ws, { t: 'msg', s: `Not ready yet (${Math.floor(100 * (tickN - fm.plantedTick) / growTicks)}%).` });
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 2.5) return;
      for (const [res, amt] of Object.entries(cropDef.yield)) p.inv[res] = (p.inv[res] || 0) + amt;
      farms.delete(i);
      bcast({ t: 'crop', i, crop: null, stage: 0 });
      sendInv(id, p);
      send(ws, { t: 'msg', s: `Harvested ${fm.crop}! +${Object.entries(cropDef.yield).map(([k,v])=>`${v} ${k}`).join(', ')}` });
    }

    else if (m.t === 'chest_open') {
      const i = m.i;
      const f = furn.get(i);
      if (!f || f.kind !== 'chest') return;
      if ((f.z ?? 2) !== p.z) return;   // a chest is only reachable from the layer it was placed on
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 2.5) return;
      if (!chestInv.has(i)) chestInv.set(i, {});
      send(ws, { t: 'chest', i, slots: chestInv.get(i) });
    }

    else if (m.t === 'chest_move') {
      const i = m.i, res = m.res, n = m.n | 0;
      if (!n) return;
      const f = furn.get(i);
      if (!f || f.kind !== 'chest') return;
      if ((f.z ?? 2) !== p.z) return;   // same layer gate as chest_open
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (Math.hypot(x - p.x, y - p.y) > 2.5) return;
      if (!['wood','stone','fiber','crystal','essence','iron','diamond','starmetal'].includes(res)) return;
      if (!chestInv.has(i)) chestInv.set(i, {});
      const slot = chestInv.get(i);
      if (n > 0) {
        // deposit: clamp to what player has
        const actual = Math.min(n, p.inv[res] || 0);
        if (actual <= 0) return;
        p.inv[res] -= actual;
        slot[res] = (slot[res] || 0) + actual;
      } else {
        // withdraw: clamp to what chest has
        const actual = Math.min(-n, slot[res] || 0);
        if (actual <= 0) return;
        slot[res] = (slot[res] || 0) - actual;
        if (slot[res] <= 0) delete slot[res];
        p.inv[res] = (p.inv[res] || 0) + actual;
      }
      bcast({ t: 'chest', i, slots: slot });
      sendInv(id, p);
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
      const atkAng = Math.atan2(best.y - p.y, best.x - p.x);  // away from attacker (Guide §2.1)
      best.hp -= dmg;
      if (best.hp <= 0) {
        if (isAnimal) {
          animals.delete(bid);
          const drop = ANIMAL_TYPES[best.type][4] + (Math.random() < 0.4 ? 1 : 0);
          p.inv.meat += drop;
          send(ws, { t: 'msg', s: `+${drop} Raw Meat — cook it at a campfire` });
        } else {
          // wisp on-death: corrupt tile (Guide §3.6 variant — also on death)
          if (best.type === 'wisp' || best.type === 'frost_wraith') {
            const di = ti(best.x, best.y);
            if (world.tiles[di] !== T.WATER && !infected.has(di)) {
              infected.set(di, now + 120000);
              bcast({ t: 'infect', tiles: [di] });
            }
          }
          // bog_shambler on-death: corrupt own tile + 4 neighbors (Guide §4.2 / substitutions)
          if (best.type === 'bog_shambler') {
            const bsx = best.x | 0, bsy = best.y | 0;
            const toCorrupt = [[0,0],[1,0],[-1,0],[0,1],[0,-1]];
            const corrupted = [];
            for (const [ddx, ddy] of toCorrupt) {
              const ci = ti(bsx + ddx, bsy + ddy);
              if (ci >= 0 && ci < SIZE * SIZE && world.tiles[ci] !== T.WATER && !infected.has(ci)) {
                infected.set(ci, now + 120000); corrupted.push(ci);
              }
            }
            if (corrupted.length) bcast({ t: 'infect', tiles: corrupted });
          }
          creatures.delete(bid);
          // husk_wolf drops meat (Guide §4.1 / substitutions)
          if (best.type === 'husk_wolf') {
            p.inv.meat += 1;
            send(ws, { t: 'msg', s: '+1 Raw Meat' });
          } else {
            const drop = (best.type === 'brute' || best.type === 'bog_shambler' ? 4 : best.type === 'wisp' || best.type === 'frost_wraith' ? 3 : 1) + (Math.random() < 0.4 ? 1 : 0);
            p.inv.essence += drop;
            send(ws, { t: 'msg', s: `+${drop} Blight Essence` });
          }
          // pack enrage: on crawler/wolf hit, enrage nearby crawlers (Guide §3.5)
          if (best.type === 'crawler' || best.type === 'husk_wolf') {
            for (const [, ec] of creatures) {
              if ((ec.type === 'crawler' || ec.type === 'husk_wolf') && Math.hypot(ec.x - best.x, ec.y - best.y) <= 10)
                ec.enraged = 100;
            }
          }
        }
        sendInv(id, p);
      } else {
        // surviving hit: knockback + stun (Guide §2.2)
        const KB = (best.type === 'brute' || best.type === 'bog_shambler') ? 0.3 : 0.9;
        const knx = best.x + Math.cos(atkAng) * KB, kny = best.y + Math.sin(atkAng) * KB;
        const kni = ti(knx, kny);
        if (kni >= 0 && kni < SIZE * SIZE && world.tiles[kni] !== T.WATER && !structures.has(kni))
          { best.x = knx; best.y = kny; }
        best.stun = 3;
        // wisp on-hit flee + corrupt (Guide §3.6)
        if (best.type === 'wisp' || best.type === 'frost_wraith') {
          best.fleeTicks = 10;
          best.fleeAng = atkAng + Math.PI;  // flee away from attacker
          const fi = ti(best.x, best.y);
          if (world.tiles[fi] !== T.WATER && !infected.has(fi)) {
            infected.set(fi, now + 120000);
            bcast({ t: 'infect', tiles: [fi] });
          }
        }
        // pack enrage on hit (Guide §3.5)
        if (best.type === 'crawler' || best.type === 'husk_wolf') {
          for (const [, ec] of creatures) {
            if ((ec.type === 'crawler' || ec.type === 'husk_wolf') && Math.hypot(ec.x - best.x, ec.y - best.y) <= 10)
              ec.enraged = 100;
          }
        }
        bcast({ t: 'chit', id: bid, ang: atkAng });
      }
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
      } else if (m.k === 'bread' && p.inv.bread > 0) {
        p.inv.bread--; p.hunger = Math.min(10, p.hunger + 4);
      } else if (m.k === 'glowcap' && p.inv.glowcap > 0) {
        p.inv.glowcap--; p.hunger = Math.min(10, p.hunger + 2); p.hp = Math.min(10, p.hp + 1);
        send(ws, { t: 'hp', hp: p.hp });
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
  // New: husk_wolf (night/GRASS), bog_shambler (MUD/BLIGHT near Marsh), frost_wraith (night/SNOW near Spire)
  const strength = 1 + mono.filter(Boolean).length;
  // husk_wolf counts 2 toward cap (Guide substitutions); count them double
  const wolfCount = [...creatures.values()].filter((c) => c.type === 'husk_wolf').length;
  const effectiveCreatureCount = creatures.size + wolfCount;  // wolves counted twice
  const cap = won ? 0 : wave ? 20 : (isNight() ? 6 + 3 * strength : 2 + strength);
  if (effectiveCreatureCount < cap && players.size > 0 && tickN % 3 === 0) {
    const roll = Math.random();
    let type = 'crawler';
    const wisps = [...creatures.values()].filter((c) => c.type === 'wisp').length;
    if (roll > 0.97 && wisps < 2) type = 'wisp';
    else if (strength >= 3 && roll > 0.85) type = 'brute';
    else if (isNight() && roll < 0.05) type = 'husk_wolf';
    else if (isNight() && roll < 0.08) type = 'frost_wraith';
    else if (roll > 0.90 && roll <= 0.93) type = 'bog_shambler';
    else if (isNight() && roll < 0.3) type = 'stalker';
    const a = Math.random() * Math.PI * 2, r = Math.random() * 13;
    let sx = CORE[0] + Math.cos(a) * r, sy = CORE[1] + Math.sin(a) * r, ok = true;
    if (infected.size && roll < 0.25 && type === 'crawler') {  // corruption breeds crawlers far from the core
      const keys = [...infected.keys()];
      const fi = keys[(Math.random() * keys.length) | 0];
      sx = fi % SIZE; sy = (fi / SIZE) | 0;
    } else if (type === 'husk_wolf') {
      // spawn near a random player on GRASS, 2-3 at once (Guide §4.1 / substitutions)
      const qs = [...players.values()].filter((q) => q.z === 0);
      if (qs.length) {
        const q = qs[(Math.random() * qs.length) | 0];
        let placed = false;
        for (let attempt = 0; attempt < 20 && !placed; attempt++) {
          const wa = Math.random() * Math.PI * 2, wr = 9 + Math.random() * 8;
          const wx = Math.round(q.x + Math.cos(wa) * wr), wy = Math.round(q.y + Math.sin(wa) * wr);
          if (wx < 0 || wy < 0 || wx >= SIZE || wy >= SIZE) continue;
          const wi = ti(wx, wy);
          if (world.tiles[wi] !== T.GRASS) continue;
          // place 2-3 wolves (cap at 2 each counts 2 toward cap — skip if over)
          const packN = 2 + (Math.random() < 0.4 ? 1 : 0);
          for (let pw = 0; pw < packN && effectiveCreatureCount + pw * 2 < cap; pw++) {
            const offA = (pw / packN) * Math.PI * 2;
            const px2 = Math.round(wx + Math.cos(offA) * (1 + pw)), py2 = Math.round(wy + Math.sin(offA) * (1 + pw));
            if (px2 < 0 || py2 < 0 || px2 >= SIZE || py2 >= SIZE) continue;
            const pi = ti(px2, py2);
            if (world.tiles[pi] !== T.GRASS) continue;
            const [hb, hs] = CRE_TYPES['husk_wolf'];
            creatures.set('c' + nextCre++, { x: px2, y: py2, hp: hb + hs * strength, type: 'husk_wolf', homeI: ti(px2, py2) });
          }
          placed = true; ok = false;  // already spawned above
        }
        if (!placed) ok = false;
      } else ok = false;
    } else if (type === 'bog_shambler') {
      // spawn on MUD/BLIGHT tiles near Marsh island (ISLES[3]) (Guide §4.2 / substitutions)
      const [mx, my] = ISLES[3];
      for (let attempt = 0; attempt < 20 && ok; attempt++) {
        const ba = Math.random() * Math.PI * 2, br = 5 + Math.random() * 25;
        const bx = Math.round(mx + Math.cos(ba) * br), by = Math.round(my + Math.sin(ba) * br);
        if (bx < 0 || by < 0 || bx >= SIZE || by >= SIZE) { continue; }
        const bi = ti(bx, by);
        const bt = world.tiles[bi];
        if (bt !== T.MUD && bt !== T.BLIGHT) continue;
        // must be ≥9 tiles from any player (Guide substitutions)
        const tooClose = [...players.values()].some((q) => Math.hypot(q.x - bx, q.y - by) < 9);
        if (tooClose) continue;
        sx = bx; sy = by; ok = true; break;
      }
      if (ok && world.tiles[ti(sx, sy)] !== T.MUD && world.tiles[ti(sx, sy)] !== T.BLIGHT) ok = false;
    } else if (type === 'frost_wraith') {
      // spawn at night on SNOW near Spire island (ISLES[2]) (Guide §4.3 / substitutions)
      if (!isNight()) { ok = false; } else {
        const [spx, spy] = ISLES[2];
        for (let attempt = 0; attempt < 20 && ok; attempt++) {
          const fa = Math.random() * Math.PI * 2, fr = 5 + Math.random() * 20;
          const fx = Math.round(spx + Math.cos(fa) * fr), fy = Math.round(spy + Math.sin(fa) * fr);
          if (fx < 0 || fy < 0 || fx >= SIZE || fy >= SIZE) continue;
          const fti = ti(fx, fy);
          if (world.tiles[fti] !== T.SNOW) continue;
          const tooClose = [...players.values()].some((q) => Math.hypot(q.x - fx, q.y - fy) < 9);
          if (tooClose) continue;
          sx = fx; sy = fy; ok = true; break;
        }
        if (ok && world.tiles[ti(sx, sy)] !== T.SNOW) ok = false;
      }
    } else if (isNight() && roll < 0.55 && type !== 'bog_shambler') {  // islands: night horrors near players
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
    if (ok) {
      const homeI = ti(sx, sy);
      creatures.set('c' + nextCre++, { x: sx, y: sy, hp: hb + hs * strength, type, homeI });
    }
  }

  // stalkers + frost_wraith despawn at dawn if no player within 12 (Guide §3.1)
  if (!isNight()) {
    for (const [cid, c] of creatures) {
      if (c.type !== 'stalker' && c.type !== 'frost_wraith') continue;
      const nearPlayer = [...players.values()].some((q) => Math.hypot(q.x - c.x, q.y - c.y) <= 12);
      if (!nearPlayer) creatures.delete(cid);
    }
  }

  for (const [cid, c] of creatures) {
    const [, , baseSp, cdmg] = CRE_TYPES[c.type || 'crawler'];
    // stun check (Guide §2.2)
    if (c.stun > 0) { c.stun--; continue; }

    // enrage decay
    if (c.enraged > 0) c.enraged--;
    const enrageBonus = c.enraged > 0 ? 0.2 : 0;   // +20% speed when enraged (Guide §3.5)
    const enrageRange = c.enraged > 0 ? 6 : 0;       // +6 chase range

    let tx, ty;
    // wisp + frost_wraith: drift behavior
    if (c.type === 'wisp' || c.type === 'frost_wraith') {
      // frost_wraith: switch to stalker-dart if player ≤10 tiles (Guide §4.3)
      if (c.type === 'frost_wraith') {
        let nearP = null, nearD = 10;
        for (const q of players.values()) {
          if (q.z !== 0) continue;
          const d = Math.hypot(q.x - c.x, q.y - c.y);
          if (d < nearD) { nearD = d; nearP = q; }
        }
        if (nearP) {
          // stalker-dart straight at player (Guide §3.4 simplified for frost_wraith)
          tx = nearP.x; ty = nearP.y;
          const dfw = Math.hypot(tx - c.x, ty - c.y) || 0.001;
          const spfw = Math.min(baseSp * 1.25, dfw);
          const nxfw = c.x + ((tx - c.x) / dfw) * spfw, nyfw = c.y + ((ty - c.y) / dfw) * spfw;
          const stifw = ti(nxfw, nyfw);
          if (stifw >= 0 && stifw < SIZE * SIZE && world.tiles[stifw] !== T.WATER && !structures.has(stifw)) {
            c.x = nxfw; c.y = nyfw;
          }
          // wisp flee ticks override
          goto_contact: {
            if (tickN % 5 === 0 && cdmg) {
              for (const [pid, q] of players) {
                if (q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 1.1) {
                  q.hp -= cdmg;
                  const cAng = Math.atan2(q.y - c.y, q.x - c.x);
                  if (q.hp <= 0) { q.hp = 10; q.z = 0; [q.x, q.y] = respawnPoint(pid); }
                  // frost_wraith slow: send {t:'slow', ticks:30} (Guide substitutions)
                  send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y, ang: cAng });
                  send(q.ws, { t: 'slow', ticks: 30 });
                }
              }
            }
          }
          continue;
        }
      }
      // wisp flee from attacker (Guide §3.6)
      if (c.fleeTicks > 0) {
        c.fleeTicks--;
        const fspeed = baseSp * 3 / 10;  // 3 tiles over 10 ticks
        const fnx = c.x + Math.cos(c.fleeAng) * fspeed, fny = c.y + Math.sin(c.fleeAng) * fspeed;
        const fni = ti(fnx, fny);
        if (fni >= 0 && fni < SIZE * SIZE && world.tiles[fni] !== T.WATER) { c.x = fnx; c.y = fny; }
      } else {
        c.tw = (c.tw || 0) - 1;
        if (c.tw <= 0) { const ang = Math.random() * Math.PI * 2; c.dx = Math.cos(ang); c.dy = Math.sin(ang); c.tw = 20 + Math.random() * 30; }
        const nx = c.x + (c.dx || 0) * baseSp, ny = c.y + (c.dy || 0) * baseSp;
        if (nx > 1 && ny > 1 && nx < SIZE - 1 && ny < SIZE - 1) { c.x = nx; c.y = ny; }
      }
      if (tickN % 25 === 0) {
        const i = ti(c.x, c.y);
        if (world.tiles[i] !== T.WATER && world.tiles[i] !== T.BLIGHT && !infected.has(i) && !structures.has(i)) {
          infected.set(i, nowMs + 120000);
          bcast({ t: 'infect', tiles: [i] });
        }
      }
      // wisp contact damage (cdmg=0 for wisp so this is a no-op unless frost_wraith)
      if (tickN % 5 === 0 && cdmg) {
        for (const [pid, q] of players) {
          if (q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 1.1) {
            q.hp -= cdmg;
            const cAng = Math.atan2(q.y - c.y, q.x - c.x);
            if (q.hp <= 0) { q.hp = 10; q.z = 0; [q.x, q.y] = respawnPoint(pid); }
            send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y, ang: cAng });
            if (c.type === 'frost_wraith') send(q.ws, { t: 'slow', ticks: 30 });
          }
        }
      }
      continue;
    }

    // brute telegraph windup (Guide §3.3)
    if (c.type === 'brute' || c.type === 'bog_shambler') {
      if (c.windup > 0) {
        c.windup--;
        continue;  // frozen during windup
      }
      // check if a player just came within 2.5 tiles (only set windup once)
      if (!c.windupTriggered) {
        for (const q of players.values()) {
          if (q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 2.5) {
            c.windup = 8; c.windupTriggered = true;
            bcast({ t: 'ctel', id: cid });
            break;
          }
        }
        // reset trigger when player leaves range
        if (!c.windupTriggered) {
          const anyNear = [...players.values()].some((q) => q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 2.5);
          if (!anyNear) c.windupTriggered = false;
        }
      } else {
        // reset trigger after windup completes
        const anyNear = [...players.values()].some((q) => q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 2.5);
        if (!anyNear) c.windupTriggered = false;
      }
    }

    // leash: walk home if too far and no player near (Guide §3.1)
    const homeI = c.homeI;
    if (homeI !== undefined) {
      const homeX = homeI % SIZE, homeY = (homeI / SIZE) | 0;
      const distHome = Math.hypot(c.x - homeX, c.y - homeY);
      if (distHome > 60) {
        const anyNearLeash = [...players.values()].some((q) => Math.hypot(q.x - c.x, q.y - c.y) <= 20);
        if (!anyNearLeash) {
          // walk home at half speed
          const dhw = distHome || 0.001;
          const sphw = baseSp * 0.5;
          const nhx = c.x + ((homeX - c.x) / dhw) * sphw, nhy = c.y + ((homeY - c.y) / dhw) * sphw;
          const nhI = ti(nhx, nhy);
          if (nhI >= 0 && nhI < SIZE * SIZE && world.tiles[nhI] !== T.WATER && !structures.has(nhI)) { c.x = nhx; c.y = nhy; }
          // despawn at home if still no player near
          if (distHome < 1) {
            const anyNearHome = [...players.values()].some((q) => Math.hypot(q.x - c.x, q.y - c.y) <= 20);
            if (!anyNearHome) { creatures.delete(cid); continue; }
          }
          continue;
        }
      }
    }

    if (wave) { tx = wave.engineI % SIZE; ty = (wave.engineI / SIZE) | 0; }
    else if (c.type === 'brute' || c.type === 'bog_shambler') {
      // bog_shambler ignores structures; brute prefers them (Guide §4.2)
      if (c.type === 'brute') {
        let bd = 45;
        for (const [si, ss] of structures) {
          // brutes ignore non-blocking decor and farmplots
          if (DECOR_NONBLOCKING.has(ss.kind) || ss.kind === 'farmplot') continue;
          const d = Math.hypot((si % SIZE) - c.x, ((si / SIZE) | 0) - c.y);
          if (d < bd) { bd = d; tx = si % SIZE; ty = (si / SIZE) | 0; }
        }
        if (tx === undefined) for (const q of players.values()) {
          const d = Math.hypot(q.x - c.x, q.y - c.y);
          if (d < (bd || 45)) { bd = d; tx = q.x; ty = q.y; }
        }
      } else {
        // bog_shambler: targets players only
        let bd = 45;
        for (const q of players.values()) {
          if (q.z !== 0) continue;
          const d = Math.hypot(q.x - c.x, q.y - c.y);
          if (d < bd) { bd = d; tx = q.x; ty = q.y; }
        }
      }
    } else if (c.type === 'stalker') {
      // stalker flanking: orbit within 8 tiles, then dart (Guide §3.4)
      let nearP = null, nearD = (26 + enrageRange);
      for (const q of players.values()) {
        if (q.z !== 0) continue;
        const rad = q.inv.essence > 0 || q.inv.meat > 0 ? 40 + enrageRange : 26 + enrageRange;
        const d = Math.hypot(q.x - c.x, q.y - c.y);
        if (d < Math.min(nearD, rad)) { nearD = d; nearP = q; }
      }
      if (nearP) {
        if (nearD <= 8) {
          // orbit: steer 90° around player
          const toPlayer = Math.atan2(nearP.y - c.y, nearP.x - c.x);
          const orbitAng = toPlayer + Math.PI / 2;
          // check if "behind" player — dot of (creature→player) with playerFacing (approx as last move dir, or just check angle)
          // dart if angle difference to player-back ≤90°  (simplified: dart after 3 orbit ticks)
          c.orbitTicks = (c.orbitTicks || 0) + 1;
          if (c.orbitTicks >= 3) {
            // dart straight at 1.25× (Guide §3.4)
            tx = nearP.x; ty = nearP.y;
            c.orbitTicks = 0;
          } else {
            tx = c.x + Math.cos(orbitAng) * 4;
            ty = c.y + Math.sin(orbitAng) * 4;
          }
        } else {
          tx = nearP.x; ty = nearP.y;
          c.orbitTicks = 0;
        }
      }
    } else {
      // crawler / husk_wolf: straight chase
      const baseRange = 26 + enrageRange;
      let bd = baseRange;
      for (const q of players.values()) {
        if (q.z !== 0) continue;
        const rad = q.inv.essence > 0 || q.inv.meat > 0 ? 40 + enrageRange : baseRange;
        const d = Math.hypot(q.x - c.x, q.y - c.y);
        if (d < Math.min(bd, rad)) { bd = d; tx = q.x; ty = q.y; }
      }
      // husk_wolf pack-link: share widest aggro within 12 tiles of other wolves (Guide §4.1)
      if (c.type === 'husk_wolf' && tx === undefined) {
        for (const [, wc] of creatures) {
          if (wc === c || wc.type !== 'husk_wolf') continue;
          if (Math.hypot(wc.x - c.x, wc.y - c.y) > 12) continue;
          // if pack-mate has a target, share it (we can't easily get their target — approximate by checking if enraged)
          if (wc.enraged > 0) { c.enraged = Math.max(c.enraged || 0, wc.enraged); }
        }
      }
    }

    if (tx === undefined) continue;

    const distT = Math.hypot(tx - c.x, ty - c.y) || 0.001;
    const spMult = c.type === 'stalker' && c.orbitTicks === 0 ? 1.25 : 1;
    const sp = Math.min((baseSp * (1 + enrageBonus) + strength * 0.03) * spMult, distT);
    let moveAng = Math.atan2(ty - c.y, tx - c.x);

    // water/obstacle steering: try ±35° if blocked (Guide §3.2)
    const creBlocked = (idx) => {
      const cs = structures.get(idx);
      return !cs || (!DECOR_NONBLOCKING.has(cs.kind) && cs.kind !== 'farmplot');
    };
    let nx = c.x + Math.cos(moveAng) * sp, ny = c.y + Math.sin(moveAng) * sp;
    let ni = ti(nx, ny);
    if (ni < 0 || ni >= SIZE * SIZE || world.tiles[ni] === T.WATER || (structures.has(ni) && creBlocked(ni))) {
      let moved = false;
      for (const rot of [35 * Math.PI / 180, -35 * Math.PI / 180]) {
        const tryAng = moveAng + rot;
        const tnx = c.x + Math.cos(tryAng) * sp, tny = c.y + Math.sin(tryAng) * sp;
        const tni = ti(tnx, tny);
        if (tni >= 0 && tni < SIZE * SIZE && world.tiles[tni] !== T.WATER && (!structures.has(tni) || !creBlocked(tni))) {
          nx = tnx; ny = tny; ni = tni; moved = true; break;
        }
      }
      if (!moved) { nx = c.x; ny = c.y; }  // stop this tick
    }

    const s = structures.get(ni);
    // creatures skip non-blocking decor (not fence — fence is blocking so it won't appear here)
    if (s && DECOR_NONBLOCKING.has(s.kind)) { c.x = nx; c.y = ny; }
    else if (s && distT > 1.2 && c.type !== 'bog_shambler') {  // bog_shambler ignores structures
      if (tickN % 5 === 0) {
        s.hp -= (c.type === 'brute') ? 3 : 1;
        if (s.hp <= 0) {
          structures.delete(ni);
          bcast({ t: 'sd', i: ni, hp: 0 });
          if (wave && ni === wave.engineI) { wave = null; bcast({ t: 'msg', s: 'THE WORLD ENGINE WAS DESTROYED! Rebuild it to try again.' }); }
        } else bcast({ t: 'sd', i: ni, hp: s.hp });
      }
    } else { c.x = nx; c.y = ny; }

    // contact damage with ang (Guide §2.1)
    if (tickN % 5 === 0 && cdmg) {
      // brute: only deal damage after windup (Guide §3.3)
      const bruteReady = (c.type !== 'brute' && c.type !== 'bog_shambler') || !c.windupTriggered || c.windup === 0;
      if (bruteReady) {
        for (const [pid, q] of players) {
          if (q.z === 0 && Math.hypot(q.x - c.x, q.y - c.y) < 1.1) {
            // brute: only damage if player still ≤1.1 after windup (already checked above)
            if ((c.type === 'brute' || c.type === 'bog_shambler') && c.windupTriggered && c.windup > 0) continue;
            q.hp -= cdmg;
            const cAng = Math.atan2(q.y - c.y, q.x - c.x);  // away from creature = push direction
            if (q.hp <= 0) { q.hp = 10; q.z = 0; [q.x, q.y] = respawnPoint(pid); }
            send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y, ang: cAng });
          }
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

  // farm growth check (every 50 ticks)
  if (tickN % 50 === 0 && farms.size > 0) {
    for (const [i, fm] of farms) {
      const cropDef = CROPS[fm.crop];
      if (!cropDef) continue;
      const growTicks = (cropDef.growTicks / GROW_DIV) | 0;
      const stage = Math.min(2, Math.floor(3 * (tickN - fm.plantedTick) / growTicks));
      const prevStage = fm.lastStage ?? -1;
      if (stage !== prevStage) {
        fm.lastStage = stage;
        bcast({ t: 'crop', i, crop: fm.crop, stage });
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
