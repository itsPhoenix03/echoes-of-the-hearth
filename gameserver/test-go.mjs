// Protocol suite for the GO game server — an adaptation of the root test.mjs.
//
// Same assertions, different front door: players join through the Node control
// plane (:8090) for a signed ticket, `auth` over the WebSocket to the Go server
// (:8082), and terrain arrives as chunks instead of inside `init`. Everything
// after the handshake is the legacy wire protocol, so the gameplay assertions
// below are copied verbatim from test.mjs wherever the behaviour is meant to be
// identical.
//
// Slice 4 (the medic NPC, endgame progression, waves, dev tooling) is in, so
// every stage now runs for real: there are no `skip` lines left in this file,
// and none may be added — a stage that cannot fail asserts nothing.
//
//   Terminal 1:  node control/index.js
//   Terminal 2:  cd gameserver && HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd
//   Terminal 3:  node gameserver/test-go.mjs
//
// Env: HEARTH_CONTROL_URL (default http://localhost:8090), HEARTH_WS (default
// whatever /api/join returns), HEARTH_SEED (default hearth-1).

import WebSocket from 'ws';
import { genWorld, findMedicSpawns, medicBlockTiles, SIZE, MONOLITHS, CORE } from '../shared/world.js';
import { NODE, MAX_HP, MEDICINE_HEAL } from '../shared/defs.js';

const CONTROL = process.env.HEARTH_CONTROL_URL || 'http://localhost:8090';
const SEED = process.env.HEARTH_SEED || 'hearth-1';

