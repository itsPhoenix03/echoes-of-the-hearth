// In-memory stores behind a tiny interface. Swapping in Postgres later means
// rewriting this file only — the HTTP layer never touches a raw object literal.

const profilesByTok = new Map();   // tok -> profile

// Single hardcoded world for now; shaped as a list so multi-world is a data
// change later, not a redesign. Read from env with sane defaults.
const worlds = [
  {
    worldId: process.env.HEARTH_WORLD_ID || 'default',
    seed: process.env.HEARTH_WORLD_SEED || 'hearth-1',
    instanceId: process.env.HEARTH_INSTANCE_ID || 'local',
    ws: process.env.HEARTH_GAME_WS || 'ws://localhost:8082',
  },
];

export function getWorlds() {
  return worlds;
}

export function getWorldById(worldId) {
  return worlds.find((w) => w.worldId === worldId) || null;
}

export function getProfile(tok) {
  return profilesByTok.get(tok) || null;
}

export function putProfile(profile) {
  profilesByTok.set(profile.tok, profile);
  return profile;
}
