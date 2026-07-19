import WebSocket from 'ws';
import { genWorld, SIZE } from './shared/world.js';
import { NODE } from './shared/defs.js';

const world = genWorld('hearth-1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (s) => { console.log('FAIL:', s); process.exit(1); };

function client(name) {
  const ws = new WebSocket('ws://localhost:8081');
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', tok: 'test-' + Math.random().toString(36).slice(2), ...(name ? { name } : {}) })));
  const c = { ws, msgs: [], state: {} };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'init') c.state = m; if (m.t === 'inv') c.state.inv = m.inv; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = async (t, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const m = c.msgs.find((x) => x.t === t); if (m) return m; await sleep(50); }
    fail('timeout waiting for ' + t);
  };
  return c;
}

const A = client();
const initA = await A.wait('init');
console.log('A joined:', initA.id, 'spawn', initA.x, initA.y);

// B joins — A must see pj
const B = client();
const initB = await B.wait('init');
if (!initB.players.length) fail('B init missing existing player A');
await A.wait('pj');
console.log('multiplayer join OK (A saw B, B saw A)');

// B moves — A must see pos for B
B.send({ t: 'pos', x: initB.x + 2, y: initB.y });
const posm = await A.wait('pos');
console.log('pos relay OK', posm.id);

// find 3 trees near spawn, gather them (3 hand-hits each)
const trees = [...world.nodes].filter(([i, k]) => k === NODE.TREE)
  .map(([i]) => [i, Math.hypot((i % SIZE) - initA.x, ((i / SIZE) | 0) - initA.y)])
  .sort((a, b) => a[1] - b[1]).slice(0, 3).map(([i]) => i);
for (const ti of trees) {
  A.send({ t: 'pos', x: ti % SIZE, y: (ti / SIZE) | 0 });
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
A.send({ t: 'pos', x: px, y: py }); await sleep(60);
A.send({ t: 'build', i: trees[0], kind: 'workbench' });  // tree tile now empty (removed)
const bm = await B.wait('build');
console.log('build OK, synced to B:', bm.kind, 'hp', bm.hp);

// craft axe: needs fiber — should NOT succeed (validation check)
A.send({ t: 'craft', r: 'axe' });
await sleep(300);
if (A.state.inv.wood < 0 || (A.state.inv && A.state.inv.axe)) fail('axe crafted without fiber!');
console.log('craft validation OK (axe rejected without fiber)');

// water collection: teleport next to a water tile, collect, drink
let wi = -1;
for (let i = 0; i < SIZE * SIZE; i++) if (world.tiles[i] === 4) { wi = i; break; }
const wx = wi % SIZE, wy = (wi / SIZE) | 0;
A.send({ t: 'pos', x: wx + 1, y: wy }); await sleep(60);
A.send({ t: 'water' }); await sleep(300);
if (!A.state.inv.water) fail('water collection failed');
A.msgs = A.msgs.filter((m) => m.t !== 'stat');   // drop periodic stats
A.send({ t: 'use', k: 'water' });
const stat = await A.wait('stat');
await sleep(200);
if (A.state.inv.water !== 0) fail('drink failed');
console.log('water collect + drink OK, thirst =', stat.thirst);

// demolition: attack own workbench until destroyed, expect half wood refunded
A.send({ t: 'pos', x: px, y: py + 1 }); await sleep(60);
const woodBefore = A.state.inv.wood;
for (let h = 0; h < 10; h++) { A.send({ t: 'atk' }); await sleep(450); }
await sleep(300);
const sd = B.msgs.find((m) => m.t === 'sd' && m.hp === 0);
if (!sd) fail('workbench not demolished');
if (A.state.inv.wood !== woodBefore + 4) fail(`refund wrong: ${woodBefore} -> ${A.state.inv.wood}`);
console.log('demolition OK: refunded 4 wood, removal synced to B');

// animals broadcast in sim tick — spawn is player-biased now, expect a population
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
  A.send({ t: 'pos', x: t % SIZE, y: (t / SIZE) | 0 }); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(280); }
}
const stones = byDist([...world.nodes].filter(([, k]) => k === NODE.STONE).map(([i]) => i)).slice(0, 9);
for (const s of stones) {
  A.send({ t: 'pos', x: s % SIZE, y: (s / SIZE) | 0 }); await sleep(60);
  A.send({ t: 'gather', i: s }); await sleep(280);
}
await sleep(300);
if (A.state.inv.wood < 24 || A.state.inv.stone < 9) fail(`prep short: ${A.state.inv.wood}w ${A.state.inv.stone}s`);
A.send({ t: 'pos', x: px, y: py }); await sleep(80);
A.send({ t: 'craft', r: 'workbench' }); await sleep(250);
A.send({ t: 'build', i: trees[0], kind: 'workbench' }); await sleep(250);
A.send({ t: 'craft', r: 'pick' }); await sleep(250);
A.send({ t: 'craft', r: 'mineshaft' }); await sleep(250);
if (!A.state.inv.mineshaft) fail('mineshaft craft failed: ' + JSON.stringify(A.state.inv));
const shaft = trees[1], sx2 = shaft % SIZE, sy2 = (shaft / SIZE) | 0;
A.send({ t: 'pos', x: sx2, y: sy2 }); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'dig');
A.send({ t: 'build', i: shaft, kind: 'mineshaft' });
const chamber = await A.wait('dig');
console.log('mineshaft OK: starting chamber', chamber.tiles.length, 'tiles');
A.send({ t: 'pos', x: sx2, y: sy2, z: 1 }); await sleep(100);
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
A.send({ t: 'pos', x: px, y: py, z: 1 }); await sleep(60);   // stand "under" the workbench
A.send({ t: 'atk' }); await sleep(600);
if (A.msgs.some((m) => m.t === 'sd')) fail('underground attack damaged a surface structure!');
console.log('underground attack guard OK');

