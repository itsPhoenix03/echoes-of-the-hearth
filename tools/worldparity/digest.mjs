// Reference side of the worldgen parity harness: runs the *real*
// shared/world.js genWorld() and emits digests (or raw dumps) for comparison
// against the Go port in gameserver/world.
//
//   node tools/worldparity/digest.mjs digest                 -> JSON digests on stdout
//   node tools/worldparity/digest.mjs dump <seedIndex> <field> <outFile>
//
// Seeds come from seeds.json and are referenced by index, so no non-ASCII seed
// ever has to survive a command line.
//
// Fields: tiles | elev | veins | waterTemp | tileVis | nodes | bergs | decor
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { genWorld } from '../../shared/world.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SEEDS = JSON.parse(readFileSync(path.join(HERE, 'seeds.json'), 'utf8'));
export const ARRAY_FIELDS = ['tiles', 'elev', 'veins', 'waterTemp', 'tileVis'];
export const MAP_FIELDS = ['nodes', 'bergs', 'decor'];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Canonical text encodings for the map/set fields. Sorted by tile index so the
// digest is independent of Map/Set insertion order (Go maps are unordered).
function nodesText(world) {
  return [...world.nodes.keys()].sort((a, b) => a - b)
    .map((i) => `${i} ${world.nodes.get(i)}`).join('\n') + '\n';
}
function bergsText(world) {
  return [...world.bergs].sort((a, b) => a - b).map((i) => `${i}`).join('\n') + '\n';
}
function decorText(world) {
  return [...world.decor.keys()].sort((a, b) => a - b)
    .map((i) => `${i} ${world.decor.get(i)}`).join('\n') + '\n';
}

export function fieldBytes(world, field) {
  if (ARRAY_FIELDS.includes(field)) {
    const a = world[field];
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  }
  if (field === 'nodes') return Buffer.from(nodesText(world), 'utf8');
  if (field === 'bergs') return Buffer.from(bergsText(world), 'utf8');
  if (field === 'decor') return Buffer.from(decorText(world), 'utf8');
  throw new Error(`unknown field ${field}`);
}

export function digestSeed(seed) {
  const w = genWorld(seed);
  const out = { seed };
  for (const f of ARRAY_FIELDS) out[f] = sha(fieldBytes(w, f));
  out.nodesCount = w.nodes.size;
  out.nodes = sha(fieldBytes(w, 'nodes'));
  out.bergsCount = w.bergs.size;
  out.bergs = sha(fieldBytes(w, 'bergs'));
  out.decorCount = w.decor.size;
  out.decor = sha(fieldBytes(w, 'decor'));
  return out;
}

// CLI entry point (skipped when this module is imported by compare.mjs).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const mode = process.argv[2] || 'digest';
if (!isMain) {
  // imported as a library
} else if (mode === 'digest') {
  process.stdout.write(JSON.stringify(SEEDS.map(digestSeed), null, 2) + '\n');
} else if (mode === 'dump') {
  const seed = SEEDS[Number(process.argv[3])];
  const field = process.argv[4];
  const outFile = process.argv[5];
  writeFileSync(outFile, fieldBytes(genWorld(seed), field));
} else {
  console.error('usage: digest.mjs [digest | dump <seedIndex> <field> <outFile>]');
  process.exit(2);
}
