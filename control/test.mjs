// Black-box HTTP tests for the control plane, in the style of the root test.mjs
// (plain asserts, console.log per stage, fail() + exit 1). Runs standalone: it
// spawns control/index.js itself on a non-default port and tears it down after.
import { spawn } from 'node:child_process';
import { verifyTicket } from './ticket.js';

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (s) => { console.log('FAIL:', s); if (child) child.kill(); process.exit(1); };

let child;

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

async function waitForHealth() {
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  fail('control server did not become healthy in time');
}

async function join(name, tok) {
  const r = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, tok }),
  });
  return { status: r.status, body: await r.json() };
}

child = spawn(process.execPath, ['control/index.js'], {
  env: { ...process.env, CONTROL_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => process.stderr.write(d));

try {
  await waitForHealth();
  console.log('server up on', PORT);

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

  console.log('ALL TESTS PASSED');
  child.kill();
  process.exit(0);
} catch (err) {
  fail('unexpected error: ' + (err.stack || err));
}
