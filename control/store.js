// In-memory stores behind a tiny interface. Swapping in Postgres later means
// rewriting this file only — the HTTP layer never touches a raw object literal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const profilesByTok = new Map();   // tok -> profile

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- world registry -------------------------------------------------------
// Allocation is a control-plane concern, so the list of worlds is config, not
// code. Three sources, first one that yields entries wins:
//   1. HEARTH_WORLDS   — a JSON array, for container/CI setups with no file system
//   2. control/worlds.json — a JSON array, the normal way to host several worlds
//   3. the single-world HEARTH_* env vars — the historical default, kept so an
//      existing dev setup keeps working with no config at all.
// Entry: { worldId, seed, instanceId, ws, name? }. `name` is display-only and
// defaults to worldId. instanceId is an internal allocation detail (which game
// process hosts the world) and is deliberately not exposed by /api/worlds.

function normalizeWorld(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const worldId = typeof raw.worldId === 'string' ? raw.worldId.trim() : '';
  const ws = typeof raw.ws === 'string' ? raw.ws.trim() : '';
  if (!worldId || !ws) return null;   // a world with no id or no address is unjoinable
  return {
    worldId,
    seed: typeof raw.seed === 'string' && raw.seed ? raw.seed : 'hearth-1',
    instanceId: typeof raw.instanceId === 'string' && raw.instanceId ? raw.instanceId : 'local',
    ws,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 48) : worldId,
  };
}

function parseWorldList(json, source) {
  let parsed;
  try { parsed = JSON.parse(json); } catch (err) {
    console.warn(`[control] ignoring ${source}: bad JSON (${err.message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[control] ignoring ${source}: expected a JSON array`);
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of parsed) {
    const w = normalizeWorld(entry);
    if (!w) { console.warn(`[control] ignoring malformed world entry in ${source}`); continue; }
    if (seen.has(w.worldId)) { console.warn(`[control] duplicate worldId '${w.worldId}' in ${source}, keeping the first`); continue; }
    seen.add(w.worldId);
    out.push(w);
  }
  return out;
}

function loadWorlds() {
  if (process.env.HEARTH_WORLDS) {
    const fromEnv = parseWorldList(process.env.HEARTH_WORLDS, 'HEARTH_WORLDS');
    if (fromEnv.length) return fromEnv;
  }
  const file = process.env.HEARTH_WORLDS_FILE || path.join(HERE, 'worlds.json');
  try {
    const fromFile = parseWorldList(fs.readFileSync(file, 'utf8'), file);
    if (fromFile.length) return fromFile;
  } catch { /* no file is the normal single-world case */ }
  return [normalizeWorld({
    worldId: process.env.HEARTH_WORLD_ID || 'default',
    seed: process.env.HEARTH_WORLD_SEED || 'hearth-1',
    instanceId: process.env.HEARTH_INSTANCE_ID || 'local',
    ws: process.env.HEARTH_GAME_WS || 'ws://localhost:8082',
    name: process.env.HEARTH_WORLD_NAME || '',
  })];
}

const worlds = loadWorlds();

// The fallback for a missing/unknown worldId. Explicit via HEARTH_DEFAULT_WORLD_ID,
// otherwise the first configured world — order in config is the contract.
const defaultWorldId = (() => {
  const want = process.env.HEARTH_DEFAULT_WORLD_ID;
  if (want && worlds.some((w) => w.worldId === want)) return want;
  if (want) console.warn(`[control] HEARTH_DEFAULT_WORLD_ID='${want}' is not a configured world; using '${worlds[0].worldId}'`);
  return worlds[0].worldId;
})();

export function getWorlds() {
  return worlds;
}

export function getWorldById(worldId) {
  if (typeof worldId !== 'string') return null;
  return worlds.find((w) => w.worldId === worldId) || null;
}

export function getDefaultWorld() {
  return getWorldById(defaultWorldId) || worlds[0];
}

// Allocation: resolve whatever the client asked for to a world we actually host.
// Never trust the request to name the world in the ticket — the ticket binds
// what this returns, not what was asked for.
export function resolveWorld(requestedWorldId) {
  return getWorldById(requestedWorldId) || getDefaultWorld();
}

// --- dev permission -------------------------------------------------------
// There is no DB and no admin UI yet, so the grant is an operator-set env
// allowlist read once at boot: HEARTH_DEV_TOKS / HEARTH_DEV_USERS, each a
// comma-separated list. It is per-account (unlike the game server's blanket
// HEARTH_DEV), needs no new storage or endpoint, and when a real users table
// lands this function is the only thing that changes.
const parseList = (s) => new Set(String(s || '').split(',').map((v) => v.trim()).filter(Boolean));
const devToks = parseList(process.env.HEARTH_DEV_TOKS);
const devUserIds = parseList(process.env.HEARTH_DEV_USERS);

export function isDevGranted({ tok, userId }) {
  return devToks.has(tok) || devUserIds.has(userId);
}

export function getProfile(tok) {
  return profilesByTok.get(tok) || null;
}

export function putProfile(profile) {
  profilesByTok.set(profile.tok, profile);
  return profile;
}