const world = genWorld(SEED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (s) => { console.log('FAIL:', s); process.exit(1); };

// The Go server pushes 25 chunks on join and another batch on every chunk
// crossing; a client that stops draining is dropped, so chunks are counted and
// discarded rather than accumulated with the gameplay frames.
async function client(name) {
  const res = await fetch(`${CONTROL}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tok: 'gotest-' + Math.random().toString(36).slice(2), ...(name ? { name } : {}) }),
  });
  if (!res.ok) fail(`control plane /api/join returned ${res.status} — is 'node control/index.js' running on ${CONTROL}?`);
  const { ticket, ws: wsURL } = await res.json();

  const ws = new WebSocket(process.env.HEARTH_WS || wsURL);
  const c = { ws, msgs: [], state: {}, chunks: 0 };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'chunk') { c.chunks++; return; }
    if (m.t === 'authfail') fail('authfail: ' + m.reason);
    c.msgs.push(m);
    if (m.t === 'init') c.state = m;
    if (m.t === 'inv') c.state.inv = m.inv;
    if (m.t === 'hp') c.state.hp = m.hp;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket did not open in 5s')), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.send(JSON.stringify({ t: 'auth', ticket }));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = async (t, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const m = c.msgs.find((x) => x.t === t); if (m) return m; await sleep(50); }
    fail('timeout waiting for ' + t);
  };
  return c;
}

// The suite predates server-side movement validation and teleports the player
// freely. 'warp' is the server's test-only unvalidated placement, gated behind
// HEARTH_ALLOW_WARP.
const warp = (c, x, y, z = 0, b = 0) => c.send({ t: 'warp', x, y, z, b });

const A = await client();
const initA = await A.wait('init', 8000);
console.log('A joined:', initA.id, 'spawn', initA.x, initA.y);
if (initA.seed !== SEED) fail('init.seed mismatch: ' + initA.seed);
if (initA.size !== SIZE) fail('init.size mismatch: ' + initA.size);
if (initA.tiles !== undefined) fail('init carried terrain — it must arrive as chunks');

// init.medics (protocol §3): the client no longer generates the world, so the medic roster
// has to arrive on the wire. The shape must be exactly findMedicSpawns()'s, because the
// client feeds it straight into medicBlockTiles() to build its hut collision set.
{
  const wantMedics = findMedicSpawns(world);
  if (!Array.isArray(initA.medics)) fail('init.medics missing or not an array: ' + JSON.stringify(initA.medics));
  if (initA.medics.length !== wantMedics.length)
    fail(`init.medics has ${initA.medics.length} entries, want ${wantMedics.length}`);
  const MEDIC_KEYS = ['id', 'islandId', 'sprite', 'x', 'y', 'hutSprite', 'hutX', 'hutY'];
  for (let i = 0; i < wantMedics.length; i++) {
    const got = initA.medics[i], want = wantMedics[i];
    const keys = Object.keys(got).sort();
    if (keys.join(',') !== [...MEDIC_KEYS].sort().join(','))
      fail(`init.medics[${i}] keys ${keys.join(',')} != ${[...MEDIC_KEYS].sort().join(',')}`);
    for (const k of MEDIC_KEYS) {
      if (got[k] !== want[k]) fail(`init.medics[${i}].${k} = ${got[k]}, want ${want[k]} (findMedicSpawns)`);
    }
    for (const k of ['x', 'y', 'hutX', 'hutY']) {
      if (!Number.isInteger(got[k])) fail(`init.medics[${i}].${k} is not an integer tile: ${got[k]}`);
    }
  }
  // the client's own helper must accept the wire objects unchanged
  const block = medicBlockTiles(initA.medics);
  if (block.size !== wantMedics.length)
    fail(`medicBlockTiles(init.medics) yielded ${block.size} tiles, want ${wantMedics.length}`);
  for (const md of wantMedics) {
    if (!block.has(md.hutY * SIZE + md.hutX)) fail('medicBlockTiles missed hut tile for ' + md.id);
  }
  console.log('init.medics OK:', initA.medics.map((m) => `${m.id}@${m.x},${m.y}`).join(' '));
}

// hunger/thirst are integers on the wire (protocol §3) — the server keeps fractional
// precision internally but must round with ceil() at the boundary, as server/index.js does.
for (const k of ['hunger', 'thirst']) {
  if (!Number.isInteger(initA[k])) fail(`init.${k} = ${initA[k]} — the wire carries integers`);
}

// B joins — A must see pj
const B = await client();
const initB = await B.wait('init', 8000);
if (!initB.players.length) fail('B init missing existing player A');
if (typeof initB.players[0] !== 'object' || initB.players[0].id === undefined)
  fail('init.players must be objects with an id (protocol §3)');
await A.wait('pj');
console.log('multiplayer join OK (A saw B, B saw A)');

// B moves — A must see pos for B
warp(B, initB.x + 2, initB.y);
const posm = await A.wait('pos');
console.log('pos relay OK', posm.id);

// find 3 trees near spawn, gather them (3 hand-hits each)
const trees = [...world.nodes].filter(([i, k]) => k === NODE.TREE)
  .map(([i]) => [i, Math.hypot((i % SIZE) - initA.x, ((i / SIZE) | 0) - initA.y)])
  .sort((a, b) => a[1] - b[1]).slice(0, 3).map(([i]) => i);
for (const ti of trees) {
  warp(A, ti % SIZE, (ti / SIZE) | 0);
  await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: ti }); await sleep(300); }
}
await sleep(300);
if ((A.state.inv?.wood || 0) < 9) fail('gather: expected 9 wood, got ' + A.state.inv?.wood);
console.log('gather OK: wood =', A.state.inv.wood);
if (!B.msgs.find((m) => m.t === 'node' && m.hp === 0)) fail('B did not see node removal');
console.log('node sync OK');

// craft workbench (8 wood) and place it
A.send({ t: 'craft', r: 'workbench' });
await sleep(300);
if (!A.state.inv.workbench) fail('craft workbench failed: ' + JSON.stringify(A.state.inv));
console.log('craft OK: workbench in inventory');
const px = trees[0] % SIZE, py = (trees[0] / SIZE) | 0;
warp(A, px, py); await sleep(60);
A.send({ t: 'build', i: trees[0], kind: 'workbench' });  // tree tile now empty (removed)
const bm = await B.wait('build');
console.log('build OK, synced to B:', bm.kind, 'hp', bm.hp);
if (bm.dir === undefined || bm.lvl === undefined) fail('build broadcast dropped dir/lvl');

// craft axe: needs fiber — should NOT succeed (validation check)
A.send({ t: 'craft', r: 'axe' });
await sleep(300);
if (A.state.inv.wood < 0 || (A.state.inv && A.state.inv.axe)) fail('axe crafted without fiber!');
console.log('craft validation OK (axe rejected without fiber)');

// water collection: teleport next to a water tile, collect, drink
let wi = -1;
for (let i = 0; i < SIZE * SIZE; i++) if (world.tiles[i] === 4) { wi = i; break; }
const wx = wi % SIZE, wy = (wi / SIZE) | 0;
warp(A, wx + 1, wy); await sleep(60);
A.send({ t: 'water' }); await sleep(300);
if (!A.state.inv.water) fail('water collection failed');
A.msgs = A.msgs.filter((m) => m.t !== 'stat');   // drop periodic stats
A.send({ t: 'use', k: 'water' });
const stat = await A.wait('stat');
await sleep(200);
if (A.state.inv.water !== 0) fail('drink failed');
if (!Number.isInteger(stat.hunger) || !Number.isInteger(stat.thirst))
  fail(`stat carried fractional vitals: hunger=${stat.hunger} thirst=${stat.thirst}`);
console.log('water collect + drink OK, thirst =', stat.thirst);

// demolition: attack own workbench until destroyed, expect half wood refunded
warp(A, px, py + 1); await sleep(60);
const woodBefore = A.state.inv.wood;
for (let h = 0; h < 10; h++) { A.send({ t: 'atk' }); await sleep(450); }
await sleep(300);
const sd = B.msgs.find((m) => m.t === 'sd' && m.hp === 0);
if (!sd) fail('workbench not demolished');
if (A.state.inv.wood !== woodBefore + 4) fail(`refund wrong: ${woodBefore} -> ${A.state.inv.wood}`);
console.log('demolition OK: refunded 4 wood, removal synced to B');

// animals broadcast in sim tick — spawn is player-biased, so expect a population.
// Assertions copied verbatim from the root test.mjs.
const cre = A.msgs.filter((m) => m.t === 'cre').pop();
if (!cre || !Array.isArray(cre.a)) fail('no animal data in sim broadcast');
if (cre.a.length < 3) fail('too few animals spawned: ' + cre.a.length);
console.log('animal sim OK (', cre.a.length, 'animals roaming:', [...new Set(cre.a.map(a => a[3]))].join(','), ')');

// --- mining flow: gather materials, rebuild workbench, craft pick + mine entrance, descend, dig ---
const byDist = (list) => list
  .map((i) => [i, Math.hypot((i % SIZE) - initA.x, ((i / SIZE) | 0) - initA.y)])
  .sort((a, b) => a[1] - b[1]).map(([i]) => i);
const moreTrees = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(3, 10);
for (const t of moreTrees) {
  warp(A, t % SIZE, (t / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(280); }
}
const stones = byDist([...world.nodes].filter(([, k]) => k === NODE.STONE).map(([i]) => i)).slice(0, 9);
for (const s of stones) {
  warp(A, s % SIZE, (s / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: s }); await sleep(280);
}
await sleep(300);
if (A.state.inv.wood < 24 || A.state.inv.stone < 9) fail(`prep short: ${A.state.inv.wood}w ${A.state.inv.stone}s`);
warp(A, px, py); await sleep(80);
A.send({ t: 'craft', r: 'workbench' }); await sleep(250);
A.send({ t: 'build', i: trees[0], kind: 'workbench' }); await sleep(250);
A.send({ t: 'craft', r: 'pick' }); await sleep(250);
A.send({ t: 'craft', r: 'mineshaft' }); await sleep(250);
if (!A.state.inv.mineshaft) fail('mineshaft craft failed: ' + JSON.stringify(A.state.inv));
const shaft = trees[1], sx2 = shaft % SIZE, sy2 = (shaft / SIZE) | 0;
warp(A, sx2, sy2); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'dig');
A.send({ t: 'build', i: shaft, kind: 'mineshaft' });
const chamber = await A.wait('dig');
console.log('mineshaft OK: starting chamber', chamber.tiles.length, 'tiles');
warp(A, sx2, sy2, 1); await sleep(100);
let target = -1;
for (const [ddx, ddy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
  const ii = (sy2 + ddy) * SIZE + (sx2 + ddx);
  if (world.tiles[ii] === 0 && !chamber.tiles.includes(ii)) { target = ii; break; }
}
if (target < 0) fail('no diggable tile near chamber');
A.msgs = A.msgs.filter((m) => m.t !== 'dig');
A.send({ t: 'dig', i: target });
const d2 = await A.wait('dig');
if (!d2.tiles.includes(target)) fail('dig target mismatch');
await B.wait('dig');
console.log('underground dig OK, synced to B. veins here:', world.veins[target] || 'none');

// underground attack guard: swinging in the mine must not damage surface structures
A.msgs = A.msgs.filter((m) => m.t !== 'sd');
warp(A, px, py, 1); await sleep(60);   // stand "under" the workbench
A.send({ t: 'atk' }); await sleep(600);
if (A.msgs.some((m) => m.t === 'sd')) fail('underground attack damaged a surface structure!');
console.log('underground attack guard OK');

// torch: gather fiber on the surface, craft, place underground
warp(A, sx2, sy2, 0); await sleep(60);
const bush = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i))[0];
warp(A, bush % SIZE, (bush / SIZE) | 0); await sleep(60);
A.send({ t: 'gather', i: bush }); await sleep(300);
A.send({ t: 'craft', r: 'torch' }); await sleep(250);
if (!A.state.inv.torch) fail('torch craft failed: ' + JSON.stringify(A.state.inv));
warp(A, sx2, sy2, 1); await sleep(60);
A.send({ t: 'torch' });
const tm = await A.wait('torch');
console.log('torch placed underground OK at tile', tm.i);

// fall damage: step off a 2+ level cliff
let cliff = null;
outer: for (let y = 115; y < 245; y++)
  for (let x = 115; x < 245; x++) {
    const a = y * SIZE + x, b = y * SIZE + x + 1;
    if (world.tiles[a] !== 4 && world.tiles[b] !== 4 && world.elev[a] - world.elev[b] >= 2) { cliff = [x, y]; break outer; }
  }
if (cliff) {
  A.msgs = A.msgs.filter((m) => m.t !== 'hp');
  warp(A, cliff[0], cliff[1], 0); await sleep(80);
  A.send({ t: 'pos', x: cliff[0] + 1, y: cliff[1], z: 0 });   // a real 1-tile step — exercises the validated path
  const fh = await A.wait('hp');
  console.log('fall damage OK: hp', fh.hp);
} else console.log('fall damage skipped (no cliff found in scan)');

// iceberg: sailing a wooden boat into a berg shatters it
const berg = [...world.bergs][0];
warp(A, berg % SIZE, (berg / SIZE) | 0, 0, 1); await sleep(60);
A.send({ t: 'pos', x: berg % SIZE, y: (berg / SIZE) | 0, z: 0, b: 1 });   // the berg hazard lives in the pos handler
await A.wait('boat');
console.log('iceberg collision OK: wooden boat shattered, player washed ashore');

// --- Stage E1: display names ---
// C connects with name 'Tester-A'; verify init.name and that A sees pj with name
A.msgs = A.msgs.filter((m) => m.t !== 'pj');
const C = await client('Tester-A');
const initC = await C.wait('init', 8000);
if (initC.name !== 'Tester-A') fail('E1: init.name wrong: ' + initC.name);
// A should receive a pj broadcast for C with name
const pjForC = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const m = A.msgs.find((x) => x.t === 'pj' && x.name === 'Tester-A');
    if (m) return m;
    await sleep(50);
  }
  fail('E1: A did not receive pj with name Tester-A');
})();
console.log('E1 name OK: init.name =', initC.name, '| A saw pj.name =', pjForC.name);
C.ws.close();
await sleep(200);

// --- Stage E2: wear reject — A sends wear for heatcloak without owning it ---
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'wear', k: 'heatcloak' });
await sleep(500);
const badWear = A.msgs.find((m) => m.t === 'inv' && m.wornGear === 'heatcloak');
if (badWear) fail('E2: server accepted wear for unowned heatcloak!');
console.log('E2 wear reject OK (no inv with wornGear=heatcloak)');

// --- Stage E3: wear accept — craft heatcloak then toggle wear ---
warp(A, px, py, 0); await sleep(80);
const allBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i));
for (const bi of allBushes.slice(0, 8)) {
  if ((A.state.inv?.fiber || 0) >= 15) break;
  warp(A, bi % SIZE, (bi / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: bi }); await sleep(300);
}
await sleep(200);
const moreTrees2 = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(10, 15);
for (const tr of moreTrees2) {
  if ((A.state.inv?.wood || 0) >= 5) break;
  warp(A, tr % SIZE, (tr / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: tr }); await sleep(280); }
}
await sleep(200);
if ((A.state.inv?.fiber || 0) < 15 || (A.state.inv?.wood || 0) < 5)
  fail(`E3: not enough materials for heatcloak: fiber=${A.state.inv?.fiber} wood=${A.state.inv?.wood}`);
warp(A, px, py); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'craft', r: 'heatcloak' }); await sleep(400);
const latestInv = [...A.msgs].reverse().find((m) => m.t === 'inv');
if (!latestInv || !latestInv.gear || !latestInv.gear.includes('heatcloak'))
  fail('E3: heatcloak not in gear after craft. gear=' + JSON.stringify(latestInv?.gear));
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'wear', k: 'heatcloak' });
const wearInv1 = await A.wait('inv', 2000);
if (wearInv1.wornGear !== 'heatcloak') fail('E3: wornGear should be heatcloak, got ' + wearInv1.wornGear);
console.log('E3 wear accept OK: wornGear =', wearInv1.wornGear);
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'wear', k: 'heatcloak' });
const wearInv2 = await A.wait('inv', 2000);
if (wearInv2.wornGear !== null) fail('E3: wornGear should be null after toggle, got ' + wearInv2.wornGear);
console.log('E3 wear toggle off OK: wornGear =', wearInv2.wornGear);

// --- Stage E4: chit ang field — attack a nearby creature and assert ang is numeric ---
// A single unarmed hit does 1 damage and every CRE_TYPES hp floor is 2, so a hit on a FRESH
// creature always survives and always produces a chit. It can still miss for reasons outside
// the assertion's control — the creature moved between the 'cre' snapshot and the swing, or
// it was already damaged by an earlier stage — so this retries across candidates and spawns
// (the same technique G5 uses) within a bounded budget and then fails. There is deliberately
// no "no chit arrived, skipping" path: a test that cannot fail asserts nothing.
let e4chit = null, e4sawCre = false;
const e4t0 = Date.now();
while (!e4chit && Date.now() - e4t0 < 20000) {
  const latest = A.msgs.filter((m) => m.t === 'cre').pop();
  const cands = latest?.c || [];
  if (!cands.length) { await sleep(300); continue; }
  e4sawCre = true;
  for (const [cid, cx, cy] of cands) {
    A.msgs = A.msgs.filter((m) => m.t !== 'chit');
    warp(A, cx + 0.5, cy, 0); await sleep(80);
    A.send({ t: 'atk' });
    await sleep(250);
    const hit = A.msgs.find((m) => m.t === 'chit' && m.id === cid);
    if (hit) { e4chit = hit; break; }
    await sleep(450);   // clear the 400ms atk cooldown before trying the next candidate
  }
}
if (!e4sawCre) fail('E4: no creature ever appeared in a cre broadcast');
if (!e4chit) fail('E4: no creature survived a hit within the time budget (no chit to check ang on)');
if (typeof e4chit.ang !== 'number' || !Number.isFinite(e4chit.ang))
  fail('E4: chit arrived without a finite numeric ang: ' + JSON.stringify(e4chit));
if (e4chit.by !== initA.id) fail('E4: chit.by mismatch: ' + e4chit.by);
console.log('E4 chit ang OK: ang =', e4chit.ang.toFixed(3));

// --- Stage E5: farming — place farmplot near workbench, plant wheat, check crop broadcast, reject early harvest ---
warp(A, px, py, 0); await sleep(80);
const moreBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i)).slice(8, 12);
for (const b of moreBushes) {
  warp(A, b % SIZE, (b / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: b }); await sleep(300);
}
const moreWood = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(15, 17);
for (const t of moreWood) {
  warp(A, t % SIZE, (t / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(300); }
}
await sleep(300);
if ((A.state.inv?.wood || 0) < 4 || (A.state.inv?.fiber || 0) < 4)
  fail(`E5: gathering short: wood=${A.state.inv?.wood} fiber=${A.state.inv?.fiber}`);
warp(A, px, py); await sleep(80);
A.send({ t: 'craft', r: 'farmplot' }); await sleep(300);
if (!A.state.inv.farmplot) fail('E5: farmplot craft failed: ' + JSON.stringify(A.state.inv));

const fpx = trees[0] % SIZE + 1, fpy = (trees[0] / SIZE) | 0;
const fpi = fpy * SIZE + fpx;
warp(A, fpx, fpy); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'build' && m.t !== 'crop');
A.send({ t: 'build', i: fpi, kind: 'farmplot' });
const fpBuild = await A.wait('build', 3000);
if (fpBuild.kind !== 'farmplot') fail('E5: farmplot build not confirmed, got: ' + fpBuild.kind);
console.log('E5 farmplot placed OK');

const fiberBefore = A.state.inv.fiber || 0;
if (fiberBefore < 2) fail('E5: not enough fiber to plant: ' + fiberBefore);
A.msgs = A.msgs.filter((m) => m.t !== 'crop');
A.send({ t: 'plant', i: fpi, crop: 'wheat' });
const cropMsg = await A.wait('crop', 3000);
if (cropMsg.crop !== 'wheat') fail('E5: crop broadcast wrong crop: ' + cropMsg.crop);
if (cropMsg.stage !== 0) fail('E5: newly planted crop should be stage 0, got: ' + cropMsg.stage);
await sleep(300);
const fiberAfter = A.state.inv.fiber || 0;
if (fiberAfter !== fiberBefore - 2) fail(`E5: fiber not deducted: before=${fiberBefore} after=${fiberAfter}`);
console.log('E5 plant wheat OK: crop stage=0, fiber decreased by 2');

A.msgs = A.msgs.filter((m) => m.t !== 'msg');
A.send({ t: 'harvest', i: fpi });
await sleep(500);
const badHarvest = A.msgs.find((m) => m.t === 'crop' && m.crop === null);
if (badHarvest) fail('E5: harvest succeeded at stage 0 — should have been rejected!');
console.log('E5 early harvest correctly rejected');

// --- Stage F: Medicine and the Medic NPC ---
warp(A, px, py, 0); await sleep(80);
const medBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i)).slice(12, 18);
for (const b of medBushes) {
  warp(A, b % SIZE, (b / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: b }); await sleep(300);
}
const medTrees = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(17, 19);
for (const t of medTrees) {
  warp(A, t % SIZE, (t / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(280); }
}
const medStones = byDist([...world.nodes].filter(([, k]) => k === NODE.STONE).map(([i]) => i)).slice(9, 12);
for (const s of medStones) {
  warp(A, s % SIZE, (s / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: s }); await sleep(280);
}
warp(A, wx + 1, wy); await sleep(60);
for (let w = 0; w < 3; w++) { A.send({ t: 'water' }); await sleep(300); }
await sleep(200);
if ((A.state.inv?.fiber || 0) < 12 || (A.state.inv?.wood || 0) < 5 || (A.state.inv?.stone || 0) < 3 || (A.state.inv?.water || 0) < 3)
  fail(`F: medicine prep short: fiber=${A.state.inv?.fiber} wood=${A.state.inv?.wood} stone=${A.state.inv?.stone} water=${A.state.inv?.water}`);
console.log('F prep OK: gathered fiber/wood/stone/water for a campfire + 3x medicine');

// campfire (medicine's required station) at the now-empty trees[2] tile
const cfI = trees[2], cfx = cfI % SIZE, cfy = (cfI / SIZE) | 0;
warp(A, cfx, cfy, 0); await sleep(80);
A.send({ t: 'craft', r: 'campfire' }); await sleep(300);
if (!A.state.inv.campfire) fail('F: campfire craft failed: ' + JSON.stringify(A.state.inv));
A.msgs = A.msgs.filter((m) => m.t !== 'build');
A.send({ t: 'build', i: cfI, kind: 'campfire' });
const cfBuild = await A.wait('build', 3000);
if (cfBuild.kind !== 'campfire') fail('F: campfire build not confirmed, got: ' + cfBuild.kind);
console.log('F campfire placed OK');

// a) craft medicine (fiber 4 + water 1, near campfire) — 3x
for (let c = 0; c < 3; c++) { A.send({ t: 'craft', r: 'medicine' }); await sleep(300); }
if ((A.state.inv?.medicine || 0) !== 3) fail('a) medicine craft failed: expected 3, got ' + A.state.inv?.medicine);
console.log('a) craft medicine OK: 3x Herbal Medicine');

// Stage F spends two budgets, and the order matters. The medic refuses a healthy player, so
// every bargain step re-injures with the fall-damage cliff first; and the three medicine doses
// from (a) are spent LAST, so the heal loop in (b) always runs against a genuinely injured
// player rather than silently passing on one the medic already healed.
//
// One offer serves the whole bargain: (d) drains the resource it asked for and proves a
// refused accept charges nothing, then (d2) re-gathers that exact resource and proves the paid
// path. Nothing slower than ~20 s sits between the offer and either accept, well inside its
// 60 s life.

// --- Stage F c/d/e/f: the medic bargain ---
// Use the Woods medic, not the Spire one: the Spire tile is snow, and standing there without
// a worn Fur Cloak takes -1 hp every 5s environmental tick. That does not arm the in-combat
// lockout (environmental chip damage deliberately is not counted as combat), but it does keep
// re-injuring the player, which would race the full-health assertion in (e).
const medics = findMedicSpawns(world);
const medicWoods = medics.find((md) => md.islandId === 'woods');
if (!medicWoods) fail('F: findMedicSpawns did not return a medic on the Woods');
if (!cliff) fail('F: no cliff found — the medic stages need a deterministic way to take damage');

// The cliff is the only deterministic damage source here: a validated 1-tile step off a 2+
// elevation drop costs exactly 1 hp. It DOES stamp lastDamageAt, so every medic interaction
// after it has to wait out the server's 5s in-combat lockout.
const hurt = async (down) => {
  for (let i = 0; i < 14 && (A.state.hp ?? 0) > down; i++) {
    warp(A, cliff[0], cliff[1], 0); await sleep(80);
    A.msgs = A.msgs.filter((m) => m.t !== 'hp');
    A.send({ t: 'pos', x: cliff[0] + 1, y: cliff[1], z: 0 });
    await A.wait('hp', 2000);
  }
};
const atMedic = async () => { warp(A, medicWoods.x, medicWoods.y, 0); await sleep(80); await sleep(5300); };

await hurt(3);
if ((A.state.hp ?? 0) > 3) fail('F: could not injure the player below 4 hp, got ' + A.state.hp);
await atMedic();

// c) inspect -> offer; a second inspect must return the SAME offer id (stability)
A.msgs = A.msgs.filter((m) => m.t !== 'medicOffer' && m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'inspect' });
const offer1 = await A.wait('medicOffer');
if (!offer1.offer?.id) fail('c) medic inspect returned no offer: ' + JSON.stringify(offer1));
if (typeof offer1.offer.amount !== 'number' || offer1.offer.amount < 1)
  fail('c) offer amount is not a positive number: ' + JSON.stringify(offer1.offer));
if (typeof offer1.offer.expiresInMs !== 'number' || offer1.offer.expiresInMs <= 0 || offer1.offer.expiresInMs > 60000)
  fail('c) offer expiresInMs outside the 60s window: ' + JSON.stringify(offer1.offer));
if (offer1.maxHp !== MAX_HP) fail('c) medicOffer carried the wrong maxHp: ' + JSON.stringify(offer1));
console.log(`c) medic inspect OK: wants ${offer1.offer.amount} ${offer1.offer.resource}`);
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicOffer');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'inspect' });
const offer2 = await A.wait('medicOffer');
if (offer2.offer?.id !== offer1.offer.id) fail(`c) offer not stable: ${offer1.offer.id} -> ${offer2.offer?.id}`);
if (offer2.offer.expiresInMs > offer1.offer.expiresInMs)
  fail('c) a repeat inspect refreshed the expiry — the offer must age, not reset');
console.log('c) medic offer stability OK: repeat inspect returns the same offer id');

const needRes = offer1.offer.resource, needAmt = offer1.offer.amount;

// d) accept with insufficient resources — and assert the refusal charges nothing. The Woods
// pool asks for wood, fiber, stone or meat; drain whichever THIS offer wants below its amount.
// One recipe per resource, each station:null so it crafts from anywhere. Nothing in this suite
// eats meat, so if the roll asked for meat the counter is already 0.
const drainWith = { wood: 'fence', fiber: 'torch', stone: 'campfire' }[needRes];
if (drainWith) {
  for (let i = 0; i < 60 && (A.state.inv?.[needRes] || 0) >= needAmt; i++) {
    A.send({ t: 'craft', r: drainWith }); await sleep(120);
  }
  await sleep(200);
}
if ((A.state.inv?.[needRes] || 0) >= needAmt)
  fail(`d) could not drain ${needRes} below the offer's amount (${needAmt}); have ${A.state.inv?.[needRes]}, wood ${A.state.inv?.wood}`);
