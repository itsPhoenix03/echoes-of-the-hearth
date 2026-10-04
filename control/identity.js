// Account identity: the mapping from a client's `tok` to its permanent `userId`.
//
// This is the save key. The Go game server persists a player's whole profile —
// inventory, tools, gear, position — keyed by `userId`, so anything that makes a
// returning `tok` produce a DIFFERENT `userId` silently deletes that player's
// character. The original implementation minted `userId` from randomBytes() into
// an in-memory Map, which meant every control-plane restart orphaned every save.
//
// So the mapping is DERIVED, not stored: userId = HMAC(secret, tok). It survives
// restarts with no storage at all, and it stays correct if a second control-plane
// process is ever run beside the first (both derive the same answer) — which a
// Map could never do.
//
// The secret is not a confidentiality boundary — a `tok` is already a bearer
// credential, so anyone holding one has the account regardless. It exists so
// userIds are not guessable from a leaked tok list, and so two unrelated
// deployments don't share an id space. What matters far more than its secrecy is
// its STABILITY: rotating it renames every account and orphans every save.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = process.env.HEARTH_ID_SECRET_FILE || path.join(HERE, '.id-secret');

// Last-resort constant. A random per-boot secret would be the one thing we must
// never do (it reintroduces exactly the bug this file exists to fix), so when the
// secret can neither be configured nor persisted we choose "deterministic and
// public" over "private and volatile" — saves survive, and the only thing lost is
// the unguessability, which was defence in depth to begin with.
const FALLBACK_SECRET = 'hearth-control-unconfigured-id-secret';

// Resolution order, first hit wins:
//   1. HEARTH_ID_SECRET  — how a real deployment pins it (and how two control
//      plane replicas agree without sharing a disk)
//   2. control/.id-secret — generated once on first boot, gitignored; makes a
//      plain `npm run control` durable with zero configuration
//   3. FALLBACK_SECRET   — read-only filesystem, loud warning
function loadSecret() {
  const fromEnv = String(process.env.HEARTH_ID_SECRET || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first boot, or no file — fall through and create one */ }

  const generated = crypto.randomBytes(32).toString('base64');
  try {
    // wx: never clobber a secret another process wrote between our read and this
    // write — losing that race by overwriting would orphan every save on disk.
    fs.writeFileSync(SECRET_FILE, generated + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch {
    try {
      const raced = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (raced) return raced;
    } catch { /* genuinely unwritable */ }
  }

  console.warn(`[control] could not read or create ${SECRET_FILE} — falling back to a built-in id secret. ` +
    'Player saves are still stable, but set HEARTH_ID_SECRET in production.');
  return FALLBACK_SECRET;
}

const secret = loadSecret();

// Domain-separated so this HMAC can never collide with some future HMAC over the
// same tok with the same secret. v1 is part of the contract: bumping it renames
// every account, so it changes only alongside a deliberate migration.
const DOMAIN = 'hearth-user-id:v1\n';

// 12 bytes -> 24 hex chars, byte-for-byte the shape the old randomBytes(12) path
// produced, so every consumer (tickets, the Go save files' key format, the dev
// allowlist's HEARTH_DEV_USERS entries) sees no change at all.
export function deriveUserId(tok) {
  const h = crypto.createHmac('sha256', secret).update(DOMAIN).update(String(tok)).digest();
  return 'u_' + h.subarray(0, 12).toString('hex');
}
