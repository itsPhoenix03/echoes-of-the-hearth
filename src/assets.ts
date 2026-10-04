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
  ['boat_front', '/sprites/boat_front.svg',       56, 30],  // near gunwale, drawn over a seated keeper (rig.ts)
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
  ['ice_crystal_cluster', '/sprites/ice_crystal_cluster.svg', 50, 52],
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
  // --- decor & farming sprites ---
  ['farmplot',       '/sprites/farmplot.svg',                          64, 40],
  ['crop',           '/sprites/crop.svg',                              30, 34],
  ['mod_banner_blank','/sprites/building_materials/mod_banner_blank.svg', 34, 54],
  ['mod_floor_stone', '/sprites/building_materials/mod_floor_stone.svg',  64, 40],
  ['mod_railing',    '/sprites/building_materials/mod_railing.svg',    64, 38],
  ['cloth_roll',     '/sprites/building_materials/cloth_roll.svg',     50, 36],
);

// --- remaining staged assets (registered so future wiring can never hit a missing texture) ---
_manifest.push(
  ['lantern',        '/sprites/lantern.svg',        24, 52],   // WIRED: lantern decor item
  ['ladder',         '/sprites/ladder.svg',         26, 56],   // WIRED: mine exit marker
  ['drowned',        '/sprites/drowned.svg',        42, 38],   // WIRED: amphibious enemy
  ['blight_lancer',  '/sprites/blight_lancer.svg',  52, 72],   // WIRED: slow siege beam-caster
  ['lava',           '/tiles/lava.svg',             64, 40],
  ['blightedtree',   '/sprites/blightedtree.svg',   48, 64],
  ['blightheart',    '/sprites/blightheart.svg',    42, 46],
  ['bridge',         '/sprites/bridge.svg',         64, 44],
  ['fire',           '/sprites/fire.svg',           36, 42],
  ['fish',           '/sprites/fish.svg',           30, 16],
  ['golem',          '/sprites/golem.svg',          72, 76],
  ['keeper',         '/sprites/keeper.svg',         32, 48],
  ['obsidian',       '/sprites/obsidian.svg',       38, 32],
  ['ruins',          '/sprites/ruins.svg',          56, 52],
  ['shaman',         '/sprites/shaman.svg',         36, 52],
  ['tribal',         '/sprites/tribal.svg',         36, 50],
  ['villager',       '/sprites/villager.svg',       32, 48],
  ['villager2',      '/sprites/villager2.svg',      32, 48],
);
// --- Medicine + Medic feature ---
_manifest.push(
  ['medic',      '/sprites/medic.svg',      42, 58],
  ['medic_snow', '/sprites/medic_snow.svg', 42, 58],
  ['medicine',   '/sprites/medicine.svg',   28, 28],
  ['medic_hut',      '/sprites/medic_hut.svg',      96, 88],
  ['medic_hut_snow', '/sprites/medic_hut_snow.svg', 96, 88],
);

const _BM: [string, number, number][] = [
  ['clay_bricks', 56, 38], ['crystal_lattice', 54, 44], ['glass_pane', 44, 46],
  ['mod_bridge_segment', 74, 44], ['mod_door', 42, 52],
  ['mod_floor_thatch', 64, 40], ['mod_floor_wood', 64, 40],
  ['mod_pillar_stone', 38, 64], ['mod_pillar_wood', 36, 62],
  ['mod_wall_crystal', 64, 58], ['mod_wall_stone', 64, 54], ['mod_wall_wood', 64, 54],
  ['reed_thatch', 58, 36], ['rope_coil', 44, 38],
  ['stone_blocks', 56, 40], ['wood_planks', 52, 36],
];
for (const [k, w, h] of _BM) _manifest.push([k, `/sprites/building_materials/${k}.svg`, w, h]);
const _RAW: [string, number, number][] = [
  ['ingot_bronze', 46, 30], ['ingot_copper', 46, 30], ['ingot_iron', 46, 30], ['ingot_starmetal', 46, 30],
  ['raw_ash', 42, 30], ['raw_beeswax', 42, 34], ['raw_bone', 46, 30], ['raw_clay', 42, 34], ['raw_coal', 42, 34],
  ['raw_copper_ore', 44, 38], ['raw_crystal_shard', 40, 42],
  ['raw_dye_blue', 34, 38], ['raw_dye_green', 34, 38], ['raw_dye_red', 34, 38],
  ['raw_fiber_bundle', 44, 36], ['raw_hide', 48, 38], ['raw_iron_ore', 44, 38], ['raw_lime', 42, 32],
  ['raw_obsidian_shard', 40, 42], ['raw_oil_pot', 38, 42], ['raw_resin', 36, 40], ['raw_sand', 42, 30],
  ['raw_starmetal_nugget', 42, 36], ['raw_tin_ore', 44, 38],
];
for (const [k, w, h] of _RAW) _manifest.push([k, `/sprites/building_materials/raw/${k}.svg`, w, h]);