const shortBefore = A.state.inv?.[needRes] || 0, dHpBefore = A.state.hp;
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: offer1.offer.id });
const acceptShort = await A.wait('medicResult');
if (acceptShort.ok || acceptShort.reason !== 'insufficient-resource')
  fail('d) expected insufficient-resource, got ' + JSON.stringify(acceptShort));
await sleep(200);
if ((A.state.inv?.[needRes] || 0) !== shortBefore)
  fail(`d) a refused bargain still charged the player: ${needRes} ${shortBefore} -> ${A.state.inv?.[needRes]}`);
if ((A.state.hp ?? 0) !== dHpBefore) fail(`d) a refused bargain moved hp: ${dHpBefore} -> ${A.state.hp}`);
console.log('d) medic accept correctly rejected: insufficient-resource (nothing deducted)');

// e2) the gate rejections. All of these are checked before hp and before the offer, so they
// hold at any health — driving them here covers the client's whole reason switch.
const medicExpect = async (msg, reason, label) => {
  await sleep(300);
  A.msgs = A.msgs.filter((m) => m.t !== 'medicResult');
  A.send(msg);
  const res = await A.wait('medicResult');
  if (res.ok || res.reason !== reason) fail(`${label}: expected ${reason}, got ` + JSON.stringify(res));
  console.log(`${label} OK: ${reason}`);
};
await medicExpect({ t: 'medic', medicId: 'medic-nowhere', action: 'inspect' }, 'unknown-medic', 'e2) unknown medic');
warp(A, medicWoods.x + 6, medicWoods.y, 0); await sleep(150);
await medicExpect({ t: 'medic', medicId: medicWoods.id, action: 'inspect' }, 'too-far', 'e2) out of range');
warp(A, medicWoods.x, medicWoods.y, 0); await sleep(150);
await medicExpect({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: 'not-a-real-offer' }, 'offer-mismatch', 'e2) bogus offer id');

