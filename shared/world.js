// Shared deterministic worldgen — identical on client and server.
import { createNoise2D } from 'simplex-noise';
import alea from 'alea';
import { NODE } from './defs.js';

export const SIZE = 320;
export const T = { GRASS: 0, SAND: 1, SNOW: 2, MUD: 3, WATER: 4, BLIGHT: 5 };
export const TILE_KEYS = ['grass', 'sand', 'snow', 'mud', 'water', 'blight'];
// Four far-flung islands (Woods, Dunes, Spire, Marsh) + the Core island, separated by open ocean
// wider than a screen — you cannot see one island from another.
export const ISLES = [[80, 80], [240, 80], [80, 240], [240, 240]];
export const ISLE_R = 40;
export const MONOLITHS = ISLES;
export const CORE = [160, 160];

const nearPOI = (x, y) =>
  MONOLITHS.some(([mx, my]) => Math.abs(mx - x) < 3 && Math.abs(my - y) < 3) ||
  (Math.abs(x - CORE[0]) < 6 && Math.abs(y - CORE[1]) < 6);

export function genWorld(seed) {
  const elevN = createNoise2D(alea(seed + 'e'));
  const veg = createNoise2D(alea(seed + 't'));
  const sct = createNoise2D(alea(seed + 's'));
  const coast = createNoise2D(alea(seed + 'c'));
  const ISLE_T = [T.GRASS, T.SAND, T.SNOW, T.MUD];
  const tiles = new Uint8Array(SIZE * SIZE);
  const elev = new Uint8Array(SIZE * SIZE);   // 0 water, 1 plain, 2 hill, 3 peak
  const veins = new Uint8Array(SIZE * SIZE);  // underground: 0 none, 1 iron, 2 diamond
  const nodes = new Map(); // tile index -> NODE kind
  const bergs = new Set(); // iceberg water tiles guarding the Frozen Spire
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const el = elevN(x / 28, y / 28);
      const dCore = Math.hypot(x - CORE[0], y - CORE[1]);
      let t = T.WATER;
      if (dCore < 14) t = T.BLIGHT;                              // Era 4: Core Void island
      else {
        for (let k = 0; k < 4; k++) {
          const d = Math.hypot(x - ISLES[k][0], y - ISLES[k][1]);
          if (d < ISLE_R + coast(x / 9, y / 9) * 7) { t = ISLE_T[k]; break; }
        }
        if (t !== T.WATER && el < -0.4) t = T.WATER;             // inland lakes
      }
      tiles[i] = t;
      // icebergs ring the entire Frozen Spire — lethal to wooden hulls
      if (t === T.WATER && Math.hypot(x - ISLES[2][0], y - ISLES[2][1]) < 72 && sct(x / 2 + 900, y / 2 + 900) > 0.72)
        bergs.add(i);
      elev[i] = t === T.WATER ? 0 : 1 + (el > 0.15 ? 1 : 0) + (el > 0.52 ? 1 : 0);
      if (t === T.BLIGHT) elev[i] = 1;
      const vm = sct(x / 5 + 250, y / 5 + 250);
      veins[i] = vm > 0.68 ? 1 : vm < -0.74 ? 2 : 0;
      if (t === T.WATER || t === T.BLIGHT || nearPOI(x, y)) continue;
      const v = veg(x / 6, y / 6), s = sct(x / 3, y / 3);
      // Starmetal: extremely rare, never on the Frozen Spire — needed for the reinforced boat
      if (t !== T.SNOW && sct(x / 2 + 700, y / 2 + 700) > 0.955) { nodes.set(i, NODE.STARMETAL); continue; }
      if (t === T.GRASS) {
        if (v > 0.45) nodes.set(i, NODE.TREE);
        else if (s > 0.72) nodes.set(i, NODE.BUSH);
        else if (s < -0.78) nodes.set(i, NODE.STONE);
      } else if (t === T.SAND) {
        if (s > 0.74) nodes.set(i, NODE.BOULDER);
        else if (s < -0.8) nodes.set(i, NODE.STONE);
      } else if (t === T.SNOW) {
        if (s > 0.78) nodes.set(i, NODE.CRYSTAL);
        else if (v > 0.6) nodes.set(i, NODE.BOULDER);
        else if (s < -0.8) nodes.set(i, NODE.STONE);
      } else if (t === T.MUD) {
        if (s > 0.74) nodes.set(i, NODE.BUSH);
        else if (v > 0.72) nodes.set(i, NODE.CRYSTAL);
      }
    }
  }
  return { tiles, elev, veins, nodes, bergs };
}

export function nearestLand(world, x, y) {
  for (let r = 1; r < 130; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const nx = Math.round(x + dx), ny = Math.round(y + dy);
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        if (world.tiles[ny * SIZE + nx] !== T.WATER) return [nx, ny];
      }
  return [x, y];
}

// mining is possible under the Woods, Dunes and Spire — never the Marsh, water or the Core
export const DIGGABLE = (world, i) =>
  world.tiles[i] === T.GRASS || world.tiles[i] === T.SAND || world.tiles[i] === T.SNOW;

export function findSpawn(world) {
  for (let r = 0; r < 40; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = 68 + dx, y = 68 + dy;
        const i = y * SIZE + x;
        if (world.tiles[i] === T.GRASS && !world.nodes.has(i)) return [x, y];
      }
  return [68, 68];
}
