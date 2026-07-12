// Central asset manifest — all SVG textures loaded by Phaser.
// Format: [key, url, width, height]
// preload() does: for (const [k,u,w,h] of ASSET_MANIFEST) this.load.svg(k, u, {width:w, height:h});

import { TILE_KEYS } from '../shared/world.js';

// Re-export sprite defs so main.ts has a single import source.
export const NODE_SPR: Record<string, [string, number, number]> = {
  tree:      ['tree',      48, 64],
  boulder:   ['boulder',   44, 36],
  bush:      ['bush',      36, 28],
  stone:     ['stone',     24, 16],
  crystal:   ['crystal',   36, 44],
  starmetal: ['starmetal', 38, 32],
};

export const STRUCT_SPR: Record<string, [number, number]> = {
  wall:      [48,  52],
  campfire:  [40,  36],
  workbench: [52,  42],
  forge:     [52,  60],
  engine:    [64,  84],
  mineshaft: [52,  48],
  shelter:   [104, 100],
};

const _manifest: [string, string, number, number][] = [];

// --- tiles (from TILE_KEYS) ---
for (const k of TILE_KEYS) _manifest.push([k, `/tiles/${k}.svg`, 64, 40]);

// --- nodes: texture key may differ from node key, deduplicate by texture name ---
const _nodeSeen = new Set<string>();
for (const [, [tex, w, h]] of Object.entries(NODE_SPR)) {
  if (_nodeSeen.has(tex)) continue;
  _nodeSeen.add(tex);
  _manifest.push([tex, `/sprites/${tex}.svg`, w, h]);
}

// --- structures ---
for (const [k, [w, h]] of Object.entries(STRUCT_SPR)) {
  _manifest.push([k, `/sprites/${k}.svg`, w, h]);
}

// --- misc sprites (previously hard-coded in preload) ---
_manifest.push(
  ['monolith',   '/sprites/monolith.svg',        48, 80],
  ['creature',   '/sprites/blight-creature.svg',  40, 36],
  ['stalker',    '/sprites/stalker.svg',          44, 30],
  ['brute',      '/sprites/brute.svg',            56, 54],
  ['wisp',       '/sprites/wisp.svg',             32, 40],
  ['boar',       '/sprites/boar.svg',             40, 28],
  ['crab',       '/sprites/crab.svg',             30, 20],
  ['hare',       '/sprites/hare.svg',             26, 26],
  ['rock',       '/tiles/rock.svg',               64, 64],
  ['cavefloor',  '/tiles/cavefloor.svg',          64, 40],
  ['ironore',    '/sprites/ironore.svg',          30, 24],
  ['diamondore', '/sprites/diamondore.svg',       30, 24],
  ['boat',       '/sprites/boat.svg',             56, 30],
  ['iceberg',    '/sprites/iceberg.svg',          44, 42],
  ['torch',      '/sprites/torch.svg',            16, 34],
  ['note',       '/sprites/note.svg',             26, 30],
  ['chest',      '/sprites/chest.svg',            44, 38],
  ['bed',        '/sprites/bed.svg',              52, 36],
  ['deer',       '/sprites/animal.svg',           36, 30],  // key='deer', file='animal.svg'
  ['lizard',     '/sprites/lizard.svg',           36, 22],
  ['fox',        '/sprites/fox.svg',              34, 26],
  ['toad',       '/sprites/toad.svg',             28, 22],
);