// d2) pay-then-heal for real. Re-stock exactly the resource this offer wants and accept the
// SAME offer — the player must be charged exactly the quoted amount and healed to MAX_HP.
const payTrees = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(25, 40);
// bushes 18 and 19 are reserved for G1/G2, which need intact nodes.
const payBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i)).slice(20, 34);
const payStones = byDist([...world.nodes].filter(([, k]) => k === NODE.STONE).map(([i]) => i)).slice(24, 36);
if (needRes === 'meat') {
  // meat is the one pool entry no node yields, so hunt for it: wildlife rides the same per-tick
  // `cre` frame as monsters, under `a`, and a bare-handed hit (1 dmg) fells a 1-2 hp deer or
  // boar in one or two swings. Bounded, then a hard fail — never a skip.
  const huntT0 = Date.now();
  while ((A.state.inv?.meat || 0) < needAmt && Date.now() - huntT0 < 25000) {
    const latest = A.msgs.filter((m) => m.t === 'cre').pop();
    const prey = latest?.a?.[0];
    if (!prey) { await sleep(300); continue; }
    const [, ax, ay] = prey;
    warp(A, ax + 0.5, ay, 0); await sleep(80);
    A.send({ t: 'atk' }); await sleep(450);   // 450ms clears the 400ms atk cooldown
  }
  if ((A.state.inv?.meat || 0) < needAmt)
    fail(`d2) could not hunt ${needAmt} meat, have ${A.state.inv?.meat}`);
  console.log(`d2) hunted ${A.state.inv.meat} meat for the bargain`);
} else {
  const nodes = needRes === 'fiber' ? payBushes : needRes === 'stone' ? payStones : payTrees;
  for (const n of nodes) {
    if ((A.state.inv?.[needRes] || 0) >= needAmt) break;
    warp(A, n % SIZE, (n / SIZE) | 0); await sleep(60);
    for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: n }); await sleep(280); }
  }
  if ((A.state.inv?.[needRes] || 0) < needAmt)
    fail(`d2) could not re-gather ${needAmt} ${needRes}, have ${A.state.inv?.[needRes]}`);
}
// Gathering and hunting both wander into monster range, and a death would respawn the player
// at full health — which the medic refuses outright. Re-injure if that happened.
if ((A.state.hp ?? 0) >= MAX_HP) await hurt(3);
await atMedic();
const payBefore = A.state.inv[needRes], hpPayBefore = A.state.hp;
if (hpPayBefore >= MAX_HP) fail('d2) player is at full health — the accept would be refused');
A.msgs = A.msgs.filter((m) => m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: offer1.offer.id });
const paid = await A.wait('medicResult');
if (!paid.ok) fail('d2) a fully-funded accept was refused: ' + JSON.stringify(paid));
if (paid.paid?.resource !== needRes || paid.paid?.amount !== needAmt)
  fail('d2) receipt mismatch: ' + JSON.stringify(paid.paid));