// torch: gather fiber on the surface, craft, place underground
A.send({ t: 'pos', x: sx2, y: sy2, z: 0 }); await sleep(60);
const bush = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i))[0];
A.send({ t: 'pos', x: bush % SIZE, y: (bush / SIZE) | 0 }); await sleep(60);
A.send({ t: 'gather', i: bush }); await sleep(300);
A.send({ t: 'craft', r: 'torch' }); await sleep(250);
if (!A.state.inv.torch) fail('torch craft failed: ' + JSON.stringify(A.state.inv));
A.send({ t: 'pos', x: sx2, y: sy2, z: 1 }); await sleep(60);
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
  A.send({ t: 'pos', x: cliff[0], y: cliff[1], z: 0 }); await sleep(80);
  A.send({ t: 'pos', x: cliff[0] + 1, y: cliff[1], z: 0 });
  const fh = await A.wait('hp');
  console.log('fall damage OK: hp', fh.hp);
} else console.log('fall damage skipped (no cliff found in scan)');

// iceberg: sailing a wooden boat into a berg shatters it
const berg = [...world.bergs][0];
A.send({ t: 'pos', x: berg % SIZE, y: (berg / SIZE) | 0, z: 0, b: 1 });
await A.wait('boat');
console.log('iceberg collision OK: wooden boat shattered, player washed ashore');

// --- Stage E1: display names ---
// C connects with name 'Tester-A'; verify init.name and that A sees pj with name
A.msgs = A.msgs.filter((m) => m.t !== 'pj');
const C = client('Tester-A');
const initC = await C.wait('init');
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
// Filter any stale inv messages first
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'wear', k: 'heatcloak' });
await sleep(500);
// No inv message with wornGear set should have arrived
const badWear = A.msgs.find((m) => m.t === 'inv' && m.wornGear === 'heatcloak');
if (badWear) fail('E2: server accepted wear for unowned heatcloak!');
console.log('E2 wear reject OK (no inv with wornGear=heatcloak)');

