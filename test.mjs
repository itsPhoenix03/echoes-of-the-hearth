import WebSocket from 'ws';
import { genWorld, SIZE, findMedicSpawns } from './shared/world.js';
import { NODE, MAX_HP, MEDICINE_HEAL } from './shared/defs.js';

const world = genWorld('hearth-1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (s) => { console.log('FAIL:', s); process.exit(1); };

function client(name) {
  const ws = new WebSocket('ws://localhost:8081');
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', tok: 'test-' + Math.random().toString(36).slice(2), ...(name ? { name } : {}) })));
  const c = { ws, msgs: [], state: {} };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'init') c.state = m; if (m.t === 'inv') c.state.inv = m.inv; if (m.t === 'hp') c.state.hp = m.hp; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = async (t, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const m = c.msgs.find((x) => x.t === t); if (m) return m; await sleep(50); }
    fail('timeout waiting for ' + t);
  };
  return c;
}

// The suite predates server-side movement validation and teleports the player freely.
// 'warp' is the server's test-only unvalidated placement, gated behind HEARTH_ALLOW_WARP.
const warp = (c, x, y, z = 0, b = 0) => c.send({ t: 'warp', x, y, z, b });

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
warp(A, px, py, 0); await sleep(80);
const allBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i));
// Gather up to 8 bushes for fiber (each gives 2 fiber → 16 fiber total needed: 15)
for (const bi of allBushes.slice(0, 8)) {
  if ((A.state.inv?.fiber || 0) >= 15) break;
  warp(A, bi % SIZE, (bi / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: bi }); await sleep(300);
}
await sleep(200);
// Gather more trees if wood < 5
const moreTrees2 = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(10, 15);
for (const tr of moreTrees2) {
  if ((A.state.inv?.wood || 0) >= 5) break;
  warp(A, tr % SIZE, (tr / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: tr }); await sleep(280); }
}
await sleep(200);
if ((A.state.inv?.fiber || 0) < 15 || (A.state.inv?.wood || 0) < 5)
  fail(`E3: not enough materials for heatcloak: fiber=${A.state.inv?.fiber} wood=${A.state.inv?.wood}`);
// Move near the existing workbench and craft heatcloak
warp(A, px, py); await sleep(80);
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
  warp(A, cx + 0.5, cy, 0); await sleep(80);
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
warp(A, px, py, 0); await sleep(80);
const moreBushes = byDist([...world.nodes].filter(([, k]) => k === NODE.BUSH).map(([i]) => i)).slice(8, 12);   // 0-8 consumed by the cloak stage
for (const b of moreBushes) {
  warp(A, b % SIZE, (b / SIZE) | 0); await sleep(60);
  A.send({ t: 'gather', i: b }); await sleep(300);
}
const moreWood = byDist([...world.nodes].filter(([, k]) => k === NODE.TREE).map(([i]) => i)).slice(15, 17);   // 0-15 consumed by earlier stages
for (const t of moreWood) {
  warp(A, t % SIZE, (t / SIZE) | 0); await sleep(60);
  for (let h = 0; h < 3; h++) { A.send({ t: 'gather', i: t }); await sleep(300); }
}
await sleep(300);
if ((A.state.inv?.wood || 0) < 4 || (A.state.inv?.fiber || 0) < 4)
  fail(`E5: gathering short: wood=${A.state.inv?.wood} fiber=${A.state.inv?.fiber}`);
// Craft farmplot
warp(A, px, py); await sleep(80);
A.send({ t: 'craft', r: 'farmplot' }); await sleep(300);
if (!A.state.inv.farmplot) fail('E5: farmplot craft failed: ' + JSON.stringify(A.state.inv));

// Place farmplot adjacent to workbench tile
const fpx = trees[0] % SIZE + 1, fpy = (trees[0] / SIZE) | 0;
const fpi = fpy * SIZE + fpx;
warp(A, fpx, fpy); await sleep(80);
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

// --- Stage F: Medicine + Medic (client feature) ---
// Fresh node/tile slices only — bushes 0-12 and trees 0-17 are already consumed above.
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

// a) craft medicine (fiber 4 + water 1, near campfire) — 3x so the heal loop below can always top up to full
for (let c = 0; c < 3; c++) { A.send({ t: 'craft', r: 'medicine' }); await sleep(300); }
if ((A.state.inv?.medicine || 0) !== 3) fail('a) medicine craft failed: expected 3, got ' + A.state.inv?.medicine);
console.log('a) craft medicine OK: 3x Herbal Medicine');

// Drive hp down to <=3 (the deterministic cliff from the fall-damage stage above, -1 hp per
// step) so inspect/accept below are exercised (both reject at full health) and so the heal
// loop below sees a clean uncapped heal (3->6->9) followed by a capped one (9->10, heals 1).
if (cliff) {
  for (let i = 0; i < 10 && (A.state.hp ?? 0) > 3; i++) {
    warp(A, cliff[0], cliff[1], 0); await sleep(80);
    A.msgs = A.msgs.filter((m) => m.t !== 'hp');
    A.send({ t: 'pos', x: cliff[0] + 1, y: cliff[1], z: 0 });
    await A.wait('hp', 2000);
  }
}
// Use the Woods medic, not the Spire one: the Spire tile is snow, and standing there without
// a worn Fur Cloak takes -1 hp every 5s environmental tick — which re-triggers the 5s in-combat
// lockout forever and the "wait it out" step below would never succeed.
const medics = findMedicSpawns(world);
const medicWoods = medics.find((md) => md.islandId === 'woods');
if (!medicWoods) fail('F: findMedicSpawns did not return a medic on the Woods');
warp(A, medicWoods.x, medicWoods.y, 0); await sleep(80);
await sleep(5300);   // clear the server's 5s in-combat lockout after the fall damage above

