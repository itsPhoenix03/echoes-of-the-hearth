// End-to-end smoke test for the Go game server (Slice 1).
//
// This script starts NOTHING. It connects to an already-running control plane
// and Go game server, walks the real join path, and proves that the terrain the
// Go server streams is the same terrain shared/world.js generates.
//
//   Terminal 1:  node control/index.js
//   Terminal 2:  cd gameserver && HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd
//   Terminal 3:  node gameserver/smoke.mjs
//
// On Windows PowerShell, terminal 2 is:
//   $env:HEARTH_ALLOW_WARP=1; go run ./cmd/hearthd
//
// Env overrides: HEARTH_CONTROL_URL (default http://localhost:8090),
// HEARTH_WS (default whatever /api/join returns), HEARTH_SEED (default hearth-1).
//
// Exit code 0 means every assertion passed.

import WebSocket from 'ws';
import { genWorld, findSpawn, SIZE, WORLD_VERSION } from '../shared/world.js';

const CONTROL = process.env.HEARTH_CONTROL_URL || 'http://localhost:8090';
const SEED = process.env.HEARTH_SEED || 'hearth-1';
const CHUNK = 64;
const GRID = SIZE / CHUNK;
const RADIUS = 2;

let failures = 0;
const ok = (cond, what) => {
  if (cond) { console.log(`  ok   ${what}`); return true; }
  console.error(`  FAIL ${what}`);
  failures++;
  return false;
};
const die = (msg) => { console.error(`\n${msg}`); process.exit(1); };

// --- RLE decode, mirroring docs/10_GO_WIRE_PROTOCOL.md §4.3 ---------------
function decodeRLE(b64, want) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length % 2 !== 0) throw new Error(`odd RLE length ${raw.length}`);
  const out = Buffer.alloc(want);
  let n = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const value = raw[i], run = raw[i + 1];
    if (run === 0) throw new Error('zero-length run');
    if (n + run > want) throw new Error(`RLE overruns ${want} bytes`);
    out.fill(value, n, n + run);
    n += run;
  }
  if (n !== want) throw new Error(`RLE decoded ${n} bytes, want ${want}`);
  return out;
}

// A Reader attaches ONE permanent message listener at connect time. This
// matters: ws emits every frame in a single TCP read synchronously, so a
// listener attached between two awaits silently misses whatever arrived in the
// same batch. Everything is buffered here instead and matched off the buffer.
function reader(ws) {
  const msgs = [];
  const chunks = new Map();
  let closed = false;
  let wake = null;
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    msgs.push(m);
    if (m.t === 'chunk') chunks.set(`${m.cx},${m.cy}`, m);
    if (wake) { const w = wake; wake = null; w(); }
  });
  ws.on('close', () => { closed = true; if (wake) { const w = wake; wake = null; w(); } });

  let cursor = 0;
  const tick = () => new Promise((res) => {
    wake = res;
    setTimeout(() => { if (wake === res) { wake = null; res(); } }, 25);
  });

  return {
    msgs, chunks,
    get closed() { return closed; },
    // next returns the first buffered message after the cursor matching pred,
    // advancing the cursor past it.
    async next(pred, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < msgs.length) {
          const m = msgs[cursor++];
          if (pred(m)) return m;
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for a matching message');
        if (closed) throw new Error('socket closed while waiting');
        await tick();
      }
    },
    // waitState polls a predicate over accumulated state.
    async waitState(fn, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (!fn()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for a state condition');
        if (closed) throw new Error('socket closed while waiting');
        await tick();
      }
    },
    skipToEnd() { cursor = msgs.length; },
  };
}

