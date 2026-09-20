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
//   Terminal 1:  HEARTH_TICKET_PRIVKEY=<below> HEARTH_TICKET_PUBKEY=<below> node control/index.js
//   Terminal 2:  cd gameserver && HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd
//   Terminal 3:  node gameserver/test-go.mjs
//
// The pinned keypair is required by the DEV stages: the dev tools are gated on a
// per-account `dev` claim the control plane signs into the ticket, and the suite
// has to exercise BOTH sides of that gate in one run. There is no way to ask a
// live control plane for one ticket with the claim and one without in the same
// configuration (HEARTH_DEV_ALL grants it to every loopback caller; the
// HEARTH_DEV_TOKS allowlist grants it to none unless configured), so the suite
// mints both tickets itself with the throwaway keypair below and depends on
// control's dev policy not at all. See control/PROTOCOL.md §1 for the env vars
// and §2 for the payload. The game server needs no extra configuration: it
// fetches whatever key /api/pubkey publishes.
//
// Env: HEARTH_CONTROL_URL (default http://localhost:8090), HEARTH_WS (default
// whatever /api/join returns), HEARTH_SEED (default hearth-1).

import WebSocket from 'ws';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { genWorld, findMedicSpawns, medicBlockTiles, SIZE, T, MONOLITHS, CORE } from '../shared/world.js';
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
  return connect(process.env.HEARTH_WS || wsURL, ticket);
}

// opts.allowAuthFail is for the ADMIT stage only: a refusal is the assertion
// there, so it is recorded like any other frame instead of killing the run.
// Everywhere else an authfail is still an immediate failure.
async function connect(wsURL, ticket, opts = {}) {
  const ws = new WebSocket(wsURL);
  const c = { ws, msgs: [], state: {}, chunks: 0, closed: false };
  ws.on('close', () => { c.closed = true; });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'chunk') { c.chunks++; return; }
    if (m.t === 'authfail' && !opts.allowAuthFail) fail('authfail: ' + m.reason);
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

// --- locally minted tickets (the DEV stages) --------------------------------
//
// A throwaway Ed25519 keypair, checked in on purpose: it signs nothing outside
// this suite, and the control plane only trusts it while it is explicitly pinned
// with HEARTH_TICKET_PRIVKEY / HEARTH_TICKET_PUBKEY (see the header). Minting
// here is what lets one run cover both sides of the dev gate — a ticket WITH the
// `dev` claim and one WITHOUT — regardless of how the control plane's own dev
// policy (HEARTH_DEV_ALL / HEARTH_DEV_TOKS) happens to be configured.
const TEST_PUBKEY = 'pXp61YDNvCKAWFbaUizKTGmXbQHJsqNxzi1ELp1YBwg=';
const TEST_PRIVKEY = 'gqTfYZYjNTLRF/mMqIV8G1ncAvE0QKrccz1gF7j1Saw=';