if (paid.hp !== MAX_HP) fail('d2) treatment must restore full health, got hp=' + paid.hp);
if (paid.healed !== MAX_HP - hpPayBefore) fail(`d2) healed should be ${MAX_HP - hpPayBefore}, got ${paid.healed}`);
await sleep(200);
if (A.state.inv[needRes] !== payBefore - needAmt)
  fail(`d2) charged the wrong amount: ${needRes} ${payBefore} -> ${A.state.inv[needRes]}, expected -${needAmt}`);
console.log(`d2) medic pay-then-heal OK: paid ${needAmt} ${needRes}, healed ${paid.healed} to full`);

// d3) the offer is consumed: replaying it is a mismatch, not a second charge.
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: offer1.offer.id });
const replay = await A.wait('medicResult');
if (replay.ok) fail('d3) a spent offer was replayable: ' + JSON.stringify(replay));
if (A.state.inv[needRes] !== payBefore - needAmt) fail('d3) the replay charged the player again');
console.log('d3) spent offer correctly refused:', replay.reason);

// f) decline clears the offer and starts the 20s reroll delay, so the very next inspect is
// refused with rate-limited rather than handing out a fresh bargain. A successful accept costs
// no reroll delay, so the inspect below hands out a new offer immediately.
await hurt(MAX_HP - 1);
if ((A.state.hp ?? 0) >= MAX_HP) fail('f) could not injure the player');
await atMedic();
A.msgs = A.msgs.filter((m) => m.t !== 'medicOffer' && m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'inspect' });
const offerF = await A.wait('medicOffer');
if (!offerF.offer?.id) fail('f) inspect returned no offer: ' + JSON.stringify(offerF));
if (offerF.offer.id === offer1.offer.id) fail('f) a spent offer id was handed out again');
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicOffer');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'decline' });
const declined = await A.wait('medicOffer');
if (declined.offer !== null) fail('f) decline must clear the offer, got ' + JSON.stringify(declined.offer));
await medicExpect({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: offerF.offer.id }, 'offer-mismatch', 'f) declined offer unspendable');
await medicExpect({ t: 'medic', medicId: medicWoods.id, action: 'inspect' }, 'rate-limited', 'f) reroll delay after decline');
console.log('f) medic decline OK: offer cleared and rerolls locked for 20s');