// --- hand-synced human clips: `<char>_<action>_01..NN`, same canvas as the character base ---
// Played by rig.ts (keeper) and Phaser anims `<char>_<action>` (NPCs/medics, see registerHumanAnims).
export const HUMAN_CLIPS: [string, string, number][] = [
  ['keeper', 'build', 9],
  ['keeper', 'injured', 7], ['keeper', 'meds', 7], ['keeper', 'shiver', 9],
  ['keeper', 'sweat', 9], ['keeper', 'swim', 9],
  // posed by tools/art/keeper-frames.mjs from the pack's template parts
  ['keeper', 'walk', 8], ['keeper', 'chop', 8], ['keeper', 'mine', 8], ['keeper', 'spick', 8],
  ['keeper', 'pickup', 7], ['keeper', 'punch', 7],
  ['keeper', 'slash', 7], ['keeper', 'islash', 7], ['keeper', 'jump', 7], ['keeper', 'leap', 7], ['keeper', 'torch', 7], ['keeper', 'row', 8],
  ['villager', 'walk', 9], ['villager', 'collect', 9], ['villager', 'build', 9], ['villager', 'sit', 7],
  ['villager2', 'walk', 9], ['villager2', 'collect', 9], ['villager2', 'craft', 9], ['villager2', 'sit', 7],
  ['medic', 'walk', 9], ['medic', 'heal', 9], ['medic', 'prepare', 9],
  ['medic_snow', 'walk', 9], ['medic_snow', 'heal', 9], ['medic_snow', 'prepare', 9], ['medic_snow', 'shiver', 9],
];
// swings that reach past the 32px body canvas: 64×48, body still centred
const _HUMAN_WIDE = new Set([
  'keeper_slash', 'keeper_islash', 'keeper_punch', 'keeper_chop', 'keeper_mine', 'keeper_spick', 'keeper_row',
]);
const _HUMAN_SIZE: Record<string, [number, number]> = {
  keeper: [32, 48], villager: [32, 48], villager2: [32, 48], medic: [42, 58], medic_snow: [42, 58],
};
export const humanFrame = (char: string, action: string, i: number) =>
  `${char}_${action}_${String(i).padStart(2, '0')}`;
for (const [c, a, n] of HUMAN_CLIPS) {
  const [w, h] = _HUMAN_WIDE.has(`${c}_${a}`) ? [64, 48] : _HUMAN_SIZE[c];
  for (let i = 1; i <= n; i++) { const k = humanFrame(c, a, i); _manifest.push([k, `/sprites/${k}.svg`, w, h]); }
}

// --- pickup pop effects: `<res>_pop_01..05`, 32×40, shared ground contact at y=36 ---
export const POP_RES = ['wood', 'stone', 'meat', 'fiber', 'crystal', 'starmetal', 'iron', 'essence', 'diamond'];
export const POP_FRAME_MS = [45, 65, 75, 70, 95];   // pack's suggested timing
for (const r of POP_RES)
  for (let i = 1; i <= POP_FRAME_MS.length; i++) {
    const k = `${r}_pop_0${i}`;
    _manifest.push([k, `/sprites/pickup/${k}.svg`, 32, 40]);
  }

export const ASSET_MANIFEST: [string, string, number, number][] = _manifest;
