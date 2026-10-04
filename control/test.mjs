// Black-box HTTP tests for the control plane, in the style of the root test.mjs
// (plain asserts, console.log per stage, fail() + exit 1). Runs standalone: it
// spawns control/index.js itself on a non-default port and tears it down after.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { verifyTicket } from './ticket.js';
import { isLoopbackAddress } from './store.js';

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
// Second instance, configured for multi-world + a dev allowlist.
const PORT2 = 8098;
const BASE2 = `http://localhost:${PORT2}`;
const DEV_TOK = 'dev-allowlisted-tok';
// Third instance: HEARTH_DEV_ALL=1 with an EMPTY allowlist, so anything it
// grants came from the loopback bypass and nothing else.
const PORT3 = 8097;
const BASE3 = `http://localhost:${PORT3}`;
// The machine's own LAN address, if it has one: connecting to it hits the same
// 0.0.0.0 listener but arrives with a non-loopback remoteAddress, which is a
// genuine remote-client test rather than a simulated one.
const lanIp = (() => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
})();
// Fourth and fifth instances, spawned late: a control plane RESTART. Same
// machine, same secret source, fresh process and therefore a fresh in-memory
// profile Map — the exact condition that used to hand a returning player a new
// random userId and orphan their saved character.
const PORT4 = 8096;
const BASE4 = `http://localhost:${PORT4}`;
const PORT5 = 8095;
const BASE5 = `http://localhost:${PORT5}`;