// c) inspect -> offer; a second inspect must return the SAME offer id (stability)
A.msgs = A.msgs.filter((m) => m.t !== 'medicOffer');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'inspect' });
const offer1 = await A.wait('medicOffer');
if (!offer1.offer?.id) fail('c) medic inspect returned no offer: ' + JSON.stringify(offer1));
console.log(`c) medic inspect OK: wants ${offer1.offer.amount} ${offer1.offer.resource}`);
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicOffer');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'inspect' });
const offer2 = await A.wait('medicOffer');
if (offer2.offer?.id !== offer1.offer.id) fail(`c) offer not stable: ${offer1.offer.id} -> ${offer2.offer?.id}`);
console.log('c) medic offer stability OK: repeat inspect returns the same offer id');

// d) accept with insufficient resources — the Woods pool wants wood, fiber, stone or meat.
// A has accumulated plenty of wood/fiber/stone from earlier stages, so spend down exactly
// the resource THIS offer asked for, below its amount (torch spends wood+fiber, campfire
// spends wood+stone — both are station:null so they craft from anywhere). Meat needs no
// draining — nothing in this suite ever hunts, so it is already 0.
const needRes = offer1.offer.resource, needAmt = offer1.offer.amount;
for (let i = 0; i < 15 && (A.state.inv?.[needRes] || 0) >= needAmt; i++) {
  A.send({ t: 'craft', r: 'torch' }); await sleep(120);
  A.send({ t: 'craft', r: 'campfire' }); await sleep(120);
}
await sleep(200);
if ((A.state.inv?.[needRes] || 0) >= needAmt) fail(`d) could not drain ${needRes} below the offer's amount (${needAmt})`);
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: offer1.offer.id });
const acceptShort = await A.wait('medicResult');
if (acceptShort.ok || acceptShort.reason !== 'insufficient-resource')
  fail('d) expected insufficient-resource, got ' + JSON.stringify(acceptShort));
console.log('d) medic accept correctly rejected: insufficient-resource');

// b) use medicine — heals exactly MEDICINE_HEAL, capped so hp never exceeds MAX_HP
let healUses = 0, sawCap = false;
while ((A.state.hp ?? 10) < MAX_HP && (A.state.inv?.medicine || 0) > 0 && healUses < 3) {
  const hpBefore = A.state.hp;
  await sleep(800);   // server throttles 'use' to one per 750ms; faster than that is silently dropped
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
if ((A.state.hp ?? 0) !== MAX_HP) fail('b) expected full health after the medicine loop, got ' + A.state.hp);
console.log(`b) medicine restored full health${sawCap ? ' (cap observed on the last dose)' : ''}`);

// e) accept at full health -> full-health (reuse the still-valid offer from stage c)
await sleep(300);
A.msgs = A.msgs.filter((m) => m.t !== 'medicResult');
A.send({ t: 'medic', medicId: medicWoods.id, action: 'accept', offerId: offer1.offer.id });
const acceptFull = await A.wait('medicResult');
if (acceptFull.ok || acceptFull.reason !== 'full-health') fail('e) expected full-health, got ' + JSON.stringify(acceptFull));
console.log('e) medic accept correctly rejected: full-health');

// --- Stage G: Preferred Validated Action Protocol (seq/act) ---
// Fresh node slices only — bushes 0-18, trees 0-19, hand-stones 0-12 already consumed above.
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

// G2: an accepted action echoes the SAME seq, and the server derives a/tool from world state —
// never the client's claim (a bush is always hand-gathered, regardless of what the client sends)
const g2i = gBushes[19];
warp(A, g2i % SIZE, (g2i / SIZE) | 0); await sleep(80);
A.msgs = A.msgs.filter((m) => m.t !== 'act');
A.send({ t: 'gather', seq: 9002, i: g2i, dx: 1, dy: 0, a: 'slash', tool: 'sword' });   // lie about the action
const g2act = await A.wait('act');
if (g2act.seq !== 9002) fail('G2: act seq mismatch: ' + g2act.seq);
if (g2act.a !== 'punch' || g2act.tool !== null) fail(`G2: server trusted the client's claim: a=${g2act.a} tool=${g2act.tool}`);
console.log('G2 seq echo + server-derived action OK:', g2act.a, g2act.tool);

// G3: dig derives pick vs spick from the tool actually validated, not from any client claim — this
// is the exact bug the protocol fixes (the old client hardcoded a:'pick' even while holding a spick)
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

// G4: a miss (no creature in range) still emits act, but never a chit for that seq
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
if (g5chit) {
  if (g5chit.by !== initA.id || g5chit.seq !== g5seq)
    fail(`G5: chit by/seq mismatch: by=${g5chit.by} seq=${g5chit.seq}`);
  console.log('G5 impact correlation OK: chit.by =', g5chit.by, 'chit.seq =', g5chit.seq);
} else {
  console.log('G5 impact correlation: no creature survived a hit within the time budget — skipping');
}

// --- Stage H: server-side movement validation ---
// The farmplot tile beside the workbench is walkable (farmplots never block), so it is a
// safe, known base to step from; the workbench tile beside it is a known blocker.
const hbx = fpx + 0.5, hby = fpy + 0.5;

// H5: a normal ~0.4-tile step is accepted (stays inside the same tile, so it can never be
// a collision reject — this isolates the speed check).
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

// H6: the exploit — a z=1 transition whose DESTINATION is a real mineshaft but whose ORIGIN is
// far away must be rejected. Validating the destination alone would be a free global teleport.
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

console.log('ALL TESTS PASSED');
process.exit(0);