// Node's crypto wants PKCS8 DER; the raw 32 bytes are the Ed25519 seed. Same
// wrapping as control/ticket.js rawPrivateKeyToKeyObject().
const TEST_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(TEST_PRIVKEY, 'base64')]),
  format: 'der', type: 'pkcs8',
});
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let jtiN = 0;
// PROTOCOL.md §2: the signature covers the ASCII bytes of the base64url payload
// segment, and `dev` is emitted only ever as true — omitted entirely otherwise.
function mintTicket({ userId, worldId, instanceId, name, dev }) {
  const iat = Date.now();
  const payload = { userId, worldId, instanceId, name, iat, exp: iat + 30_000, jti: `gotest-${++jtiN}` };
  if (dev === true) payload.dev = true;
  const seg = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${seg}.${b64url(edSign(null, Buffer.from(seg, 'ascii'), TEST_KEY))}`;
}

let pinnedWorld = null;
async function resolvePinnedWorld() {
  if (pinnedWorld) return pinnedWorld;
  const pk = await (await fetch(`${CONTROL}/api/pubkey`)).json();
  if (pk.publicKey !== TEST_PUBKEY) {
    fail(
      "the control plane is not pinned to this suite's test keypair, so the DEV stages cannot mint a " +
      'dev-claimed ticket. Restart it with: ' +
      `HEARTH_TICKET_PRIVKEY=${TEST_PRIVKEY} HEARTH_TICKET_PUBKEY=${TEST_PUBKEY} node control/index.js` +
      ' (and restart the game server afterwards so it re-fetches /api/pubkey)',
    );
  }
  // instanceId is deliberately absent from /api/worlds (PROTOCOL.md §1), so the
  // ops endpoint is the only place to read the pair the ticket has to bind.
  const worlds = await (await fetch(`${CONTROL}/api/worlds`)).json();
  const health = await (await fetch(`${CONTROL}/api/health`)).json();
  pinnedWorld = health.worlds.find((w) => w.worldId === worlds.defaultWorldId) || health.worlds[0];
  if (!pinnedWorld) fail('/api/health listed no worlds');
  return pinnedWorld;
}

// A client whose ticket this suite signed, with or without the dev claim.
// userId defaults to a fresh identity; the ADMIT stage pins it on purpose,
// because two tickets for ONE userId are exactly the duplicate-tab bug.
async function mintedClient(name, dev, opts = {}) {
  const w = await resolvePinnedWorld();
  const ticket = mintTicket({
    userId: opts.userId || 'u_gotest' + Math.random().toString(36).slice(2, 10),
    worldId: w.worldId, instanceId: w.instanceId, name, dev,
  });
  return connect(process.env.HEARTH_WS || w.ws, ticket, opts);
}

const lastOf = (c, t) => [...c.msgs].reverse().find((m) => m.t === t);

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

// --- Stage DEV: the dev/devcmd gate, refused ---
// The gate is the ticket's signed `dev` claim and nothing else (docs/10 SS10.6). ND's ticket is
// minted here WITHOUT the claim, so this stage is independent of how the live control plane
// happens to be configured: it is refused even under HEARTH_DEV_ALL=1. If this ever starts
// passing the gate, the tester panel is reachable in production.
const ND = await mintedClient('NoDev', false);
const initND = await ND.wait('init', 8000);
if (initND.dev !== false)
  fail(`DEV: init.dev = ${JSON.stringify(initND.dev)} for a ticket with no claim, want false`);
console.log('DEV init.dev = false for an unprivileged session OK');

// The F9 kit.
ND.msgs = ND.msgs.filter((m) => m.t !== 'msg' && m.t !== 'inv' && m.t !== 'stat');
ND.send({ t: 'dev' }); await sleep(500);
const ndKitMsg = ND.msgs.find((m) => m.t === 'msg');
if (!ndKitMsg) fail('DEV: `dev` was neither granted nor refused \u2014 no message at all');
// `inv` only: the survival tick sends every player a periodic `stat`, so its presence says
// nothing. The kit is the only thing that would send this session an `inv`.
if (ND.msgs.some((m) => m.t === 'inv'))
  fail('DEV: the dev kit was granted to a ticket with no dev claim!');
// The legacy refusal text pointed at `npm run server:dev`, which starts the LEGACY Node server
// on :8081 and sets an env var this server deliberately never reads. Following it changes
// nothing, which is exactly how a working dev path came to look unported.
if (/server:dev/.test(ndKitMsg.s))
  fail('DEV: the refusal still points at the legacy server: ' + ndKitMsg.s);
if (!/start:dev/.test(ndKitMsg.s))
  fail('DEV: the refusal names no way to actually obtain dev: ' + ndKitMsg.s);
console.log('DEV kit refused OK, with accurate advice:', ndKitMsg.s);

// Every devcmd, each with the frames and the toast it must NOT have produced. `hp` is
// deliberately not in any forbidden list: the survival tick and the creature AI send hp frames
// to every player on their own schedule, so its presence proves nothing either way. The
// success toast each command emits is the reliable tell, and the Go unit test
// room.TestDevRefusedWithoutClaimMutatesNothing asserts the room state field by field.
const DEV_SUCCESS_TOASTS = /God mode|Spawned |Cleared \d+ monsters|Killed|Time set to|DEV KIT/;
const REFUSE_CASES = [
  ['tp', { cmd: 'tp', x: MONOLITHS[1][0], y: MONOLITHS[1][1] }, ['pos']],
  ['mono', { cmd: 'mono', i: 0 }, ['mono']],
  ['god', { cmd: 'god' }, []],
  ['wx', { cmd: 'wx', kind: 'sandstorm' }, ['wx']],
  ['time', { cmd: 'time', v: 0.8 }, []],
  ['spawn', { cmd: 'spawn', type: 'brute' }, []],
  ['clearcre', { cmd: 'clearcre' }, []],
  ['kill', { cmd: 'kill' }, ['pos']],
];
for (const [name, frame, forbidden] of REFUSE_CASES) {
  const chunksBefore = ND.chunks;
  const clockBefore = lastOf(ND, 'cre')?.time;
  ND.msgs = ND.msgs.filter((m) => !['msg', 'mono', 'wx', 'pos', 'inv'].includes(m.t));
  ND.send({ t: 'devcmd', ...frame }); await sleep(450);
  const refusal = ND.msgs.find((m) => m.t === 'msg' && /Dev tools off/.test(m.s));
  if (!refusal) fail(`DEV: devcmd ${name} was not refused: ${JSON.stringify(ND.msgs.filter((m) => m.t === 'msg'))}`);
  if (/server:dev/.test(refusal.s)) fail(`DEV: devcmd ${name} refusal points at the legacy server`);
  const leaked = ND.msgs.find((m) => m.t === 'msg' && DEV_SUCCESS_TOASTS.test(m.s));
  if (leaked) fail(`DEV: devcmd ${name} ran with no dev claim — it reported "${leaked.s}"`);
  for (const t of forbidden) {
    if (ND.msgs.some((m) => m.t === t && (m.id === undefined || m.id === initND.id)))
      fail(`DEV: devcmd ${name} ran with no dev claim — it emitted a '${t}' frame!`);
  }
  if (ND.chunks !== chunksBefore) fail(`DEV: devcmd ${name} pushed chunks to an unprivileged session`);
  if (name === 'time') {
    // `time` is only observable through the clock the per-tick `cre` frame carries. 0.8 is far
    // from wherever the world currently is, so a jump would be unmistakable.
    const clockAfter = lastOf(ND, 'cre')?.time;
    if (clockBefore !== undefined && clockAfter !== undefined && Math.abs(clockAfter - clockBefore) > 0.05)
      fail(`DEV: devcmd time moved the world clock ${clockBefore} -> ${clockAfter} with no dev claim`);
  }
}
console.log(`DEV gate OK: dev and all ${REFUSE_CASES.length} devcmds refused, nothing mutated`);
// ND has nothing left to prove, and a world admits 4 players (§11.4): its seat has
// to go back before DEVOK opens D's and, briefly, the mono witness's.
ND.ws.close();
await sleep(200);

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

// --- Stage DEVOK: the tester path, GRANTED ---
// Last on purpose. mono, wx, time, spawn and clearcre are global room state, so running this
// anywhere earlier would perturb every stage after it.
//
// Slice 4 shipped the dev tooling with only the refusal above under test, which is exactly the
// shape of coverage that lets the granted path rot silently: every command could have been a
// no-op and the suite would still have been green. Each command below is asserted on what it
// actually did to the world, not on the absence of an error. Room-internal detail that has no
// wire representation (strength gating, respawn-point selection, clamping) is covered
// deterministically by gameserver/room/dev_test.go.
const D = await mintedClient('DevTester', true);
const initD = await D.wait('init', 8000);
if (initD.dev !== true)
  fail(`DEVOK: init.dev = ${JSON.stringify(initD.dev)} for a dev-claimed ticket, want true`);
console.log('DEVOK init.dev = true for a dev session OK');

// An exposed sand tile on the far island: far enough that the teleport has to stream a fresh
// chunk neighbourhood, open enough that the sandstorm branch of the survival tick has nothing
// to shelter behind.
const devSand = (() => {
  for (let i = 0; i < world.tiles.length; i++) {
    const x = i % SIZE, y = (i / SIZE) | 0;
    if (world.tiles[i] !== T.SAND) continue;
    if (x < 4 || y < 4 || x >= SIZE - 4 || y >= SIZE - 4) continue;
    if (Math.hypot(x - initD.x, y - initD.y) < 400) continue;
    if (MONOLITHS.some(([mx, my]) => Math.hypot(mx - x, my - y) < 15)) continue;
    if (Math.hypot(CORE[0] - x, CORE[1] - y) < 25) continue;
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++)
      for (let dx = -2; dx <= 2; dx++) if (world.tiles[(y + dy) * SIZE + (x + dx)] !== T.SAND) { ok = false; break; }
    if (ok) return [x + 0.5, y + 0.5];
  }
  return null;
})();
if (!devSand) fail('DEVOK: no open sand plain found for the teleport/weather probe');

// devcmd `time`: the clock the per-tick `cre` frame carries must follow it.
const clockFollows = async (v) => {
  D.msgs = D.msgs.filter((m) => m.t !== 'cre');
  D.send({ t: 'devcmd', cmd: 'time', v });
  await sleep(700);
  const got = lastOf(D, 'cre')?.time;
  if (got === undefined) fail('DEVOK: no cre frame carrying the clock');
  // the sim advances ~0.00015/tick, so anything beyond a few thousandths is a command that
  // did not take
  if (Math.abs(got - v) > 0.01) fail(`DEVOK: devcmd time ${v} left the clock at ${got}`);
  return got;
};
await clockFollows(0.82);   // night
await clockFollows(0.30);   // day
await clockFollows(0.80);   // night again, so the desert-heat branch stays out of the way below
console.log('DEVOK time OK: the world clock follows devcmd time, day <-> night');

// devcmd `tp`: the player moves AND the terrain around the destination is streamed. Without the
// chunk push (the one deliberate deviation from the legacy server, which shipped the whole map
// in `init`) the tester lands in an empty world.
{
  const chunksBefore = D.chunks;
  D.msgs = D.msgs.filter((m) => m.t !== 'pos' && m.t !== 'hp');
  D.send({ t: 'devcmd', cmd: 'tp', x: devSand[0], y: devSand[1] });
  await sleep(700);
  const tpPos = D.msgs.find((m) => m.t === 'pos' && m.id === initD.id);
  if (!tpPos) fail('DEVOK: devcmd tp broadcast no pos');
  if (Math.hypot(tpPos.x - devSand[0], tpPos.y - devSand[1]) > 0.01)
    fail(`DEVOK: tp put the player at ${tpPos.x},${tpPos.y}, want ${devSand}`);
  // Exactly the Chebyshev-radius-2 neighbourhood of the destination chunk, clipped to the
  // 20x20 grid. D has never been anywhere near here, so none of it was already sent.
  const CHUNK = initD.chunk, GRID = SIZE / CHUNK;
  const dcx = Math.floor(devSand[0] / CHUNK), dcy = Math.floor(devSand[1] / CHUNK);
  let wantChunks = 0;
  for (let cy = dcy - 2; cy <= dcy + 2; cy++)
    for (let cx = dcx - 2; cx <= dcx + 2; cx++)
      if (cx >= 0 && cy >= 0 && cx < GRID && cy < GRID) wantChunks++;
  const pushed = D.chunks - chunksBefore;
  if (pushed !== wantChunks)
    fail(`DEVOK: tp streamed ${pushed} chunks, want ${wantChunks} — the tester lands in void`);
  const tpHp = D.msgs.find((m) => m.t === 'hp');
  if (!tpHp || Math.hypot(tpHp.x - devSand[0], tpHp.y - devSand[1]) > 0.01)
    fail('DEVOK: tp sent no hp frame carrying the new position');
  console.log(`DEVOK tp OK: moved ${Math.round(Math.hypot(devSand[0] - initD.x, devSand[1] - initD.y))} tiles and streamed ${pushed} chunks`);
}

// A survival-tick window: returns every hp value the server reported during it. The survival
// block runs every 25 ticks = 5 s, so 13 s covers at least two of them.
const hpWindow = async (ms = 13000) => {
  D.msgs = D.msgs.filter((m) => m.t !== 'hp' && m.t !== 'msg');
  await sleep(ms);
  return D.msgs.filter((m) => m.t === 'hp').map((m) => m.hp);
};

// devcmd `wx`: set it, and the survival tick must take the matching branch. The clock is at
// night, so the day-only desert-heat case cannot be what is doing the damage.
{
  let hps = await hpWindow(11000);
  if (hps.some((h) => h < MAX_HP)) fail(`DEVOK: exposed sand damaged the player with no weather: ${hps}`);
  // drop any natural weather frame from the 11s window above: wait() scans the
  // whole buffer, so a stale {kind:null} would satisfy the assertion below
  D.msgs = D.msgs.filter((m) => m.t !== 'wx');
  D.send({ t: 'devcmd', cmd: 'wx', kind: 'sandstorm' });
  const wxOn = await D.wait('wx', 3000);
  if (wxOn.kind !== 'sandstorm') fail('DEVOK: devcmd wx sandstorm broadcast ' + JSON.stringify(wxOn));
  hps = await hpWindow();
  if (!hps.length || Math.min(...hps) >= MAX_HP)
    fail(`DEVOK: a forced sandstorm did nothing to a player standing exposed on sand: ${hps}`);
  if (!D.msgs.some((m) => m.t === 'msg' && /sandstorm/i.test(m.s)))
    fail('DEVOK: the sandstorm survival branch sent no sandstorm message');
  const hurt = Math.min(...hps);
  D.msgs = D.msgs.filter((m) => m.t !== 'wx');
  D.send({ t: 'devcmd', cmd: 'wx', kind: 'clear' });   // anything unrecognised clears
  const wxOff = await D.wait('wx', 3000);
  if (wxOff.kind !== null) fail('DEVOK: clearing the weather broadcast ' + JSON.stringify(wxOff));
  D.msgs = D.msgs.filter((m) => m.t !== 'wx');
  hps = await hpWindow();
  // clearing sets until=0, so the weather tick is free to roll a NEW storm
  // during this window. That is the simulation working, not a regression — only
  // damage with no storm running contradicts the clear.
  const natural = D.msgs.find((m) => m.t === 'wx' && m.kind);
  if (hps.some((h) => h < hurt) && !natural)
    fail(`DEVOK: clearing the weather did not stop the damage: ${hps}`);
  console.log(
    `DEVOK wx OK: sandstorm cost ${MAX_HP - hurt} hp on exposed sand, clearing it stopped the damage` +
      (natural ? ` (a natural ${natural.kind} rolled in afterwards)` : ''),
  );
}

// `dev` (F9 kit): every slot, and the vitals the storm just spent.
{
  D.msgs = D.msgs.filter((m) => !['inv', 'stat', 'msg', 'hp'].includes(m.t));
  D.send({ t: 'dev' });
  await sleep(600);
  const kit = lastOf(D, 'inv');
  if (!kit) fail('DEVOK: the dev kit sent no inv frame — the client would show an empty belt');
  const WANT_INV = { wood: 500, stone: 500, fiber: 200, crystal: 100, iron: 100, diamond: 50,
    starmetal: 50, essence: 100, cookedmeat: 10, torch: 30, core: 4, engine: 1, boat: 2 };
  for (const [k, v] of Object.entries(WANT_INV))
    if (kit.inv[k] !== v) fail(`DEVOK: dev kit inv.${k} = ${kit.inv[k]}, want ${v}`);
  for (const t of ['axe', 'pick', 'spick', 'sword', 'isword'])
    if (!kit.tools.includes(t)) fail('DEVOK: dev kit granted no ' + t);
  for (const g of ['heatcloak', 'furcloak'])
    if (!kit.gear.includes(g)) fail('DEVOK: dev kit granted no ' + g);
  const kitStat = lastOf(D, 'stat');
  if (!kitStat || kitStat.hunger !== 10 || kitStat.thirst !== 10)
    fail('DEVOK: dev kit did not restore hunger/thirst: ' + JSON.stringify(kitStat));
  // hp has no frame of its own in the kit handler; tp reports the current value.
  D.msgs = D.msgs.filter((m) => m.t !== 'hp');
  D.send({ t: 'devcmd', cmd: 'tp', x: devSand[0], y: devSand[1] });
  const kitHp = await D.wait('hp', 3000);
  if (kitHp.hp !== MAX_HP) fail(`DEVOK: dev kit left hp at ${kitHp.hp}, want ${MAX_HP}`);
  console.log('DEVOK dev kit OK: full inventory, all 5 tools, both cloaks, vitals restored');
}

// devcmd `god`: the tester genuinely survives. Driven with the environmental tick rather than
// creature AI so it is deterministic — the same protection covers both (godTick heals a
// protected player to full at the top of every tick, before anything can act).
{
  D.msgs = D.msgs.filter((m) => m.t !== 'msg');
  D.send({ t: 'devcmd', cmd: 'god' }); await sleep(300);
  if (!D.msgs.some((m) => m.t === 'msg' && /God mode ON/.test(m.s)))
    fail('DEVOK: devcmd god sent no "God mode ON" toast');
  D.send({ t: 'devcmd', cmd: 'wx', kind: 'sandstorm' }); await sleep(300);
  let hps = await hpWindow(16000);
  // The storm still lands its chip, but godTick puts it back on the next tick, so hp can never
  // walk down. Anything at or below MAX_HP - 2 means two hits accumulated.
  if (hps.some((h) => h <= MAX_HP - 2))
    fail(`DEVOK: god mode did not protect the player — hp walked down: ${hps}`);
  if (hps.length && hps[hps.length - 1] !== MAX_HP)
    fail(`DEVOK: god mode left hp at ${hps[hps.length - 1]}, want ${MAX_HP}`);
  D.msgs = D.msgs.filter((m) => m.t !== 'msg');
  D.send({ t: 'devcmd', cmd: 'god' }); await sleep(300);
  if (!D.msgs.some((m) => m.t === 'msg' && /God mode OFF/.test(m.s)))
    fail('DEVOK: toggling god off sent no "God mode OFF" toast');
  hps = await hpWindow(16000);
  if (!hps.length || Math.min(...hps) > MAX_HP - 2)
    fail(`DEVOK: with god off the same storm did not resume damaging the player: ${hps}`);
  D.send({ t: 'devcmd', cmd: 'wx', kind: 'clear' });
  D.send({ t: 'dev' });   // back to full for the rest of the stage
  await sleep(500);
  console.log('DEVOK god OK: invulnerable while on, damage resumed when switched off');
}

// devcmd `spawn`: every CRE_TYPES key, each one reaching the client in a `cre` frame. The Go
// unit test iterates the server's own creTypes map, so a type added there and forgotten here
// still fails the build.
const CRE_TYPE_KEYS = ['crawler', 'stalker', 'brute', 'wisp', 'husk_wolf', 'bog_shambler',
  'frost_wraith', 'drowned', 'blight_lancer'];
for (const type of CRE_TYPE_KEYS) {
  D.send({ t: 'devcmd', cmd: 'clearcre' }); await sleep(400);
  D.msgs = D.msgs.filter((m) => m.t !== 'cre' && m.t !== 'msg');
  D.send({ t: 'devcmd', cmd: 'spawn', type });
  let seen = null;
  const t0 = Date.now();
  while (!seen && Date.now() - t0 < 4000) {
    for (const fr of D.msgs.filter((m) => m.t === 'cre')) {
      const hit = (fr.c || []).find((row) => row[3] === type);
      if (hit) { seen = hit; break; }
    }
    if (!seen) await sleep(100);
  }
  if (!seen) fail(`DEVOK: devcmd spawn ${type} never appeared in a cre broadcast`);
  if (!D.msgs.some((m) => m.t === 'msg' && m.s.includes(type)))
    fail(`DEVOK: devcmd spawn ${type} sent no confirmation naming the type`);
}
console.log(`DEVOK spawn OK: all ${CRE_TYPE_KEYS.length} creature types spawned and broadcast`);

// devcmd `clearcre`: every creature currently alive is gone. Asserted on identity rather than
// on an empty frame: the natural spawn roll runs inside the very same tick that processes the
// command, so at night the world is rarely observably empty even though the clear did happen.
{
  for (const type of ['crawler', 'brute', 'stalker']) {
    D.send({ t: 'devcmd', cmd: 'spawn', type }); await sleep(120);
  }
  await sleep(500);
  const doomed = new Set(((lastOf(D, 'cre') || {}).c || []).map((row) => row[0]));
  if (doomed.size === 0) fail('DEVOK: nothing to clear — the spawns did not land');
  D.msgs = D.msgs.filter((m) => m.t !== 'cre' && m.t !== 'msg');
  D.send({ t: 'devcmd', cmd: 'clearcre' });
  let cleared = false, survivors = null;
  const c0 = Date.now();
  while (!cleared && Date.now() - c0 < 4000) {
    for (const fr of D.msgs.filter((m) => m.t === 'cre')) {
      survivors = (fr.c || []).filter((row) => doomed.has(row[0]));
      if (survivors.length === 0) { cleared = true; break; }
    }
    if (!cleared) await sleep(100);
  }
  if (!cleared)
    fail(`DEVOK: clearcre left ${survivors.length} of the ${doomed.size} creatures alive`);
  if (!D.msgs.some((m) => m.t === 'msg' && /Cleared \d+ monsters/.test(m.s)))
    fail('DEVOK: clearcre reported no count');
  console.log(`DEVOK clearcre OK: all ${doomed.size} live creatures removed`);
}

// devcmd `mono`: lights the monolith and the `mono` list a fresh client is handed follows.
// (That the raised strength opens the brute / blight-lancer spawn gates is asserted
// deterministically in room.TestDevMonoLightsAndRaisesStrength — 8000 spawn rolls is not
// something to do over a socket.)
{
  for (let i = 0; i < 4; i++) {
    if (initD.mono[i]) continue;                    // already lit earlier in the run
    D.msgs = D.msgs.filter((m) => m.t !== 'mono');
    D.send({ t: 'devcmd', cmd: 'mono', i });
    const m = await D.wait('mono', 3000);
    if (m.i !== i) fail(`DEVOK: devcmd mono ${i} broadcast i=${m.i}`);
  }
  await sleep(300);
  const fresh = await mintedClient('MonoWitness', false);
  const initFresh = await fresh.wait('init', 8000);
  if (!Array.isArray(initFresh.mono) || initFresh.mono.some((v) => v !== true))
    fail('DEVOK: after lighting all four, a fresh init still reports mono = ' + JSON.stringify(initFresh.mono));
  fresh.ws.close();
  console.log('DEVOK mono OK: all four lit and carried in init.mono');
}

// devcmd `kill`: respawn with full vitals, and the movement grace window that keeps the
// client's in-flight `pos` from being snapped back.
{
  D.send({ t: 'devcmd', cmd: 'tp', x: devSand[0], y: devSand[1] }); await sleep(600);
  D.msgs = D.msgs.filter((m) => m.t !== 'hp' && m.t !== 'msg' && m.t !== 'fix' && m.t !== 'pos');
  D.send({ t: 'devcmd', cmd: 'kill' });
  const killHp = await D.wait('hp', 3000);
  if (killHp.hp !== MAX_HP) fail(`DEVOK: kill respawned with hp ${killHp.hp}, want ${MAX_HP}`);
  if (Math.hypot(killHp.x - devSand[0], killHp.y - devSand[1]) < 1)
    fail('DEVOK: kill did not move the player off the death spot');
  if (!D.msgs.some((m) => m.t === 'msg' && /respawned/i.test(m.s)))
    fail('DEVOK: kill sent no respawn toast');
  // A 6-tile step is far beyond the speed budget available this instant (warped() stamps
  // LastPosAt, so dt is ~0 and the allowance is the 1-tile flat slack). Only the grace window
  // can let it through, and without it the client's in-flight pos is snapped back to the
  // respawn point mid-stride.
  const probe = { x: killHp.x + 6, y: killHp.y, z: 0 };
  D.msgs = D.msgs.filter((m) => m.t !== 'fix' && m.t !== 'pos');
  D.send({ t: 'pos', ...probe });
  await sleep(500);
  if (D.msgs.some((m) => m.t === 'fix'))
    fail('DEVOK: kill opened no movement grace window — the in-flight pos was snapped back');
  if (!D.msgs.some((m) => m.t === 'pos' && m.id === initD.id))
    fail('DEVOK: the post-kill pos was neither accepted nor rejected');
  console.log('DEVOK kill OK: respawned at full vitals with the movement grace window open');
}

// --- Stage MOD: modular building over the wire (§12) ---
// Inside the DEVOK block on purpose: the dev kit is what supplies the crafted
// materials, and D is already parked on an open sand plain with no creatures.
{
  D.send({ t: 'devcmd', cmd: 'clearcre' });
  D.send({ t: 'dev' });                                  // refill materials
  await sleep(400);
  const [mx, my] = devSand;
  D.send({ t: 'devcmd', cmd: 'tp', x: mx, y: my });
  await sleep(700);
  const mi = (my | 0) * SIZE + (mx | 0);

  const planksBefore = D.state.inv.wood_planks;
  if (!planksBefore) fail('MOD: the dev kit granted no wood_planks');
  D.msgs = D.msgs.filter((m) => m.t !== 'mod' && m.t !== 'modfail');
  D.send({ t: 'buildmod', i: mi, kind: 'mod_floor_wood', slot: 'floor', seq: 1 });
  const placed = await D.wait('mod', 3000);
  if (placed.slot !== 'floor' || placed.kind !== 'mod_floor_wood')
    fail('MOD: unexpected mod broadcast ' + JSON.stringify(placed));
  if (!placed.hp) fail('MOD: the mod broadcast carried no hp');
  await sleep(250);
  if (D.state.inv.wood_planks !== planksBefore - 2)
    fail(`MOD: cost not charged: ${planksBefore} -> ${D.state.inv.wood_planks}`);

  // a second slot on the same tile is the whole point of the system. wait()
  // scans the whole buffer, so the previous frame has to be dropped first.
  D.msgs = D.msgs.filter((m) => m.t !== 'mod' && m.t !== 'modfail');
  D.send({ t: 'buildmod', i: mi, kind: 'mod_wall_stone', slot: 'wallNE', seq: 2 });
  const wall = await D.wait('mod', 3000);
  if (wall.slot !== 'wallNE')
    fail('MOD: a wall on an occupied tile was refused: ' + JSON.stringify(wall));

  // ...and the same slot twice is not, with the seq echoed back
  D.msgs = D.msgs.filter((m) => m.t !== 'modfail');
  D.send({ t: 'buildmod', i: mi, kind: 'mod_wall_wood', slot: 'wallNE', seq: 3 });
  const dup = await D.wait('modfail', 3000);
  if (dup.why !== 'slot-occupied' || dup.seq !== 3)
    fail('MOD: duplicate slot answered ' + JSON.stringify(dup));

  // slot/kind mismatch and an out-of-reach tile are refused the same way
  D.msgs = D.msgs.filter((m) => m.t !== 'modfail');
  D.send({ t: 'buildmod', i: mi, kind: 'mod_floor_wood', slot: 'roof', seq: 4 });
  const badSlot = await D.wait('modfail', 3000);
  if (badSlot.why !== 'bad-slot') fail('MOD: a floor in the roof slot answered ' + JSON.stringify(badSlot));

  // a blocking wall edge stops the player walking through it: warp is a scripted
  // reposition, so step across with a normal pos instead.
  warp(D, mx, my); await sleep(120);
  D.msgs = D.msgs.filter((m) => m.t !== 'fix');
  D.send({ t: 'pos', x: mx + 1, y: my, z: 0, b: 0 });
  const fix = await D.wait('fix', 3000);
  if (Math.abs(fix.x - mx) > 0.6) fail(`MOD: walking through a wall was allowed — snapped to ${fix.x}`);
  console.log('MOD wall edge OK: the crossing was refused and the client snapped back');

  // demolition: swing until a piece on this tile comes down and expect half its
  // materials back. Which piece falls first is the server's ordering to decide,
  // so the refund is asserted against whichever slot it reports.
  const REFUND = { floor: 'wood_planks', wallNE: 'stone_blocks' };
  const before = { wood_planks: D.state.inv.wood_planks, stone_blocks: D.state.inv.stone_blocks };
  D.msgs = D.msgs.filter((m) => m.t !== 'modd');
  for (let h = 0; h < 12 && !D.msgs.some((m) => m.t === 'modd'); h++) {
    D.send({ t: 'atk' }); await sleep(450);
  }
  const gone = D.msgs.find((m) => m.t === 'modd');
  if (!gone) fail('MOD: nothing was demolished in 12 swings');
  const res = REFUND[gone.slot];
  if (!res) fail('MOD: modd reported an unexpected slot ' + JSON.stringify(gone));
  await sleep(250);
  if (D.state.inv[res] !== before[res] + 1)
    fail(`MOD: demolishing the ${gone.slot} refunded ${D.state.inv[res] - before[res]} ${res}, want 1`);
  console.log(`MOD OK: placed, slot-checked, blocked a crossing, demolished the ${gone.slot} for 1 ${res}`);

  // bridges: the one piece allowed over water, and only moored to land (§12.5)
  const coast = (() => {
    for (let i = 0; i < world.tiles.length; i++) {
      const x = i % SIZE;
      if (x < 2 || x >= SIZE - 2) continue;
      if (world.tiles[i] !== T.WATER) continue;
      if (world.tiles[i - 1] === T.WATER || world.tiles[i + 1] !== T.WATER) continue;
      return [i, i + 1];                       // land at i-1, open water at i+1
    }
    return null;
  })();
  if (!coast) fail('MOD: no coastline found for the bridge probe');
  const [nearI, farI] = coast;
  D.send({ t: 'devcmd', cmd: 'tp', x: (nearI % SIZE) - 1 + 0.5, y: ((nearI / SIZE) | 0) + 0.5 });
  await sleep(700);

  D.msgs = D.msgs.filter((m) => m.t !== 'mod' && m.t !== 'modfail');
  D.send({ t: 'buildmod', i: farI, kind: 'mod_bridge_segment', slot: 'floor', seq: 10 });
  const adrift = await D.wait('modfail', 3000);
  if (adrift.why !== 'no-anchor') fail('MOD: an unmoored segment answered ' + JSON.stringify(adrift));

  D.msgs = D.msgs.filter((m) => m.t !== 'mod' && m.t !== 'modfail');
  D.send({ t: 'buildmod', i: nearI, kind: 'mod_bridge_segment', slot: 'floor', seq: 11 });
  const moored = await D.wait('mod', 3000);
  if (moored.kind !== 'mod_bridge_segment') fail('MOD: the shore segment was refused ' + JSON.stringify(moored));

  D.msgs = D.msgs.filter((m) => m.t !== 'mod' && m.t !== 'modfail');
  D.send({ t: 'buildmod', i: farI, kind: 'mod_bridge_segment', slot: 'floor', seq: 12 });
  const spanned = await D.wait('mod', 3000);
  if (spanned.i !== farI) fail('MOD: the second segment did not moor to the first');

  // cut it at the shore: the far segment must go with it
  warp(D, (nearI % SIZE) + 0.5, ((nearI / SIZE) | 0) + 0.5); await sleep(120);
  // a swing takes the nearest creature or animal first, and the shore is exactly
  // where fish and crabs live, so allow for a few swings being spent on them
  D.msgs = D.msgs.filter((m) => m.t !== 'modd' && m.t !== 'act');
  for (let h = 0; h < 30 && D.msgs.filter((m) => m.t === 'modd').length < 2; h++) {
    D.send({ t: 'atk' }); await sleep(450);
  }
  const fell = D.msgs.filter((m) => m.t === 'modd').map((m) => m.i);
  if (!fell.includes(nearI) || !fell.includes(farI)) {
    const wildlife = D.msgs.filter((m) => m.t === 'act' && m.targetI).length;
    fail(`MOD: cutting the span left part of it afloat — modd for ${JSON.stringify(fell)} ` +
      `(${wildlife} of the swings landed on wildlife)`);
  }
  console.log('MOD bridge OK: unmoored refused, span built from the shore, cut span fell in whole');
}

D.send({ t: 'devcmd', cmd: 'clearcre' });
await sleep(300);
D.ws.close();
A.ws.close();
B.ws.close();
console.log('DEVOK stage complete: every devcmd exercised on the granted path');

// --- Stage ADMIT: one live session per identity, and the player cap ---
// Last, because it deliberately fills the room. Every earlier stage has closed its
// sockets by now; give the server a moment to reap them so the cap arithmetic below
// starts from an empty world.
await sleep(600);
{
  const CAP = 4;                       // the default in §11.4; the stack runs unconfigured

  // Two tickets, one userId — what a duplicated browser tab produces.
  const DUP = 'u_gotest_dup' + Math.random().toString(36).slice(2, 8);
  const P1 = await mintedClient('DupTab', false, { userId: DUP });
  const init1 = await P1.wait('init', 8000);
  const P2 = await mintedClient('DupTab', false, { userId: DUP });
  const init2 = await P2.wait('init', 8000);

  // The first session is told why before it is closed — not left to guess.
  const kick = await P1.wait('kick', 3000);
  if (kick.reason !== 'replaced') fail(`ADMIT: kick.reason = ${kick.reason}, want 'replaced'`);
  for (let i = 0; i < 40 && !P1.closed; i++) await sleep(50);
  if (!P1.closed) fail('ADMIT: the replaced session was kicked but its socket stayed open');
  if (init2.id === init1.id) fail('ADMIT: the replacement reused the evicted session id');

  // ...and the room holds ONE copy of that player, not two. A fresh observer sees
  // the authoritative roster.
  const OBS = await mintedClient('Observer', false);
  const initObs = await OBS.wait('init', 8000);
  const roster = initObs.players.map((q) => q.id);
  if (roster.length !== 1 || roster[0] !== init2.id)
    fail(`ADMIT: the room reports players ${JSON.stringify(roster)}, want exactly [${init2.id}] — the duplicate was not evicted`);
  console.log('ADMIT takeover OK: the duplicate tab replaced the session instead of cloning the player');

  // The cap. Two seats are taken (P2 + OBS); fill the rest, then the next one is refused.
  const live = [P2, OBS];
  while (live.length < CAP) {
    const c = await mintedClient('Filler' + live.length, false);
    await c.wait('init', 8000);
    live.push(c);
  }
  const fifth = await mintedClient('Fifth', false, { allowAuthFail: true });
  const af = await fifth.wait('authfail', 5000);
  if (af.reason !== 'room-full') fail(`ADMIT: the ${CAP + 1}th player got authfail '${af.reason}', want 'room-full'`);
  if (fifth.msgs.some((m) => m.t === 'init')) fail('ADMIT: a refused client was sent init');
  if (fifth.chunks !== 0) fail(`ADMIT: a refused client was sent ${fifth.chunks} chunks`);
  fifth.ws.close();
  console.log(`ADMIT cap OK: player ${CAP + 1} refused with authfail room-full, before any world data`);

  // A player already holding one of the ${CAP} seats can still reconnect: takeover is
  // resolved BEFORE the cap, or a crash would lock them out of their own world.
  const seated = live[0];              // P2, the session that took the duplicate's place
  const RE = await mintedClient('DupTab', false, { userId: DUP, allowAuthFail: true });
  const initRe = await RE.wait('init', 8000);
  if (RE.msgs.some((m) => m.t === 'authfail'))
    fail('ADMIT: reconnecting into a full room was refused — takeover must be resolved before the cap');
  const kick2 = await seated.wait('kick', 3000);
  if (kick2.reason !== 'replaced') fail(`ADMIT: kick.reason = ${kick2.reason}, want 'replaced'`);
  if (initRe.players.length !== CAP - 1)
    fail(`ADMIT: after the takeover the room reports ${initRe.players.length} others, want ${CAP - 1} — the seat was not replaced`);
  console.log('ADMIT takeover-into-a-full-room OK: the seat was replaced, not counted twice');

  for (const c of live) c.ws.close();
  P1.ws.close();
  RE.ws.close();
  await sleep(300);
}

console.log(`chunks streamed to A: ${A.chunks}`);
console.log('ALL TESTS PASSED');
process.exit(0);