// b) use medicine — heals exactly MEDICINE_HEAL, capped so hp never exceeds MAX_HP. Three
// doses from <=3 hp give two uncapped heals and one capped one.
await hurt(3);
if ((A.state.hp ?? 0) > 3) fail('b) could not injure the player below 4 hp, got ' + A.state.hp);
if ((A.state.inv?.medicine || 0) !== 3) fail('b) expected the 3 doses from stage a, got ' + A.state.inv?.medicine);
let healUses = 0, sawCap = false;
while ((A.state.hp ?? 10) < MAX_HP && (A.state.inv?.medicine || 0) > 0 && healUses < 3) {
  const hpBefore = A.state.hp;
  await sleep(800);   // server throttles 'use' to one per 750ms
  A.msgs = A.msgs.filter((m) => m.t !== 'useResult');
  A.send({ t: 'use', k: 'medicine' });
  const res = await A.wait('useResult');
  const expected = Math.min(MEDICINE_HEAL, MAX_HP - hpBefore);
  if (!res.ok || res.healed !== expected) fail(`b) medicine heal mismatch: hpBefore=${hpBefore} expected=${expected} got=${JSON.stringify(res)}`);
  if (res.hp > MAX_HP) fail('b) MAX_HP cap violated: hp=' + res.hp);
  if (res.healed < MEDICINE_HEAL) sawCap = true;
  console.log(`b) use medicine OK: hp ${hpBefore} -> ${res.hp} (healed ${res.healed})`);
  healUses++;
}
if (healUses !== 3) fail('b) expected all three doses to be spent, spent ' + healUses);
if (!sawCap) fail('b) the last dose should have been capped by MAX_HP');
if ((A.state.hp ?? 0) !== MAX_HP) fail('b) expected full health after the medicine loop, got ' + A.state.hp);
console.log('b) medicine restored full health (cap observed on the last dose)');

// e) at full health the medic refuses outright, before it ever looks at an offer.
await atMedic();
A.msgs = A.msgs.filter((m) => m.t !== 'medicResult' && m.t !== 'medicOffer');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'inspect' });
const inspectFull = await A.wait('medicResult');
if (inspectFull.ok || inspectFull.reason !== 'full-health')
  fail('e) expected full-health from inspect, got ' + JSON.stringify(inspectFull));
if (A.msgs.some((m) => m.t === 'medicOffer')) fail('e) a healthy player was still handed an offer');
console.log('e) medic correctly refuses a healthy player: full-health');

// --- Stage MONO: monolith progression (usecore) and the World Engine build gates ---
// The gates, not the grind: `usecore` is refused without a Core in the pack, and the Engine
// is refused both off the activation dais and with the monoliths unlit. Actually lighting all
// four would raise creature strength for the rest of the run, so only the refusals are driven.
A.msgs = A.msgs.filter((m) => m.t !== 'mono');
warp(A, MONOLITHS[0][0], MONOLITHS[0][1], 0); await sleep(150);
A.send({ t: 'usecore', i: 0 }); await sleep(400);
if (A.msgs.some((m) => m.t === 'mono')) fail('MONO: usecore lit a monolith with no Monolith Core in the pack');
console.log('MONO usecore correctly refused with no Core');

const engineI = CORE[1] * SIZE + CORE[0];
const offDais = engineI + 3;
warp(A, offDais % SIZE, (offDais / SIZE) | 0, 0); await sleep(150);
A.msgs = A.msgs.filter((m) => m.t !== 'build' && m.t !== 'wave');
A.send({ t: 'build', i: offDais, kind: 'engine' }); await sleep(400);
if (A.msgs.some((m) => m.t === 'build')) fail('MONO: the World Engine was built off the activation dais');
console.log('MONO engine build correctly refused off the dais');
warp(A, CORE[0], CORE[1], 0); await sleep(150);
A.msgs = A.msgs.filter((m) => m.t !== 'build' && m.t !== 'wave');
A.send({ t: 'build', i: engineI, kind: 'engine' }); await sleep(400);
if (A.msgs.some((m) => m.t === 'build')) fail('MONO: the World Engine was built with the monoliths unlit');
if (A.msgs.some((m) => m.t === 'wave')) fail('MONO: a refused Engine build still armed the final assault');
console.log('MONO engine build correctly refused with the monoliths unlit');

// --- Stage DEV: the dev/devcmd gate ---
// The gate is the ticket's signed `dev` claim and nothing else (docs/10 §10.6); these tickets
// carry no claim, so both must be refused with the legacy off-message and must mutate
// nothing. If this ever starts passing the gate, the tester panel is reachable in production.
A.msgs = A.msgs.filter((m) => m.t !== 'msg');
const devInvBefore = A.state.inv?.starmetal || 0;
A.send({ t: 'dev' }); await sleep(400);
if (!A.msgs.some((m) => m.t === 'msg' && /Dev mode/.test(m.s)))
  fail('DEV: `dev` was neither granted nor refused — no Dev mode message');
await sleep(200);
if ((A.state.inv?.starmetal || 0) !== devInvBefore)
  fail('DEV: the dev kit was granted to a ticket with no dev claim!');
A.msgs = A.msgs.filter((m) => m.t !== 'msg' && m.t !== 'mono');
A.send({ t: 'devcmd', cmd: 'mono', i: 0 }); await sleep(400);
if (A.msgs.some((m) => m.t === 'mono')) fail('DEV: devcmd mono ran with no dev claim!');
if (!A.msgs.some((m) => m.t === 'msg' && /Dev mode/.test(m.s)))
  fail('DEV: devcmd was not refused with a message');
console.log('DEV gate OK: dev and devcmd both refused, nothing mutated');