function connect(url, ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const rx = reader(ws);
    const timer = setTimeout(() => reject(new Error('websocket did not open in 5s')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      if (ticket !== undefined) ws.send(JSON.stringify({ t: 'auth', ticket }));
      resolve({ ws, rx });
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function join(name) {
  const res = await fetch(`${CONTROL}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, tok: 'smoke-' + Math.random().toString(36).slice(2, 10) }),
  });
  if (!res.ok) die(`control plane /api/join returned ${res.status} — is 'node control/index.js' running on ${CONTROL}?`);
  return res.json();
}

async function main() {
  console.log(`[smoke] generating ${SEED} locally with shared/world.js ...`);
  const world = genWorld(SEED);
  const spawn = findSpawn(world);
  console.log(`[smoke] local spawn is (${spawn[0]}, ${spawn[1]})`);

  // --- 1. a garbage ticket must be refused before any world data ----------
  console.log('\n[smoke] rejecting a forged ticket');
  {
    const { ws: wsURL } = await join('Forger');
    const { ws, rx } = await connect(process.env.HEARTH_WS || wsURL, 'bogus.ticket');
    const m = await rx.next((x) => x.t === 'authfail' || x.t === 'init' || x.t === 'chunk', 5000);
    ok(m.t === 'authfail', `forged ticket answered with authfail (reason: ${m.reason})`);
    ok(!rx.msgs.some((x) => x.t === 'init' || x.t === 'chunk'), 'no init and no terrain sent before a valid ticket');
    ws.close();
  }

  // --- 2. the real join path ----------------------------------------------
  console.log('\n[smoke] joining for real');
  const { ticket, ws: wsURL, name } = await join('SmokeTester');
  ok(typeof ticket === 'string' && ticket.includes('.'), 'control plane issued a ticket');

  const { ws, rx } = await connect(process.env.HEARTH_WS || wsURL, ticket);
  const chunks = rx.chunks;

  const init = await rx.next((m) => m.t === 'init');
  console.log(`  init: id=${init.id} name=${init.name} at (${init.x}, ${init.y}, z${init.z})`);
  ok(init.seed === SEED, `init.seed is ${SEED}`);
  ok(init.size === SIZE, `init.size is ${SIZE}`);
  ok(init.chunk === CHUNK, `init.chunk is ${CHUNK}`);
  ok(init.worldVersion === WORLD_VERSION, `init.worldVersion is ${WORLD_VERSION}`);
  ok(init.x === spawn[0] && init.y === spawn[1], 'init position is the authoritative findSpawn tile');
  ok(init.name === name, 'init.name came from the ticket, not from the client');
  ok(Array.isArray(init.players), 'init carries a players array');
  ok(typeof init.time === 'number', 'init carries the day/night time');
  ok(init.tiles === undefined && init.elev === undefined, 'init carries no terrain (terrain arrives as chunks)');

  // --- 3. the chunk push ---------------------------------------------------
  const cx0 = Math.floor(init.x / CHUNK), cy0 = Math.floor(init.y / CHUNK);
  const expected = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++)
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx >= 0 && cy >= 0 && cx < GRID && cy < GRID) expected.push(`${cx},${cy}`);
    }
  console.log(`\n[smoke] waiting for ${expected.length} chunks around (${cx0}, ${cy0})`);
  await rx.waitState(() => expected.every((k) => chunks.has(k)));
  ok(true, `received all ${expected.length} chunks within Chebyshev radius ${RADIUS}`);
  ok(chunks.size === expected.length, `received exactly ${expected.length} chunks, no extras`);

  // --- 4. the actual proof: decoded terrain === genWorld('hearth-1') -------
  console.log('\n[smoke] decoding chunks and comparing against shared/world.js');
  const LAYERS = [['tiles', world.tiles], ['elev', world.elev], ['veins', world.veins],
                  ['waterTemp', world.waterTemp], ['tileVis', world.tileVis]];
  let sampled = 0, mismatches = 0;
  let totalB64 = 0;
  for (const key of expected) {
    const m = chunks.get(key);
    for (const [layerName, expectArr] of LAYERS) {
      totalB64 += m[layerName].length;
      let decoded;
      try {
        decoded = decodeRLE(m[layerName], CHUNK * CHUNK);
      } catch (e) {
        console.error(`  FAIL chunk ${key} layer ${layerName}: ${e.message}`);
        failures++;
        continue;
      }
      // Sample: the four corners, the centre, and 60 pseudo-random indices.
      const idxs = [0, 63, 4032, 4095, 2080];
      for (let n = 0; n < 60; n++) idxs.push((n * 977 + 13) % 4096);
      for (const local of idxs) {
        const wx = m.cx * CHUNK + (local % CHUNK);
        const wy = m.cy * CHUNK + Math.floor(local / CHUNK);
        sampled++;
        if (decoded[local] !== expectArr[wy * SIZE + wx]) {
          if (mismatches < 5) console.error(`  FAIL chunk ${key} ${layerName} local ${local} -> world (${wx},${wy}): got ${decoded[local]}, want ${expectArr[wy * SIZE + wx]}`);
          mismatches++;
        }
      }
    }
  }
  ok(mismatches === 0, `${sampled} sampled tiles across 5 layers x ${expected.length} chunks match genWorld('${SEED}')`);

  // Sparse overlays must map back to the same world too.
  let nodeChecks = 0, nodeBad = 0;
  for (const key of expected) {
    const m = chunks.get(key);
    for (const [local, kind] of (m.nodes || [])) {
      const wx = m.cx * CHUNK + (local % CHUNK);
      const wy = m.cy * CHUNK + Math.floor(local / CHUNK);
      nodeChecks++;
      if (world.nodes.get(wy * SIZE + wx) !== kind) nodeBad++;
    }
    for (const local of (m.bergs || [])) {
      const wx = m.cx * CHUNK + (local % CHUNK);
      const wy = m.cy * CHUNK + Math.floor(local / CHUNK);
      nodeChecks++;
      if (!world.bergs.has(wy * SIZE + wx)) nodeBad++;
    }
    for (const [local, dkey] of (m.decor || [])) {
      const wx = m.cx * CHUNK + (local % CHUNK);
      const wy = m.cy * CHUNK + Math.floor(local / CHUNK);
      nodeChecks++;
      if (world.decor.get(wy * SIZE + wx) !== dkey) nodeBad++;
    }
  }
  ok(nodeBad === 0, `${nodeChecks} streamed nodes/decor/bergs match the generated world`);
  console.log(`  info base64 payload for the ${expected.length}-chunk join burst: ${(totalB64 / 1024).toFixed(1)} KiB ` +
              `(raw would be ${((expected.length * 5 * 4096) / 1024).toFixed(1)} KiB)`);

  // --- 5. movement --------------------------------------------------------
  console.log('\n[smoke] movement');
  {
    const step = { t: 'pos', x: init.x + 1, y: init.y };
    rx.skipToEnd();
    ws.send(JSON.stringify(step));
    const m = await rx.next((x) => (x.t === 'pos' && x.id === init.id) || x.t === 'fix', 5000);
    ok(m.t === 'pos' && m.x === step.x, 'a one-tile step is accepted and relayed as pos');
  }
  {
    // 400 tiles in one frame: far past MAX_SPEED * SPEED_SLACK * dt + POS_SLACK.
    rx.skipToEnd();
    ws.send(JSON.stringify({ t: 'pos', x: init.x + 400, y: init.y }));
    const m = await rx.next((x) => x.t === 'fix' || (x.t === 'pos' && x.id === init.id && x.x > init.x + 100), 5000);
    ok(m.t === 'fix', 'a 400-tile teleport is rejected with a fix snapback');
  }
  {
    // The fix snapback is throttled to one per 250 ms per player, so wait past
    // the window or this rejection is silently coalesced with the last one.
    await new Promise((r) => setTimeout(r, 350));
    // A remote-mineshaft zAnchor attempt. With no structures placed there is no
    // anchor anywhere, so every layer change must be refused.
    rx.skipToEnd();
    ws.send(JSON.stringify({ t: 'pos', x: init.x, y: init.y, z: 1 }));
    const m = await rx.next((x) => x.t === 'fix' || (x.t === 'pos' && x.id === init.id && x.z === 1), 5000);
    ok(m.t === 'fix', 'a layer change with no mineshaft anchor is refused');
  }

  // --- 6. warp + streaming on a chunk-boundary crossing --------------------
  console.log('\n[smoke] warp and boundary streaming (needs HEARTH_ALLOW_WARP=1)');
  {
    // Warp far enough to land in a chunk we have not been sent.
    const target = expected.map((k) => k.split(',').map(Number));
    let tx = init.x, ty = init.y;
    outer:
    for (let cy = 0; cy < GRID; cy++)
      for (let cx = 0; cx < GRID; cx++)
        if (!target.some(([ax, ay]) => ax === cx && ay === cy) && Math.abs(cx - cx0) + Math.abs(cy - cy0) > 6) {
          tx = cx * CHUNK + 32; ty = cy * CHUNK + 32; break outer;
        }
    const before = chunks.size;
    rx.skipToEnd();
    ws.send(JSON.stringify({ t: 'warp', x: tx, y: ty }));
    let moved = false;
    try {
      await rx.next((m) => m.t === 'pos' && m.id === init.id && m.x === tx && m.y === ty, 4000);
      moved = true;
    } catch { /* warp disabled */ }
    if (!moved) {
      console.log('  skip warp did not take effect — start the server with HEARTH_ALLOW_WARP=1 to cover this');
    } else {
      ok(true, `warp to (${tx}, ${ty}) was applied and broadcast as pos`);
      await rx.waitState(() => chunks.size >= before + 20, 8000).catch(() => {});
      ok(chunks.size > before, `crossing into a new chunk streamed ${chunks.size - before} further chunks`);
      // And the newly streamed terrain must still be the real world.
      const nk = `${Math.floor(tx / CHUNK)},${Math.floor(ty / CHUNK)}`;
      const nm = chunks.get(nk);
      if (ok(!!nm, `the destination chunk ${nk} arrived`)) {
        const tiles = decodeRLE(nm.tiles, CHUNK * CHUNK);
        const local = (ty % CHUNK) * CHUNK + (tx % CHUNK);
        ok(tiles[local] === world.tiles[ty * SIZE + tx], 'the destination tile matches genWorld');
      }
    }
  }

  ws.close();
  console.log(failures === 0 ? '\n[smoke] PASS — the streamed terrain is the real world.' : `\n[smoke] FAILED: ${failures} assertion(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => die(`[smoke] error: ${e.stack || e.message}`));