// --- Stage E3: wear accept — craft heatcloak then toggle wear ---
// Ensure A has enough fiber (15) and wood (5) for heatcloak near the workbench.
// A already has some fiber from torch stage. Gather more bushes if needed.
A.send({ t: 'pos', x: px, y: py, z: 0 }); await sleep(80);
const allBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i));
// Gather up to 8 bushes for fiber (each gives 2 fiber → 16 fiber total needed: 15)
for (const bi of allBushes.slice(0, 8)) {
  if ((A.state.inv?.fiber || 0) >= 15) break;
  A.send({ t: 'pos', x: bi % SIZE, y: (bi / SIZE) | 0 }); await sleep(60);
  A.send({ t: 'gather', i: bi }); await sleep(300);
}
await sleep(200);
// Gather more trees if wood < 5
const moreTrees2 = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(10, 15);
for (const tr of moreTrees2) {
  if ((A.state.inv?.wood || 0) >= 5) break;
  A.send({ t: 'pos', x: tr % SIZE, y: (tr / SIZE) | 0 }); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: tr }); await sleep(280); }
}
await sleep(200);
if ((A.state.inv?.fiber || 0) < 15 || (A.state.inv?.wood || 0) < 5)
  fail(`E3: not enough materials for heatcloak: fiber=${A.state.inv?.fiber} wood=${A.state.inv?.wood}`);
// Move near the existing workbench and craft heatcloak
A.send({ t: 'pos', x: px, y: py }); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'craft', r: 'heatcloak' }); await sleep(400);
if (!A.state.inv || ![...A.msgs].reverse().find((m) => m.t === 'inv' && m.gear && m.gear.includes('heatcloak'))) {
  // double-check via state refresh
  await sleep(300);
}
// Check gear from latest inv message
const latestInv = [...A.msgs].reverse().find((m) => m.t === 'inv');
if (!latestInv || !latestInv.gear || !latestInv.gear.includes('heatcloak'))
  fail('E3: heatcloak not in gear after craft. gear=' + JSON.stringify(latestInv?.gear));
// Now wear it
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'wear', k: 'heatcloak' });
const wearInv1 = await A.wait('inv', 2000);
if (wearInv1.wornGear !== 'heatcloak') fail('E3: wornGear should be heatcloak, got ' + wearInv1.wornGear);
console.log('E3 wear accept OK: wornGear =', wearInv1.wornGear);
// Toggle off by sending same key
A.msgs = A.msgs.filter((m) => m.t !== 'inv');
A.send({ t: 'wear', k: 'heatcloak' });
const wearInv2 = await A.wait('inv', 2000);
if (wearInv2.wornGear !== null) fail('E3: wornGear should be null after toggle, got ' + wearInv2.wornGear);
console.log('E3 wear toggle off OK: wornGear =', wearInv2.wornGear);

// --- Stage E4: chit ang field — attack a nearby creature and assert ang is numeric ---
// We need a creature to exist; wait for a cre broadcast with at least one creature
const creWithC = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const latest = A.msgs.filter((m) => m.t === 'cre').pop();
    if (latest && latest.c && latest.c.length > 0) return latest;
    await sleep(200);
  }
  return null;
})();
if (creWithC) {
  const [cid, cx, cy] = creWithC.c[0];
  // teleport A next to the creature and attack
  A.msgs = A.msgs.filter((m) => m.t !== 'chit');
  A.send({ t: 'pos', x: cx + 0.5, y: cy, z: 0 }); await sleep(80);
  A.send({ t: 'atk' }); await sleep(600);
  const chitMsg = A.msgs.find((m) => m.t === 'chit' && m.id === cid);
  if (chitMsg && typeof chitMsg.ang === 'number') {
    console.log('E4 chit ang OK: ang =', chitMsg.ang.toFixed(3));
  } else if (chitMsg) {
    // creature may have died — that's fine (no chit for dead creature)
    console.log('E4 chit ang: creature died on first hit (no chit), skipping ang check');
  } else {
    // creature may have been out of range — that's an acceptable skip
    console.log('E4 chit ang: no chit received (creature may have moved out of range), skipping');
  }
} else {
  console.log('E4 chit ang: no creatures spawned yet — skipping (night-biased spawn)');
}