// --- Stage G: Preferred Validated Action Protocol (seq/act) ---
warp(A, px, py, 0); await sleep(80);
const gTrees = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(19, 22);
for (const t of gTrees) {
  warp(A, t % SIZE, (t / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(280); }
}
const gStones = byDist([...world.nodes].filter(([, k]) => k === NODE.STONE).map(([i]) => i)).slice(12, 24);
for (const s of gStones) {
  warp(A, s % SIZE, (s / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: s }); await sleep(280);
}
await sleep(300);
if ((A.state.inv?.wood || 0) < 8 || (A.state.inv?.stone || 0) < 10)
  fail(`G prep: not enough materials for a Stone Pickaxe: wood=${A.state.inv?.wood} stone=${A.state.inv?.stone}`);
warp(A, px, py); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'craft', r: 'spick' }); await sleep(300);
const spickInv = [...A.msgs].reverse().find((m) => m.t === 'inv' && m.tools && m.tools.includes('spick'));
if (!spickInv) fail('G prep: Stone Pickaxe craft failed (tools=' + JSON.stringify(spickInv?.tools) + ')');
console.log('G prep OK: crafted Stone Pickaxe for the dig tool-derivation check below');

// G1: an invalid action (out of range) must emit NO 'act', only 'actReject' with the matching seq
const gBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i));
const g1i = gBushes[18];
const g1x = g1i % SIZE, g1y = (g1i / SIZE) | 0;
warp(A, (g1x + 40) % SIZE, g1y); await sleep(80);   // deliberately far from the target
A.msgs = A.msgs.filter((m) => m.t !== 'act' && m.t !== 'actReject');
A.send({ t: 'gather', seq: 9001, i: g1i, dx: 1, dy: 0 });
await sleep(400);
if (A.msgs.some((m) => m.t === 'act')) fail('G1: an out-of-range gather emitted act');
const g1r = A.msgs.find((m) => m.t === 'actReject' && m.seq === 9001);
if (!g1r) fail('G1: out-of-range gather did not produce actReject(seq=9001)');
console.log('G1 invalid action correctly rejected OK: reason =', g1r.reason);

// G2: an accepted action echoes the SAME seq, and the server derives a/tool from world state
const g2i = gBushes[19];
warp(A, g2i % SIZE, (g2i / SIZE) | 0); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'act');
A.send({ t: 'gather', seq: 9002, i: g2i, dx: 1, dy: 0, a: 'slash', tool: 'sword' });   // lie about the action
const g2act = await A.wait('act');
if (g2act.seq !== 9002) fail('G2: act seq mismatch: ' + g2act.seq);
if (g2act.a !== 'punch' || g2act.tool !== null) fail(`G2: server trusted the client's claim: a=${g2act.a} tool=${g2act.tool}`);
console.log('G2 seq echo + server-derived action OK:', g2act.a, g2act.tool);

// G3: dig derives pick vs spick from the tool actually validated, not from any client claim
await sleep(300);   // clear the shared gather/dig 250ms cooldown left over from G2
warp(A, sx2, sy2, 1); await sleep(80);
let g3target = -1;
for (const [ddx, ddy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
  const ii = (sy2 + ddy) * SIZE + (sx2 + ddx);
  if (world.tiles[ii] === 0 && ii !== target && !chamber.tiles.includes(ii)) { g3target = ii; break; }
}
if (g3target < 0) fail('G3: no fresh diggable tile found near the mineshaft');
A.msgs = A.msgs.filter((m) => m.t !== 'act' && m.t !== 'dig');
A.send({ t: 'dig', seq: 9003, i: g3target, dx: 0, dy: -1, tool: 'axe', a: 'pick' });   // lie about the tool
const g3act = await A.wait('act');
if (g3act.seq !== 9003) fail('G3: dig act seq mismatch: ' + g3act.seq);
if (g3act.a !== 'mine' || g3act.tool !== 'spick') fail(`G3: dig did not derive spick from owned tools: a=${g3act.a} tool=${g3act.tool}`);
const g3dig = await A.wait('dig');
if (g3dig.by !== initA.id || g3dig.seq !== 9003) fail(`G3: dig outcome missing by/seq: by=${g3dig.by} seq=${g3dig.seq}`);
console.log('G3 dig tool-derivation OK: server used spick despite the client claiming axe/pick');

// G4: a miss (nothing in range) still emits act, but never a chit for that seq
warp(A, wx, wy, 0); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'act' && m.t !== 'chit');
A.send({ t: 'atk', seq: 9004, dx: 1, dy: 0 });
const g4act = await A.wait('act');
if (g4act.seq !== 9004) fail('G4: miss act seq mismatch: ' + g4act.seq);
await sleep(300);
if (A.msgs.some((m) => m.t === 'chit' && m.seq === 9004)) fail('G4: a miss produced a chit for seq 9004');
console.log('G4 miss OK: act fired with no chit');

// G5: a successful, non-lethal hit's chit carries the correct by/seq correlation. A single
// unarmed hit (dmg 1) never one-shots a fresh spawn (every CRE_TYPES hp floor is 2), but the
// very first candidate may be one E4 already damaged above — so retry across candidates/spawns.
let g5chit = null, g5seq = 9004;
const g5t0 = Date.now();
while (!g5chit && Date.now() - g5t0 < 10000) {
  const latest = A.msgs.filter((m) => m.t === 'cre').pop();
  const cand = latest?.c?.[0];
  if (!cand) { await sleep(300); continue; }
  const [cid, cx, cy] = cand;
  g5seq++;
  A.msgs = A.msgs.filter((m) => m.t !== 'chit' && m.t !== 'act');
  warp(A, cx + 0.5, cy, 0); await sleep(80);
  A.send({ t: 'atk', seq: g5seq, dx: -1, dy: 0 });
  const g5act = await A.wait('act');
  if (g5act.seq !== g5seq) fail('G5: act seq mismatch: ' + g5act.seq);
  await sleep(250);
  g5chit = A.msgs.find((m) => m.t === 'chit' && m.id === cid) || null;
  if (!g5chit) await sleep(450);   // clear atk cooldown, let a dead target drop off the next 'cre' tick
}
if (!g5chit) fail('G5: no creature survived a hit within the time budget');
if (g5chit.by !== initA.id || g5chit.seq !== g5seq)
  fail(`G5: chit by/seq mismatch: by=${g5chit.by} seq=${g5chit.seq}`);
console.log('G5 impact correlation OK: chit.by =', g5chit.by, 'chit.seq =', g5chit.seq);

// --- Stage H: server-side movement validation ---
const hbx = fpx + 0.5, hby = fpy + 0.5;

// H5: a normal ~0.4-tile step is accepted
warp(A, hbx, hby, 0); await sleep(1100);   // outlast the server's 1s post-warp grace window
A.msgs = A.msgs.filter((m) => m.t !== 'fix' && m.t !== 'pos');
A.send({ t: 'pos', x: hbx + 0.4, y: hby, z: 0 });
await sleep(400);
if (A.msgs.some((m) => m.t === 'fix')) fail('H5: a normal 0.4-tile step was rejected');
if (!A.msgs.some((m) => m.t === 'pos' && m.id === initA.id)) fail('H5: accepted step was not broadcast');
console.log('H5 normal step accepted OK');

