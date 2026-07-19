// Shared deterministic worldgen — identical on client and server.
import { createNoise2D } from 'simplex-noise';
import alea from 'alea';
import { NODE } from './defs.js';

export const WORLD_VERSION = 4;   // v4: core mountain moved onto the Core island
export const SIZE = 1280;
export const T = { GRASS: 0, SAND: 1, SNOW: 2, MUD: 3, WATER: 4, BLIGHT: 5 };
export const TILE_KEYS = ['grass', 'sand', 'snow', 'mud', 'water', 'blight'];
// Four far-flung islands (Woods/GRASS, Dunes/SAND, Spire/SNOW, Marsh/MUD) + Core, separated by open ocean.
export const ISLES = [[180, 180], [1100, 180], [180, 1100], [1100, 1100]];
export const ISLE_R = 70;
export const MONOLITHS = ISLES;
export const CORE = [640, 640];

export const ACTIVATION_I = CORE[1] * SIZE + CORE[0];

export const MINOR_ISLES = [
  { x: 640, y: 180, r: 14, kind: 'rock' },
  { x: 640, y: 1100, r: 13, kind: 'sandbar' },
  { x: 180, y: 640, r: 13, kind: 'driftwood' },
  { x: 1100, y: 640, r: 14, kind: 'ruin' },
  { x: 420, y: 420, r: 11, kind: 'rock' },
  { x: 860, y: 420, r: 11, kind: 'ruin' },
  { x: 420, y: 860, r: 12, kind: 'icefloe' },
  { x: 860, y: 860, r: 11, kind: 'blightshard' },
  { x: 340, y: 180, r: 9, kind: 'sandbar' },
  { x: 180, y: 940, r: 10, kind: 'icefloe' },
  { x: 940, y: 1100, r: 10, kind: 'driftwood' },
  { x: 1100, y: 340, r: 9, kind: 'rock' },
];

export const MOUNTAINS = [
  { x: 150, y: 150, key: 'mountain_woods' },
  { x: 1130, y: 150, key: 'mountain_dunes' },
  { x: 150, y: 1130, key: 'mountain_spire' },
  { x: 1130, y: 1130, key: 'mountain_marsh' },
  { x: 640, y: 630, key: 'mountain_core_obsidian' },   // on the Core island (R~14), backdrop north of the temple
];

export const TEMPLE_PIECES = [
  { i: ACTIVATION_I, key: 'core_activation_dais' },
  { i: (CORE[1] - 5) * SIZE + CORE[0], key: 'core_temple_ruins' },
  { i: (CORE[1] + 1) * SIZE + CORE[0] - 5, key: 'core_temple_arch_ruin' },
  { i: (CORE[1] + 1) * SIZE + CORE[0] + 5, key: 'core_temple_pillar_broken' },
  { i: (CORE[1] + 5) * SIZE + CORE[0] - 3, key: 'core_temple_pillar_broken' },
];

// LANDMARK_BLOCK: Set of tile indices blocked by mountains (3x3 footprint) and temple pieces (except dais).
export const LANDMARK_BLOCK = (() => {
  const s = new Set();
  for (const m of MOUNTAINS) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        s.add((m.y + dy) * SIZE + (m.x + dx));
  }
  for (let p = 1; p < TEMPLE_PIECES.length; p++) s.add(TEMPLE_PIECES[p].i);
  return s;
})();

// Minor isle kind -> tile type mapping
const MINOR_KIND_TILE = {
  sandbar: T.SAND, ruin: T.SAND,
  driftwood: T.GRASS, rock: T.GRASS,
  icefloe: T.SNOW,
  blightshard: T.BLIGHT,
};