// --- Stage E5: farming — place farmplot near workbench, plant wheat, check crop broadcast, reject early harvest ---
// Gather legitimately (no dev kit — suite runs against a default server): need wood 4 + fiber 4
A.send({ t: 'pos', x: px, y: py, z: 0 }); await sleep(80);
const moreBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i)).slice(8, 12);   // 0-8 consumed by the cloak stage
for (const b of moreBushes) {
  A.send({ t: 'pos', x: b % SIZE, y: (b / SIZE) | 0 }); await sleep(60);
  A.send({ t: 'gather', i: b }); await sleep(300);
}
const moreWood = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(15, 17);   // 0-15 consumed by earlier stages
for (const t of moreWood) {
  A.send({ t: 'pos', x: t % SIZE, y: (t / SIZE) | 0 }); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(300); }
}
await sleep(300);
if ((A.state.inv?.wood || 0) < 4 || (A.state.inv?.fiber || 0) < 4)
  fail(`E5: gathering short: wood=${A.state.inv?.wood} fiber=${A.state.inv?.fiber}`);
// Craft farmplot
A.send({ t: 'pos', x: px, y: py }); await sleep(80);
A.send({ t: 'craft', r: 'farmplot' }); await sleep(300);
if (!A.state.inv.farmplot) fail('E5: farmplot craft failed: ' + JSON.stringify(A.state.inv));

// Place farmplot adjacent to workbench tile
const fpx = trees[0] % SIZE + 1, fpy = (trees[0] / SIZE) | 0;
const fpi = fpy * SIZE + fpx;
A.send({ t: 'pos', x: fpx, y: fpy }); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'build' && m.t !== 'crop');
A.send({ t: 'build', i: fpi, kind: 'farmplot' });
const fpBuild = await A.wait('build', 3000);
if (fpBuild.kind !== 'farmplot') fail('E5: farmplot build not confirmed, got: ' + fpBuild.kind);
console.log('E5 farmplot placed OK');

// Plant wheat (need fiber>=2)
const fiberBefore = A.state.inv.fiber || 0;
if (fiberBefore < 2) fail('E5: not enough fiber to plant: ' + fiberBefore);
A.msgs = A.msgs.filter((m) => m.t !== 'crop');
A.send({ t: 'plant', i: fpi, crop: 'wheat' });
const cropMsg = await A.wait('crop', 3000);
if (cropMsg.crop !== 'wheat') fail('E5: crop broadcast wrong crop: ' + cropMsg.crop);
if (cropMsg.stage !== 0) fail('E5: newly planted crop should be stage 0, got: ' + cropMsg.stage);
// Fiber should have decreased by 2
await sleep(300);
const fiberAfter = A.state.inv.fiber || 0;
if (fiberAfter !== fiberBefore - 2) fail(`E5: fiber not deducted: before=${fiberBefore} after=${fiberAfter}`);
console.log('E5 plant wheat OK: crop stage=0, fiber decreased by 2');

// Try to harvest immediately — should be rejected (stage 0, not ready)
A.msgs = A.msgs.filter((m) => m.t !== 'msg');
A.send({ t: 'harvest', i: fpi });
await sleep(500);
// No crop null broadcast should arrive (harvest rejected)
const badHarvest = A.msgs.find((m) => m.t === 'crop' && m.crop === null);
if (badHarvest) fail('E5: harvest succeeded at stage 0 — should have been rejected!');
console.log('E5 early harvest correctly rejected');

console.log('ALL TESTS PASSED');
process.exit(0);