// H1: a 50-tile jump is rejected and the fix carries the pre-jump position
A.msgs = A.msgs.filter((m) => m.t !== 'fix');
A.send({ t: 'pos', x: hbx + 50.4, y: hby, z: 0 });
const h1 = await A.wait('fix');
if (Math.hypot(h1.x - (hbx + 0.4), h1.y - hby) > 0.02)
  fail('H1: fix did not carry the pre-jump position: ' + h1.x + ',' + h1.y);
console.log('H1 speed reject OK: snapped back to', h1.x, h1.y);
await sleep(400);   // clear the 250ms fix throttle

// H2: a move into a blocking structure (the workbench) is rejected
A.msgs = A.msgs.filter((m) => m.t !== 'fix');
A.send({ t: 'pos', x: px + 0.5, y: py + 0.5, z: 0 });
const h2 = await A.wait('fix');
if (Math.hypot(h2.x - (hbx + 0.4), h2.y - hby) > 0.02) fail('H2: fix moved the player: ' + h2.x + ',' + h2.y);
console.log('H2 collision reject OK (workbench tile refused)');
await sleep(400);

// H3: WATER at z=0 must stay walkable — swimming and boats depend on it
warp(A, wx + 1.5, wy + 0.5, 0); await sleep(1100);
A.msgs = A.msgs.filter((m) => m.t !== 'fix' && m.t !== 'pos');
A.send({ t: 'pos', x: wx + 0.5, y: wy + 0.5, z: 0 });
await sleep(400);
if (A.msgs.some((m) => m.t === 'fix')) fail('H3: a move onto WATER was rejected — swimming/boats broken');
if (!A.msgs.some((m) => m.t === 'pos' && m.id === initA.id)) fail('H3: water step was not broadcast');
console.log('H3 water step accepted OK');
await sleep(400);

// H4: claiming the mine layer far from any mineshaft is rejected
if (Math.hypot(wx - sx2, wy - sy2) <= 3) fail('H4: the water probe tile is too close to the mineshaft to test');
A.msgs = A.msgs.filter((m) => m.t !== 'fix');
A.send({ t: 'pos', x: wx + 0.5, y: wy + 0.5, z: 1 });
const h4 = await A.wait('fix');
if (h4.z !== 0) fail('H4: server accepted z=1 far from any mineshaft');
console.log('H4 illegal layer change rejected OK');

await sleep(400);

// H6: a z=1 transition whose DESTINATION is a real mineshaft but whose ORIGIN is far away
A.msgs = A.msgs.filter((m) => m.t !== 'fix');
A.send({ t: 'pos', x: sx2 + 0.5, y: sy2 + 0.5, z: 1 });
const h6 = await A.wait('fix');
if (h6.z !== 0 || Math.hypot(h6.x - (wx + 0.5), h6.y - (wy + 0.5)) > 0.02)
  fail('H6: server teleported the player to a distant mineshaft: ' + JSON.stringify(h6));
console.log('H6 remote layer-change teleport rejected OK');
await sleep(600);   // clear the fix throttle and the 500ms z cooldown

// H7: the legitimate counterpart — standing AT the shaft, descending must still work
warp(A, sx2 + 0.5, sy2 + 0.5, 0); await sleep(1100);
A.msgs = A.msgs.filter((m) => m.t !== 'fix' && m.t !== 'pos');
A.send({ t: 'pos', x: sx2 + 0.5, y: sy2 + 0.5, z: 1 });
await sleep(400);
if (A.msgs.some((m) => m.t === 'fix')) fail('H7: a legitimate descent at the shaft was rejected');
if (!A.msgs.some((m) => m.t === 'pos' && m.id === initA.id && m.z === 1)) fail('H7: descent was not broadcast');
console.log('H7 legitimate descent still accepted OK');

// --- Stage CH: chests (no coverage in the root suite; added for Slice 2) ---
// Last, so it can use node slices nothing else has consumed. A chest is
// furniture: it goes down with `furn` on a carved mine tile, and it is only
// reachable from the layer it was placed on.
// 11 wood: 8 for the chest itself, plus the 3 deposited below. Earlier stages spend an
// unpredictable amount (the medic's bargain can ask for up to 10 wood), so gather to a
// target rather than assuming a fixed slice covers it.
const chTrees = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(40, 60);
for (const t of chTrees) {
  if ((A.state.inv?.wood || 0) >= 11) break;
  warp(A, t % SIZE, (t / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(280); }
}
await sleep(300);
if ((A.state.inv?.wood || 0) < 11)
  fail('CH: not enough wood for a chest plus a deposit: ' + A.state.inv?.wood);
warp(A, px, py, 0); await sleep(80);
A.send({ t: 'craft', r: 'chest' }); await sleep(300);
if (!A.state.inv.chest) fail('CH: chest craft failed: ' + JSON.stringify(A.state.inv));
const chestI = target;                       // a tile we dug out above
warp(A, chestI % SIZE, (chestI / SIZE) | 0, 1); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'furn');
A.send({ t: 'furn', i: chestI, kind: 'chest' });
const furnMsg = await A.wait('furn', 3000);
if (furnMsg.kind !== 'chest' || furnMsg.z !== 1) fail('CH: chest not placed in the mine: ' + JSON.stringify(furnMsg));
console.log('CH chest placed underground OK');

A.msgs = A.msgs.filter((m) => m.t !== 'chest');
A.send({ t: 'chest_open', i: chestI });
const chestOpen = await A.wait('chest', 3000);
if (typeof chestOpen.slots !== 'object') fail('CH: chest_open returned no slots');
const woodPre = A.state.inv.wood;
A.msgs = A.msgs.filter((m) => m.t !== 'chest');
A.send({ t: 'chest_move', i: chestI, res: 'wood', n: 3 });
const dep = await A.wait('chest', 3000);
await sleep(250);
if (dep.slots.wood !== 3) fail('CH: deposit not stored: ' + JSON.stringify(dep.slots));
if (A.state.inv.wood !== woodPre - 3) fail(`CH: deposit not charged: ${woodPre} -> ${A.state.inv.wood}`);
// Over-withdrawing must be clamped to what the chest holds, never minted.
A.msgs = A.msgs.filter((m) => m.t !== 'chest');
A.send({ t: 'chest_move', i: chestI, res: 'wood', n: -99 });
const wd = await A.wait('chest', 3000);
await sleep(250);
if (wd.slots.wood) fail('CH: chest still holds wood after a full withdraw: ' + JSON.stringify(wd.slots));
if (A.state.inv.wood !== woodPre) fail(`CH: over-withdraw minted wood: ${woodPre} -> ${A.state.inv.wood}`);
console.log('CH chest deposit/withdraw OK: clamped, nothing minted');
// The same chest must be unreachable from the surface.
warp(A, chestI % SIZE, (chestI / SIZE) | 0, 0); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'chest');
A.send({ t: 'chest_open', i: chestI });
await sleep(400);
if (A.msgs.some((m) => m.t === 'chest')) fail('CH: a mine chest was opened from the surface');
console.log('CH cross-layer chest access correctly refused');

console.log(`chunks streamed to A: ${A.chunks}`);
console.log('ALL TESTS PASSED');
process.exit(0);
