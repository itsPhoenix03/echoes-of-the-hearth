// Node control plane: identity, profiles, allocation, signed tickets.
// Owns ACCOUNT state only (userId/tok/name). Never touches world state —
// that's the Go game server's job. Built-ins only, no Express.

import http from 'node:http';
import crypto from 'node:crypto';
import { getProfile, putProfile, getWorlds } from './store.js';
import { issueTicket, getPublicKeyRawB64 } from './ticket.js';

const PORT = Number(process.env.CONTROL_PORT) || 8090;

// Mirrors server/index.js's 'hello' sanitization exactly: strip control chars,
// trim, cap at 18 chars, 2-char minimum. Name is account state, so Node owns it.
function sanitizeName(raw) {
  const cleaned = String(raw || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 18);
  return cleaned.length >= 2 ? cleaned : null;
}

function genUserId() {
  return 'u_' + crypto.randomBytes(12).toString('hex');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16_384) { reject(new Error('body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'access-control-allow-origin': '*',
  });
  res.end(buf);
}

function handleJoin(req, res) {
  readJsonBody(req).then((body) => {
    const tok = typeof body.tok === 'string' ? body.tok.slice(0, 64) : null;
    if (!tok) return sendJson(res, 400, { error: 'missing tok' });

    const now = Date.now();
    const sanitized = sanitizeName(body.name);
    let profile = getProfile(tok);
    if (!profile) {
      profile = { userId: genUserId(), tok, name: sanitized || 'Keeper', createdAt: now, lastSeen: now };
    } else {
      profile.lastSeen = now;
      // A real (non-fallback) name is an explicit rename; a fallback never clobbers a saved name.
      if (sanitized) profile.name = sanitized;
    }
    putProfile(profile);

    const world = getWorlds()[0];   // single-world scope; a list makes multi-world a data change later
    const ticket = issueTicket({
      userId: profile.userId, worldId: world.worldId, instanceId: world.instanceId, name: profile.name,
    });
    sendJson(res, 200, { ticket, ws: world.ws, worldId: world.worldId, name: profile.name });
  }).catch((err) => sendJson(res, 400, { error: err.message }));
}

function handleHealth(_req, res) {
  sendJson(res, 200, { ok: true, worlds: getWorlds() });
}

function handlePubkey(_req, res) {
  sendJson(res, 200, { publicKey: getPublicKeyRawB64() });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/join') return handleJoin(req, res);
  if (req.method === 'GET' && url.pathname === '/api/health') return handleHealth(req, res);
  if (req.method === 'GET' && url.pathname === '/api/pubkey') return handlePubkey(req, res);
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[control] listening on ${PORT}`);
});

export default server;