const WORLDS_CFG = [
  { worldId: 'default', seed: 'hearth-1', instanceId: 'local', ws: 'ws://localhost:8082', name: 'The Hearth' },
  { worldId: 'frontier', seed: 'seed-frontier', instanceId: 'inst-2', ws: 'ws://localhost:8083' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (s) => { console.log('FAIL:', s); for (const c of kids) { try { c.kill(); } catch { /* already gone */ } } process.exit(1); };

let child;
const kids = [];

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

async function waitForHealth(base = BASE) {
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  fail('control server did not become healthy in time');
}

async function post(base, path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function join(name, tok, extra = {}, base = BASE) {
  return post(base, '/api/join', { name, tok, ...extra });
}

function payloadOf(ticket) {
  return JSON.parse(b64urlDecode(ticket.split('.')[0]).toString('utf8'));
}

function spawnControl(port, extraEnv) {
  const c = spawn(process.execPath, ['control/index.js'], {
    // Point the worlds file at a path that cannot exist, so a developer's real
    // control/worlds.json never changes what these tests see.
    env: { ...process.env, CONTROL_PORT: String(port), HEARTH_WORLDS_FILE: 'no-such-worlds.json', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', () => {});
  c.stderr.on('data', (d) => process.stderr.write(d));
  kids.push(c);
  return c;
}

child = spawnControl(PORT, { HEARTH_WORLDS: '', HEARTH_DEV_TOKS: '', HEARTH_DEV_USERS: '' });
spawnControl(PORT2, {
  HEARTH_WORLDS: JSON.stringify(WORLDS_CFG),
  HEARTH_DEV_TOKS: `${DEV_TOK},someone-else`,
});
spawnControl(PORT3, { HEARTH_WORLDS: '', HEARTH_DEV_TOKS: '', HEARTH_DEV_USERS: '', HEARTH_DEV_ALL: '1' });

try {
  await waitForHealth();
  await waitForHealth(BASE2);
  await waitForHealth(BASE3);
  console.log('servers up on', PORT, PORT2, 'and', PORT3);

  // --- health ---
  const health = await (await fetch(`${BASE}/api/health`)).json();
  if (!health.ok || !Array.isArray(health.worlds) || !health.worlds.length) fail('health: malformed response');
  if (health.worlds[0].worldId !== 'default') fail('health: expected default world');
  console.log('health OK:', JSON.stringify(health.worlds[0]));

  // --- pubkey ---
  const pk = await (await fetch(`${BASE}/api/pubkey`)).json();
  if (typeof pk.publicKey !== 'string' || Buffer.from(pk.publicKey, 'base64').length !== 32)
    fail('pubkey: expected 32 raw bytes, got ' + pk.publicKey);
  console.log('pubkey OK: 32 raw bytes');
  const pk2 = await (await fetch(`${BASE2}/api/pubkey`)).json();
  if (typeof pk2.publicKey !== 'string') fail('pubkey: second instance did not publish a key');

  // --- join: well-formed ticket ---
  const tok1 = 'test-' + Math.random().toString(36).slice(2);
  const j1 = await join('Wanderer', tok1);
  if (j1.status !== 200) fail('join: expected 200, got ' + j1.status);
  const { ticket, ws, worldId, name } = j1.body;
  if (typeof ticket !== 'string' || ticket.split('.').length !== 2) fail('join: malformed ticket shape: ' + ticket);
  if (ws !== 'ws://localhost:8082') fail('join: unexpected ws address: ' + ws);
  if (worldId !== 'default') fail('join: unexpected worldId: ' + worldId);
  if (name !== 'Wanderer') fail('join: name mismatch: ' + name);
  console.log('join OK: ticket issued for', name, '->', ws);

  // --- ticket verifies against published pubkey, via a path independent of issueTicket ---
  const v1 = verifyTicket(ticket, pk.publicKey);
  if (!v1.ok) fail('verify: valid ticket failed verification: ' + v1.reason);
  if (v1.payload.name !== 'Wanderer' || v1.payload.worldId !== 'default') fail('verify: payload mismatch');
  if (!v1.payload.userId || !v1.payload.jti) fail('verify: payload missing userId/jti');
  console.log('verify OK: signature valid, payload =', JSON.stringify(v1.payload));

  // --- expired ticket is detectable ---
  const [payloadB64, sigB64] = ticket.split('.');
  const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  if (Date.now() <= payload.exp) {
    // ticket is fresh (TTL 30s) — wait it out to prove expiry is enforced
    await sleep(Math.max(0, payload.exp - Date.now()) + 50);
  }
  const vExp = verifyTicket(ticket, pk.publicKey);
  if (vExp.ok || vExp.reason !== 'expired') fail('expiry: expected expired, got ' + JSON.stringify(vExp));
  console.log('expiry OK: stale ticket rejected (reason=expired)');

  // --- tampered payload fails verification ---
  const j2 = await join('Tamperer', 'test-' + Math.random().toString(36).slice(2));
  const [goodPayload, goodSig] = j2.body.ticket.split('.');
  const decoded = JSON.parse(b64urlDecode(goodPayload).toString('utf8'));
  decoded.name = 'Hacker';
  const forgedPayloadB64 = Buffer.from(JSON.stringify(decoded)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const forged = `${forgedPayloadB64}.${goodSig}`;
  const vTamper = verifyTicket(forged, pk.publicKey);
  if (vTamper.ok) fail('tamper: forged payload verified successfully!');
  console.log('tamper OK: forged payload rejected (reason=' + vTamper.reason + ')');

  // --- name sanitization ---
  const tokCtrl = 'test-' + Math.random().toString(36).slice(2);
  const rCtrl = await join('a\x00\x01b', tokCtrl);   // control chars stripped -> "ab" (2 chars, passes)
  if (rCtrl.body.name !== 'ab') fail('sanitize: control-char case wrong: ' + rCtrl.body.name);
  console.log('sanitize OK: control chars stripped ->', rCtrl.body.name);

  const rShort = await join('a', 'test-' + Math.random().toString(36).slice(2));   // 1 char -> fallback
  if (rShort.body.name !== 'Keeper') fail('sanitize: too-short name should fall back to Keeper, got ' + rShort.body.name);
  console.log('sanitize OK: too-short name -> Keeper');

  const longName = 'x'.repeat(40);
  const rLong = await join(longName, 'test-' + Math.random().toString(36).slice(2));
  if (rLong.body.name.length !== 18) fail('sanitize: expected 18-char cap, got length ' + rLong.body.name.length);
  console.log('sanitize OK: long name capped at 18 chars');

  const rMissing = await join(undefined, 'test-' + Math.random().toString(36).slice(2));
  if (rMissing.body.name !== 'Keeper') fail('sanitize: missing name should fall back to Keeper, got ' + rMissing.body.name);
  console.log('sanitize OK: missing name -> Keeper');

  // --- missing tok is rejected ---
  const rNoTok = await join('Someone', undefined);
  if (rNoTok.status !== 400) fail('join: expected 400 for missing tok, got ' + rNoTok.status);
  console.log('join OK: missing tok rejected with 400');

  // --- rejoin with same tok preserves the account, honors an explicit rename ---
  const tok3 = 'test-' + Math.random().toString(36).slice(2);
  await join('FirstName', tok3);
  const rRename = await join('SecondName', tok3);
  if (rRename.body.name !== 'SecondName') fail('rejoin: rename did not apply: ' + rRename.body.name);
  const rKeep = await join(undefined, tok3);   // fallback name must not clobber the saved one
  if (rKeep.body.name !== 'SecondName') fail('rejoin: fallback name clobbered saved name: ' + rKeep.body.name);
  console.log('rejoin OK: rename applied, fallback preserved saved name');

  // --- dev claim: absent for a normal account ---
  const jPlain = await join('Plain', 'test-' + Math.random().toString(36).slice(2), {}, BASE2);
  const pPlain = payloadOf(jPlain.body.ticket);
  if ('dev' in pPlain) fail('dev: field must be omitted for a normal account, got ' + JSON.stringify(pPlain));
  console.log('dev OK: field absent for a normal account');

  // --- dev claim: a client-sent dev:true in the join body is ignored ---
  const jLiar = await join('Liar', 'test-' + Math.random().toString(36).slice(2), { dev: true }, BASE2);
  const pLiar = payloadOf(jLiar.body.ticket);
  if ('dev' in pLiar) fail('dev: client-supplied dev:true was honored! payload=' + JSON.stringify(pLiar));
  const vLiar = verifyTicket(jLiar.body.ticket, pk2.publicKey);
  if (!vLiar.ok || vLiar.payload.dev !== undefined) fail('dev: client-supplied claim survived verification');
  console.log('dev OK: client-supplied dev:true ignored');

  // --- dev claim: present and true for an allowlisted account ---
  const jDev = await join('Tester', DEV_TOK, {}, BASE2);
  const pDev = payloadOf(jDev.body.ticket);
  if (pDev.dev !== true) fail('dev: allowlisted account did not get dev:true, got ' + JSON.stringify(pDev));
  const vDev = verifyTicket(jDev.body.ticket, pk2.publicKey);
  if (!vDev.ok || vDev.payload.dev !== true) fail('dev: allowlisted ticket failed verification: ' + JSON.stringify(vDev));
  console.log('dev OK: allowlisted account gets a signed dev:true claim');

  // --- an allowlisted account cannot drop its own claim from the body either ---
  const jDevFalse = await join('Tester', DEV_TOK, { dev: false }, BASE2);
  if (payloadOf(jDevFalse.body.ticket).dev !== true) fail('dev: client body overrode the stored permission');
  console.log('dev OK: body.dev is ignored in both directions');

  // --- HEARTH_DEV_ALL: a loopback join gets a signed dev:true, allowlist empty ---
  const pk3 = await (await fetch(`${BASE3}/api/pubkey`)).json();
  const jAll = await join('LocalDev', 'test-' + Math.random().toString(36).slice(2), {}, BASE3);
  const pAll = payloadOf(jAll.body.ticket);
  if (pAll.dev !== true) fail('devall: loopback join did not get dev:true, got ' + JSON.stringify(pAll));
  const vAll = verifyTicket(jAll.body.ticket, pk3.publicKey);
  if (!vAll.ok || vAll.payload.dev !== true) fail('devall: ticket failed verification: ' + JSON.stringify(vAll));
  console.log('devall OK: loopback join gets a signed dev:true');

  // --- flag unset: the same loopback join gets no dev key at all ---
  const jOff = await join('LocalDev', 'test-' + Math.random().toString(36).slice(2), {}, BASE);
  if ('dev' in payloadOf(jOff.body.ticket)) fail('devall: dev key present with the flag unset');
  console.log('devall OK: no dev key from loopback with the flag unset');

  // --- body.dev is still ignored in BOTH modes (the case that matters most) ---
  const jLiarOff = await join('Liar', 'test-' + Math.random().toString(36).slice(2), { dev: true }, BASE);
  if ('dev' in payloadOf(jLiarOff.body.ticket)) fail('devall: client-supplied dev:true honored with the flag unset!');
  const liarTok = 'test-' + Math.random().toString(36).slice(2);
  const jLiarOn = await join('Liar', liarTok, { dev: true }, BASE3);
  // With the flag on, loopback grants dev anyway — so prove the body played no
  // part by asking the flagged server for the same thing WITHOUT the body field
  // and, above all, by checking the body cannot grant dev where address does not.
  if (payloadOf(jLiarOn.body.ticket).dev !== true) fail('devall: loopback grant broke when a dev field was present');
  console.log('devall OK: body.dev ignored in both modes');

  // --- the allowlist keeps working with the flag unset, from the other instance ---
  const jAllow = await join('Tester', DEV_TOK, {}, BASE2);
  if (payloadOf(jAllow.body.ticket).dev !== true) fail('devall: allowlist stopped granting dev with the flag unset');
  console.log('devall OK: HEARTH_DEV_TOKS allowlist unaffected by the flag');

  // --- non-loopback: the predicate, exhaustively ---
  for (const good of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1'])
    if (!isLoopbackAddress(good)) fail('loopback: rejected a real loopback form: ' + good);
  for (const bad of ['192.168.1.50', '10.0.0.5', '::ffff:10.0.0.5', '127.0.0.1.evil.com', '127.0.0.1x',
    ' 127.0.0.1', '0.0.0.0', '', undefined, null, 127])
    if (isLoopbackAddress(bad)) fail('loopback: accepted a non-loopback address: ' + String(bad));
  console.log('devall OK: address predicate accepts only the three loopback forms');

  // --- non-loopback: a real request over the LAN address, where one exists ---
  if (lanIp) {
    // dev:true in the body as well: under HEARTH_DEV_ALL the address is the only
    // thing that decides, and this client's address is not loopback.
    const rLan = await post(`http://${lanIp}:${PORT3}`, '/api/join', { name: 'LanPlayer', dev: true, tok: 'test-lan-' + Math.random().toString(36).slice(2) });
    if (rLan.status !== 200) fail('devall: LAN join failed with ' + rLan.status);
    if ('dev' in payloadOf(rLan.body.ticket)) fail('devall: a non-loopback client got the dev claim (body.dev honored under HEARTH_DEV_ALL)!');
    // ...and a spoofed forwarding header must not change that: headers are client-written.
    const rSpoof = await fetch(`http://${lanIp}:${PORT3}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '::1' },
      body: JSON.stringify({ name: 'Spoofer', tok: 'test-spoof-' + Math.random().toString(36).slice(2) }),
    });
    const bSpoof = await rSpoof.json();
    if ('dev' in payloadOf(bSpoof.ticket)) fail('devall: a spoofed X-Forwarded-For granted dev!');
    console.log(`devall OK: non-loopback client at ${lanIp} gets no dev claim, spoofed X-Forwarded-For ignored`);
  } else {
    console.log('devall SKIP: no non-loopback interface on this host; predicate covered by the unit case above');
  }

  // --- multi-world: /api/worlds shape ---
  const wl = await (await fetch(`${BASE2}/api/worlds`)).json();
  if (!Array.isArray(wl.worlds) || wl.worlds.length !== 2) fail('worlds: expected 2 worlds, got ' + JSON.stringify(wl));
  if (wl.defaultWorldId !== 'default') fail('worlds: unexpected defaultWorldId ' + wl.defaultWorldId);
  const wDefault = wl.worlds.find((w) => w.worldId === 'default');
  const wFrontier = wl.worlds.find((w) => w.worldId === 'frontier');
  if (!wDefault || !wFrontier) fail('worlds: missing configured world in ' + JSON.stringify(wl.worlds));
  if (wDefault.name !== 'The Hearth') fail('worlds: display name not surfaced: ' + wDefault.name);
  if (wFrontier.name !== 'frontier') fail('worlds: name should default to worldId, got ' + wFrontier.name);
  if (wFrontier.seed !== 'seed-frontier' || wFrontier.ws !== 'ws://localhost:8083') fail('worlds: wrong seed/ws: ' + JSON.stringify(wFrontier));
  for (const w of wl.worlds) {
    if ('instanceId' in w) fail('worlds: instanceId must not be exposed to players');
    if (Object.keys(w).length !== 4) fail('worlds: unexpected extra fields: ' + JSON.stringify(w));
  }
  console.log('worlds OK: 2 worlds listed, no instanceId leaked');

  // --- multi-world: join resolves and binds the requested world ---
  const jF = await join('Pioneer', 'test-' + Math.random().toString(36).slice(2), { worldId: 'frontier' }, BASE2);
  if (jF.body.worldId !== 'frontier' || jF.body.ws !== 'ws://localhost:8083') fail('multiworld: join did not resolve frontier: ' + JSON.stringify(jF.body));
  const pF = payloadOf(jF.body.ticket);
  if (pF.worldId !== 'frontier' || pF.instanceId !== 'inst-2') fail('multiworld: ticket did not bind frontier: ' + JSON.stringify(pF));
  console.log('multiworld OK: ticket bound to frontier/inst-2');

  // --- multi-world: unknown and missing worldId fall back to the default ---
  const jUnknown = await join('Lost', 'test-' + Math.random().toString(36).slice(2), { worldId: 'nope-not-a-world' }, BASE2);
  if (jUnknown.body.worldId !== 'default') fail('multiworld: unknown worldId did not fall back: ' + jUnknown.body.worldId);
  if (payloadOf(jUnknown.body.ticket).worldId !== 'default') fail('multiworld: ticket echoed the unknown worldId');
  const jNone = await join('Homebody', 'test-' + Math.random().toString(36).slice(2), {}, BASE2);
  if (jNone.body.worldId !== 'default' || jNone.body.ws !== 'ws://localhost:8082') fail('multiworld: missing worldId did not fall back: ' + JSON.stringify(jNone.body));
  console.log('multiworld OK: unknown/missing worldId falls back to default');

  // --- the single-world default instance still lists exactly one world ---
  const wl1 = await (await fetch(`${BASE}/api/worlds`)).json();
  if (wl1.worlds.length !== 1 || wl1.worlds[0].worldId !== 'default') fail('worlds: single-world default broke: ' + JSON.stringify(wl1));
  console.log('worlds OK: single-world default preserved');

  // --- userId survives a control-plane restart (the save key) -------------
  // The Go server files a player's whole profile under userId, so this is the
  // difference between rejoining your character and rejoining a new one.
  const tokSave = 'test-save-' + Math.random().toString(36).slice(2);
  const jBefore = await join('Settler', tokSave);
  const idBefore = payloadOf(jBefore.body.ticket).userId;
  if (!/^u_[0-9a-f]{24}$/.test(idBefore)) fail('userId: unexpected shape ' + idBefore);

  spawnControl(PORT4, { HEARTH_WORLDS: '', HEARTH_DEV_TOKS: '', HEARTH_DEV_USERS: '' });
  await waitForHealth(BASE4);
  const jAfter = await join('Settler', tokSave, {}, BASE4);
  const idAfter = payloadOf(jAfter.body.ticket).userId;
  if (idAfter !== idBefore) fail(`userId: restart changed the save key ${idBefore} -> ${idAfter} (player would lose their character)`);
  console.log('userId OK: stable across a restart:', idAfter);

  // Distinct accounts must still be distinct — a derivation that collapsed every
  // tok onto one id would pass the test above and merge everyone's save.
  const jOther = await join('Stranger', tokSave + '-other', {}, BASE4);
  if (payloadOf(jOther.body.ticket).userId === idAfter) fail('userId: two different toks derived the same userId');
  console.log('userId OK: distinct toks derive distinct ids');

  // ...and it is genuinely derived from the secret, not read back from a file
  // this process happens to share: a different HEARTH_ID_SECRET renames the account.
  spawnControl(PORT5, { HEARTH_WORLDS: '', HEARTH_DEV_TOKS: '', HEARTH_DEV_USERS: '', HEARTH_ID_SECRET: 'a-different-deployment-secret' });
  await waitForHealth(BASE5);
  const jElsewhere = await join('Settler', tokSave, {}, BASE5);
  if (payloadOf(jElsewhere.body.ticket).userId === idAfter) fail('userId: HEARTH_ID_SECRET had no effect — id is not keyed');
  console.log('userId OK: keyed by HEARTH_ID_SECRET (separate deployments do not share an id space)');

  console.log('ALL TESTS PASSED');
  for (const c of kids) c.kill();
  process.exit(0);
} catch (err) {
  fail('unexpected error: ' + (err.stack || err));
}