// --- new sprites (Task 1b) ---
_manifest.push(
  // individual sprites
  ['ashmark_hunter',   '/sprites/ashmark_hunter.svg',   36, 54],
  ['autumn_tree',      '/sprites/autumn_tree.svg',       58, 68],
  ['blight_armor',     '/sprites/blight_armor.svg',      42, 50],
  ['blight_spore',     '/sprites/blight_spore.svg',      46, 46],
  ['bone_totem',       '/sprites/bone_totem.svg',        42, 58],
  ['cactus_bloom',     '/sprites/cactus_bloom.svg',      44, 58],
  ['desert_palm',      '/sprites/desert_palm.svg',       56, 72],
  ['elder_yvenne',     '/sprites/elder_yvenne.svg',      38, 56],
  ['fur_cloak',        '/sprites/fur_cloak.svg',         38, 46],
  ['glow_mushroom',    '/sprites/glow_mushroom.svg',     44, 42],
  ['heat_cloak',       '/sprites/heat_cloak.svg',        38, 46],
  ['keeper_hat',       '/sprites/keeper_hat.svg',        42, 28],
  ['lava_vent',        '/sprites/lava_vent.svg',         52, 42],
  ['mangrove_tree',    '/sprites/mangrove_tree.svg',     64, 66],
  ['moth',             '/sprites/moth.svg',              46, 40],
  ['owl',              '/sprites/owl.svg',               42, 46],
  ['pine_tree',        '/sprites/pine_tree.svg',         56, 72],
  ['raven',            '/sprites/raven.svg',             50, 36],
  ['reed_bundle',      '/sprites/reed_bundle.svg',       40, 52],
  ['sand_ruin_pillar', '/sprites/sand_ruin_pillar.svg',  44, 58],
  ['seal',             '/sprites/seal.svg',              62, 40],
  ['snow_pine',        '/sprites/snow_pine.svg',         56, 74],
  ['stag',             '/sprites/stag.svg',              62, 52],
  ['stone_gate',       '/sprites/stone_gate.svg',        64, 58],
  ['watchtower',       '/sprites/watchtower.svg',        58, 74],
  ['windmill',         '/sprites/windmill.svg',          62, 70],
  ['wolf',             '/sprites/wolf.svg',              58, 42],
  ['woods_child',      '/sprites/woods_child.svg',       30, 42],

  // birds
  ['dune_falcon_fly_1',  '/sprites/birds/dune_falcon_fly_1.svg',  48, 30],
  ['dune_falcon_fly_2',  '/sprites/birds/dune_falcon_fly_2.svg',  48, 30],
  ['dune_falcon_fly_3',  '/sprites/birds/dune_falcon_fly_3.svg',  48, 30],
  ['ember_kite_fly_1',   '/sprites/birds/ember_kite_fly_1.svg',   48, 30],
  ['ember_kite_fly_2',   '/sprites/birds/ember_kite_fly_2.svg',   48, 30],
  ['ember_kite_fly_3',   '/sprites/birds/ember_kite_fly_3.svg',   48, 30],
  ['gull_fly_1',         '/sprites/birds/gull_fly_1.svg',         48, 30],
  ['gull_fly_2',         '/sprites/birds/gull_fly_2.svg',         48, 30],
  ['gull_fly_3',         '/sprites/birds/gull_fly_3.svg',         48, 30],
  ['marsh_heron_fly_1',  '/sprites/birds/marsh_heron_fly_1.svg',  56, 34],
  ['marsh_heron_fly_2',  '/sprites/birds/marsh_heron_fly_2.svg',  56, 34],
  ['marsh_heron_fly_3',  '/sprites/birds/marsh_heron_fly_3.svg',  56, 34],
  ['snow_tern_fly_1',    '/sprites/birds/snow_tern_fly_1.svg',    48, 30],
  ['snow_tern_fly_2',    '/sprites/birds/snow_tern_fly_2.svg',    48, 30],
  ['snow_tern_fly_3',    '/sprites/birds/snow_tern_fly_3.svg',    48, 30],
  ['woods_thrush_fly_1', '/sprites/birds/woods_thrush_fly_1.svg', 48, 30],
  ['woods_thrush_fly_2', '/sprites/birds/woods_thrush_fly_2.svg', 48, 30],
  ['woods_thrush_fly_3', '/sprites/birds/woods_thrush_fly_3.svg', 48, 30],

  // mountains
  ['mountain_core_obsidian',   '/sprites/mountains/mountain_core_obsidian.svg',   108, 90],
  ['mountain_dunes',           '/sprites/mountains/mountain_dunes.svg',           104, 82],
  ['mountain_marsh',           '/sprites/mountains/mountain_marsh.svg',           104, 78],
  ['mountain_spire',           '/sprites/mountains/mountain_spire.svg',           108, 92],
  ['mountain_woods',           '/sprites/mountains/mountain_woods.svg',           104, 86],

  // core_temple
  ['core_activation_dais',      '/sprites/core_temple/core_activation_dais.svg',      76,  52],
  ['core_temple_arch_ruin',     '/sprites/core_temple/core_temple_arch_ruin.svg',     76,  74],
  ['core_temple_pillar_broken', '/sprites/core_temple/core_temple_pillar_broken.svg', 46,  68],
  ['core_temple_ruins',         '/sprites/core_temple/core_temple_ruins.svg',        120,  96],

  // new tiles (not in TILE_KEYS, decorative/extended biome tiles)
  ['ash',            '/tiles/ash.svg',            64, 40],
  ['cracked_sand',   '/tiles/cracked_sand.svg',   64, 40],
  ['flower_grass',   '/tiles/flower_grass.svg',   64, 40],
  ['moss_stone',     '/tiles/moss_stone.svg',     64, 40],
  ['packed_ice',     '/tiles/packed_ice.svg',     64, 40],
  ['water_freezing', '/tiles/water_freezing.svg', 64, 40],
  ['water_hot',      '/tiles/water_hot.svg',      64, 40],
);

export const ASSET_MANIFEST: [string, string, number, number][] = _manifest;
