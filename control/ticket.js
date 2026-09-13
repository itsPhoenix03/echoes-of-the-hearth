// Signed connection tickets — the security boundary between control plane and
// game server. Ed25519 via Node's built-in crypto, no JWT library.
//
// Wire format (see PROTOCOL.md for the authoritative spec):
//   base64url(JSON payload bytes) + "." + base64url(raw 64-byte Ed25519 signature)
// The signature covers the ASCII bytes of the base64url-encoded payload string
// (the part BEFORE the dot) — not the raw JSON, not the decoded object. This
// mirrors JWT's compact-encoding convention so Go can verify without touching JSON.

import { generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto';

const TICKET_TTL_MS = 30_000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// Ed25519 raw public keys are 32 bytes; Node's crypto wants SPKI DER for import/export,
// so we wrap/unwrap the raw bytes with the fixed 12-byte SPKI prefix for ed25519.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function rawPublicKeyToKeyObject(rawB64) {
  const raw = Buffer.from(rawB64, 'base64');
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
function rawPrivateKeyToKeyObject(rawB64) {
  const raw = Buffer.from(rawB64, 'base64');
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, raw]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// Env-pinned keypair so Node + Go can be pinned together in dev without a
// per-boot handshake. HEARTH_TICKET_PUBKEY/PRIVKEY are raw 32-byte values, base64.
let keys;
if (process.env.HEARTH_TICKET_PRIVKEY && process.env.HEARTH_TICKET_PUBKEY) {
  keys = {
    privateKey: rawPrivateKeyToKeyObject(process.env.HEARTH_TICKET_PRIVKEY),
    publicKey: rawPublicKeyToKeyObject(process.env.HEARTH_TICKET_PUBKEY),
    publicKeyRawB64: process.env.HEARTH_TICKET_PUBKEY,
  };
} else {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Extract the raw 32-byte public key (strip the fixed SPKI prefix) for /api/pubkey.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(spki.length - 32);
  keys = { publicKey, privateKey, publicKeyRawB64: rawPub.toString('base64') };
}

export function getPublicKeyRawB64() {
  return keys.publicKeyRawB64;
}

let jtiCounter = 0;
function nextJti() {
  jtiCounter += 1;
  return `${Date.now().toString(36)}-${jtiCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function issueTicket({ userId, worldId, instanceId, name, dev }) {
  const iat = Date.now();
  const exp = iat + TICKET_TTL_MS;
  const payload = { userId, worldId, instanceId, name, iat, exp, jti: nextJti() };
  // Omitted entirely when not granted, so tickets for normal accounts stay
  // byte-identical to the pre-dev-claim format. Go reads absent as false.
  if (dev === true) payload.dev = true;
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = edSign(null, Buffer.from(payloadB64, 'ascii'), keys.privateKey);
  return `${payloadB64}.${b64url(sig)}`;
}

// Verification path used only by control's own tests, deliberately independent
// of issueTicket's signing call so a bug in one is not masked by the other.
export function verifyTicket(ticket, pubKeyRawB64 = keys.publicKeyRawB64) {
  const parts = String(ticket).split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let pub;
  try { pub = rawPublicKeyToKeyObject(pubKeyRawB64); } catch { return { ok: false, reason: 'bad-pubkey' }; }
  let sig;
  try { sig = b64urlToBuf(sigB64); } catch { return { ok: false, reason: 'bad-sig-encoding' }; }
  const verified = edVerify(null, Buffer.from(payloadB64, 'ascii'), pub, sig);
  if (!verified) return { ok: false, reason: 'bad-signature' };
  let payload;
  try { payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8')); } catch { return { ok: false, reason: 'bad-json' }; }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}