const nearPOI = (x, y) => {
  if (MONOLITHS.some(([mx, my]) => Math.abs(mx - x) < 3 && Math.abs(my - y) < 3)) return true;
  if (Math.abs(x - CORE[0]) < 6 && Math.abs(y - CORE[1]) < 6) return true;
  // within 2 tiles of any LANDMARK_BLOCK tile
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      if (LANDMARK_BLOCK.has((y + dy) * SIZE + (x + dx))) return true;
  return false;
};

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
  const waterTemp = new Uint8Array(SIZE * SIZE); // 0 temperate, 1 freezing, 2 hot
  const tileVis = new Uint8Array(SIZE * SIZE);   // 1 on ~6% of land tiles (sct noise)
  const decor = new Map(); // tile index -> string prop key

  // Track which tiles belong to minor islands and their kind
  const minorKindAt = new Map(); // tile index -> minor isle kind string

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const el = elevN(x / 28, y / 28);
      const dCore = Math.hypot(x - CORE[0], y - CORE[1]);
      let t = T.WATER;
      let landClass = null;

      if (dCore < 14) {
        t = T.BLIGHT;
        landClass = 'core';
      } else {
        // Major islands
        for (let k = 0; k < 4; k++) {
          const d = Math.hypot(x - ISLES[k][0], y - ISLES[k][1]);
          if (d < ISLE_R + coast(x / 9, y / 9) * 7) {
            t = ISLE_T[k];
            landClass = 'major';
            break;
          }
        }
        // Minor islands (only in water)
        if (t === T.WATER) {
          for (const m of MINOR_ISLES) {
            const d = Math.hypot(x - m.x, y - m.y);
            if (d < m.r + coast(x / 9, y / 9) * 4) {
              t = MINOR_KIND_TILE[m.kind];
              landClass = 'minor';
              minorKindAt.set(i, m.kind);
              break;
            }
          }
        }
        // Inland lakes: major islands use el < -0.4, minor islands use el < -0.75
        if (landClass === 'major' && t !== T.WATER && el < -0.4) { t = T.WATER; landClass = null; }
        if (landClass === 'minor' && t !== T.WATER && el < -0.75) { t = T.WATER; landClass = null; minorKindAt.delete(i); }
      }

      tiles[i] = t;

      // Iceberg ring around Frozen Spire — lethal to wooden hulls
      const dSpire = Math.hypot(x - ISLES[2][0], y - ISLES[2][1]);
      if (t === T.WATER && dSpire > ISLE_R + 8 && dSpire < ISLE_R + 135 && sct(x / 2 + 900, y / 2 + 900) > 0.88)
        bergs.add(i);

      // Water temperature
      if (t === T.WATER) {
        if (dSpire < ISLE_R + 180) waterTemp[i] = 1; // freezing
        else if (dCore < 125) waterTemp[i] = 2;       // hot
        // else 0 = temperate
      }

      // Elevation
      if (t === T.WATER) {
        elev[i] = 0;
      } else {
        let e = 1 + (el > 0.05 ? 1 : 0) + (el > 0.42 ? 1 : 0);
        const ridge = 1 - Math.abs(elevN(x / 13 + 40, y / 13 + 40));
        if (ridge > 0.82 && e < 3) e++;
        elev[i] = e;
      }
      if (t === T.BLIGHT) elev[i] = 1;

      // Veins
      const vm = sct(x / 5 + 250, y / 5 + 250);
      veins[i] = vm > 0.68 ? 1 : vm < -0.74 ? 2 : 0;

      // tileVis: ~6% of land tiles
      if (t !== T.WATER) {
        tileVis[i] = sct(x / 4 + 55, y / 4 + 55) > 0.55 ? 1 : 0;
      }

      if (t === T.WATER || t === T.BLIGHT || nearPOI(x, y)) continue;

      const v = veg(x / 6, y / 6), s = sct(x / 3, y / 3);
      const isMinor = landClass === 'minor';
      const mKind = isMinor ? minorKindAt.get(i) : null;

      // Nodes
      // Starmetal: extremely rare, never on Frozen Spire, never on minors
      if (!isMinor && t !== T.SNOW && sct(x / 2 + 700, y / 2 + 700) > 0.985) { nodes.set(i, NODE.STARMETAL); continue; }

      if (isMinor) {
        // Minor island nodes: restricted to TREE (driftwood only), STONE, BUSH — no crystal/boulder/starmetal
        if (mKind === 'driftwood' && v > 0.62) nodes.set(i, NODE.TREE);
        else if (s > 0.80) nodes.set(i, NODE.BUSH);
        else if (s < -0.85) nodes.set(i, NODE.STONE);
      } else if (t === T.GRASS) {
        if (v > 0.62) nodes.set(i, NODE.TREE);
        else if (s > 0.80) nodes.set(i, NODE.BUSH);
        else if (s < -0.85) nodes.set(i, NODE.STONE);
      } else if (t === T.SAND) {
        if (s > 0.82) nodes.set(i, NODE.BOULDER);
        else if (s < -0.85) nodes.set(i, NODE.STONE);
      } else if (t === T.SNOW) {
        if (s > 0.84) nodes.set(i, NODE.CRYSTAL);
        else if (v > 0.72) nodes.set(i, NODE.BOULDER);
        else if (s < -0.85) nodes.set(i, NODE.STONE);
      } else if (t === T.MUD) {
        if (s > 0.80) nodes.set(i, NODE.BUSH);
        else if (v > 0.80) nodes.set(i, NODE.CRYSTAL);
      }

      // Decor: sparse deterministic props, land tiles only, not on node tiles
      if (!nodes.has(i) && !isMinor) {
        const ds = sct(x / 3 + 400, y / 3 + 400);
        // Not within 4 of monoliths/notes/spawn area (nearPOI already filters monoliths/core;
        // also guard the spawn area around ISLES[0] with a 20-tile buffer)
        const nearSpawn = Math.hypot(x - (ISLES[0][0] - 12), y - (ISLES[0][1] - 12)) < 20;
        if (!nearSpawn) {
          if (t === T.GRASS && ds > 0.88 && v < 0) { decor.set(i, 'glow_mushroom'); }
          else if (t === T.SAND && ds > 0.93) { decor.set(i, 'sand_ruin_pillar'); }
          else if (t === T.SNOW && ds > 0.92) { decor.set(i, 'ice_crystal_cluster'); }
          else if (t === T.MUD && ds > 0.92) { decor.set(i, 'bone_totem'); }
          else if (t === T.BLIGHT && ds > 0.85) { decor.set(i, 'lava_vent'); }
        }
      }
    }
  }

  // Clear ALL nodes within radius 7 of CORE (temple clearing)
  for (const [ni] of nodes) {
    const nx = ni % SIZE, ny = (ni / SIZE) | 0;
    if (Math.hypot(nx - CORE[0], ny - CORE[1]) < 7) nodes.delete(ni);
  }

  // Stamp solid ground under landmark footprints — coast/lake noise must never
  // strand a mountain in water (seed-independent guarantee).
  for (const m of MOUNTAINS) {
    const isCore = Math.hypot(m.x - CORE[0], m.y - CORE[1]) < 20;
    let k = 0, bd = Infinity;
    for (let q = 0; q < 4; q++) {
      const d = Math.hypot(m.x - ISLES[q][0], m.y - ISLES[q][1]);
      if (d < bd) { bd = d; k = q; }
    }
    const ground = isCore ? T.BLIGHT : ISLE_T[k];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = (m.y + dy) * SIZE + (m.x + dx);
        if (tiles[i] === T.WATER) { tiles[i] = ground; elev[i] = 1; nodes.delete(i); }
      }
  }

  return { tiles, elev, veins, nodes, bergs, waterTemp, tileVis, decor };
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
  const [sx, sy] = [ISLES[0][0] - 12, ISLES[0][1] - 12]; // (168, 168)
  for (let r = 0; r < 50; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const i = y * SIZE + x;
        if (world.tiles[i] === T.GRASS && !world.nodes.has(i)) return [x, y];
      }
  return [sx, sy];
}
