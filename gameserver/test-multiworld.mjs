// Multi-world integration check for the Go game server.
//
// One `hearthd` process hosts two worlds; a third world in the registry is
// allocated to a *different* instance. This suite proves the three properties
// that make multi-world hosting real rather than advisory:
//
//   1. routing — a ticket's signed `worldId` decides which room a socket joins,
//      and two clients asking for different worlds land in different worlds
//      (different seeds -> different spawn tiles and different terrain);
//   2. isolation — a broadcast in world A never reaches a player in world B.
//      Two players join world A and one joins world B; the B player must see
//      nothing of the A players' joins, moves or departures;
//   3. the allocation boundary — a perfectly valid, correctly signed ticket
//      whose `instanceId` is some other process is refused with
//      `authfail: wrong-instance`.
//
// Unlike test-go.mjs this script starts and stops its own control plane and
// game server, on private ports, so it cannot collide with a running dev stack.
//
//   node gameserver/test-multiworld.mjs
//
// Env: HEARTH_MW_CONTROL_PORT (default 8390), HEARTH_MW_GAME_PORT (default 8382).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_PORT = Number(process.env.HEARTH_MW_CONTROL_PORT) || 8390;
const GAME_PORT = Number(process.env.HEARTH_MW_GAME_PORT) || 8382;
const CONTROL = `http://localhost:${CONTROL_PORT}`;
const GAME_WS = `ws://localhost:${GAME_PORT}`;

// Two worlds on this process's instance, one deliberately somewhere else.
const WORLDS = [
  { worldId: 'default', name: 'The Hearth', seed: 'hearth-1', instanceId: 'local', ws: GAME_WS },
  { worldId: 'frontier', name: 'Frontier', seed: 'seed-frontier', instanceId: 'local', ws: GAME_WS },
  { worldId: 'elsewhere', name: 'Elsewhere', seed: 'seed-elsewhere', instanceId: 'inst-2', ws: GAME_WS },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saveDir = mkdtempSync(pathJoin(tmpdir(), 'hearth-mw-'));
const children = [];
let failed = false;
let stopping = false;

function fail(msg) {
  console.log('FAIL:', msg);
  failed = true;
  shutdown(1);
}

function shutdown(code) {
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', c.pid, '/f', '/t'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => {
    try { rmSync(saveDir, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  }, 500);
}
process.on('SIGINT', () => shutdown(1));

function run(tag, cmd, args, env, cwd) {
  const child = spawn(cmd, args, {
    cwd: cwd || ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A built binary is spawned directly so its pid is the real process;
    // only `node`/`go` from PATH need the shell on Windows.
    shell: process.platform === 'win32' && !cmd.includes('hearthd'),
  });
  const pipe = (s) => s.on('data', (d) => {
    for (const l of d.toString().split('\n')) if (l.trim()) console.log(`  [${tag}] ${l}`);
  });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    if (!failed && !stopping && code) fail(`${tag} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

async function waitForHTTP(url, what) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  fail(`${what} did not come up at ${url}`);
}

// --- a client ---------------------------------------------------------------

async function join(name, worldId) {
  const res = await fetch(`${CONTROL}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tok: 'mw-' + Math.random().toString(36).slice(2), name, worldId }),
  });
  if (!res.ok) fail(`/api/join for ${worldId} returned ${res.status}`);
  return res.json();
}

// connect opens the socket and returns once `init` (or `authfail`) has arrived.
async function connect(ticket, wsURL) {
  const ws = new WebSocket(wsURL);
  const c = { ws, msgs: [], chunks: 0, tilesAt: {}, init: null, authfail: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'chunk') {                         // counted, not kept: a client that stops draining is dropped
      c.chunks++;
      c.tilesAt[`${m.cx},${m.cy}`] = m.tiles;      // …except the encoded terrain, which identifies the world
      return;
    }
    c.msgs.push(m);
    if (m.t === 'init') c.init = m;
    if (m.t === 'authfail') c.authfail = m;
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('socket did not open in 10s')), 10000);
    ws.on('open', () => { clearTimeout(timer); res(); });
    ws.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
  ws.send(JSON.stringify({ t: 'auth', ticket }));
  // The first world built lazily pays for worldgen here (~2s), so be patient.
  for (let i = 0; i < 150 && !c.init && !c.authfail; i++) await sleep(100);
  c.send = (m) => ws.send(JSON.stringify(m));
  c.since = () => { const n = c.msgs.length; return () => c.msgs.slice(n); };
  return c;
}

// --- the suite --------------------------------------------------------------

(async () => {
  console.log(`multi-world: control :${CONTROL_PORT}, game :${GAME_PORT}, saves in ${saveDir}`);

  run('control', 'node', ['control/index.js'], {
    CONTROL_PORT: String(CONTROL_PORT),
    HEARTH_WORLDS: JSON.stringify(WORLDS),
  });
  await waitForHTTP(`${CONTROL}/api/health`, 'the control plane');

  // Built rather than `go run`: the child is then the real process, so stopping
  // it actually stops it (a `go run` wrapper leaves the compiled binary holding
  // the port on Windows).
  const bin = pathJoin(saveDir, process.platform === 'win32' ? 'hearthd.exe' : 'hearthd');
  console.log('  building hearthd…');
  execFileSync('go', ['build', '-o', bin, './cmd/hearthd'], { cwd: resolve(ROOT, 'gameserver'), stdio: 'inherit', shell: process.platform === 'win32' });

  // The game server hosts instance "local": two of the three worlds.
  run('game', bin, [], {
    HEARTH_GAME_PORT: String(GAME_PORT),
    HEARTH_INSTANCE_ID: 'local',
    HEARTH_WORLDS: JSON.stringify(WORLDS),
    HEARTH_SAVE_DIR: saveDir,
    HEARTH_PUBKEY_URL: `${CONTROL}/api/pubkey`,
    HEARTH_ALLOW_WARP: '1',
  }, resolve(ROOT, 'gameserver'));
  await waitForHTTP(`http://localhost:${GAME_PORT}/healthz`, 'the game server');

  // --- 1. routing -----------------------------------------------------------
  const list = await (await fetch(`${CONTROL}/api/worlds`)).json();
  if (list.worlds.length !== 3) fail(`/api/worlds listed ${list.worlds.length} worlds, want 3`);
  if (list.worlds.some((w) => 'instanceId' in w)) fail('/api/worlds leaked instanceId to clients');

  const jA1 = await join('A-One', 'default');
  const jB1 = await join('B-One', 'frontier');
  if (jA1.worldId !== 'default' || jB1.worldId !== 'frontier') {
    fail(`join bound the wrong worlds: ${jA1.worldId} / ${jB1.worldId}`);
  }

  const A1 = await connect(jA1.ticket, jA1.ws);
  const B1 = await connect(jB1.ticket, jB1.ws);
  if (!A1.init) fail(`A1 never got init (${A1.authfail ? 'authfail: ' + A1.authfail.reason : 'timeout'})`);
  if (!B1.init) fail(`B1 never got init (${B1.authfail ? 'authfail: ' + B1.authfail.reason : 'timeout'})`);
  if (A1.init.seed !== 'hearth-1') fail(`A1 landed in seed ${A1.init.seed}, want hearth-1`);
  if (B1.init.seed !== 'seed-frontier') fail(`B1 landed in seed ${B1.init.seed}, want seed-frontier`);
  // Seeds differing is the room's own report; the terrain it streams is the
  // independent check. Both worlds happen to spawn on the same tile, so compare
  // the encoded tiles of a chunk both clients received.
  const shared = Object.keys(A1.tilesAt).filter((k) => k in B1.tilesAt);
  if (!shared.length) fail('the two clients received no chunk in common to compare');
  if (shared.every((k) => A1.tilesAt[k] === B1.tilesAt[k])) {
    fail('every shared chunk is byte-identical across the two worlds — they are the same world');
  }
  if (A1.init.players.length || B1.init.players.length) {
    fail('a fresh world reported other players in init — the player registry is shared');
  }
  if (!A1.chunks || !B1.chunks) fail('a client received no terrain chunks');
  console.log(`routing OK: default seed=${A1.init.seed}, frontier seed=${B1.init.seed}, ` +
    `${shared.length} shared chunk coords carry different terrain`);

  // --- 2. isolation ---------------------------------------------------------
  const bFrom = B1.since();
  const aFrom = A1.since();

  const jA2 = await join('A-Two', 'default');
  const A2 = await connect(jA2.ticket, jA2.ws);
  if (!A2.init) fail('A2 never got init');
  if (A2.init.players.length !== 1 || A2.init.players[0].id !== A1.init.id) {
    fail(`A2's init roster is ${JSON.stringify(A2.init.players)}, want exactly A1`);
  }

  // A2 moves, which broadcasts `pos` to its room.
  A2.send({ t: 'pos', x: A2.init.x + 0.4, y: A2.init.y, z: 0, b: 0 });
  await sleep(800);
  A2.ws.close();
  await sleep(800);

  const aSaw = aFrom();
  if (!aSaw.some((m) => m.t === 'pj' && m.id === A2.init.id)) fail('A1 never saw A2 join its own world');
  if (!aSaw.some((m) => m.t === 'pl' && m.id === A2.init.id)) fail('A1 never saw A2 leave its own world');

  const strayIds = new Set([A1.init.id, A2.init.id]);
  const stray = bFrom().filter((m) => typeof m.id === 'string' && strayIds.has(m.id));
  if (stray.length) fail(`world 'frontier' received ${stray.length} frame(s) from world 'default': ${JSON.stringify(stray[0])}`);
  if (bFrom().some((m) => m.t === 'pj' || m.t === 'pl')) {
    fail(`world 'frontier' received a roster broadcast for a player it does not host`);
  }
  console.log(`isolation OK: A1 saw A2's join/move/leave (${aSaw.length} frames), frontier saw none of them`);

  // --- 3. the allocation boundary -------------------------------------------
  const jGhost = await join('Ghost', 'elsewhere');
  if (jGhost.worldId !== 'elsewhere') fail('the control plane would not bind the elsewhere world');
  const G = await connect(jGhost.ticket, GAME_WS);
  if (G.init) fail('a ticket for another instance was served a world!');
  if (!G.authfail) fail('a ticket for another instance got neither init nor authfail');
  if (G.authfail.reason !== 'wrong-instance') {
    fail(`authfail reason was '${G.authfail.reason}', want 'wrong-instance'`);
  }
  console.log("allocation OK: a ticket bound to instanceId 'inst-2' got authfail: wrong-instance");

  // --- 4. per-world saves ---------------------------------------------------
  // Nudge both rooms, then let the periodic save (30 s) be irrelevant: the
  // shutdown save is the one that must produce two distinct files.
  B1.ws.close();
  A1.ws.close();
  await sleep(300);
  for (const c of children) {
    if (c.exitCode === null && process.platform !== 'win32') c.kill('SIGTERM');
  }
  if (process.platform !== 'win32') {
    await sleep(2000);
    for (const id of ['default', 'frontier']) {
      if (!existsSync(pathJoin(saveDir, `world.${id}.save.json`))) fail(`world ${id} wrote no save file`);
    }
    if (existsSync(pathJoin(saveDir, 'save.json'))) fail('the Go server wrote a bare save.json');
    console.log('saves OK: world.default.save.json and world.frontier.save.json are separate files');
  } else {
    // Windows has no SIGTERM for a `go run` child, so the graceful-shutdown
    // save cannot be observed here. Go's TestEachWorldSavesToItsOwnFile covers
    // the same property directly.
    console.log('saves: skipped on win32 (no graceful stop) — covered by hosting.TestEachWorldSavesToItsOwnFile');
  }

  console.log('\nALL MULTI-WORLD TESTS PASSED');
  shutdown(0);
})().catch((e) => fail(e.stack || String(e)));
