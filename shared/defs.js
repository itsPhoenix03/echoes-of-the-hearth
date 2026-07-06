// Shared game definitions — recipes, nodes, structures. Used by client UI and server validation.

export const NODE_KEYS = ['tree', 'boulder', 'bush', 'stone', 'crystal', 'starmetal'];
export const NODE = { TREE: 0, BOULDER: 1, BUSH: 2, STONE: 3, CRYSTAL: 4, STARMETAL: 5 };
// [hp, tool required (null=hand), yield resource, yield amount, respawn seconds]
export const NODE_DEF = {
  0: { hp: 3, tool: null, axeBonus: true, res: 'wood', n: 3, respawn: 180 },
  1: { hp: 4, tool: 'pick', res: 'stone', n: 4, respawn: 240 },
  2: { hp: 1, tool: null, res: 'fiber', n: 2, respawn: 90 },
  3: { hp: 1, tool: null, res: 'stone', n: 1, respawn: 120 },
  4: { hp: 4, tool: 'spick', res: 'crystal', n: 3, respawn: 300 },
  5: { hp: 6, tool: 'spick', res: 'starmetal', n: 2, respawn: 900 }
};

export const RECIPES = {
  workbench: { cost: { wood: 8 }, station: null, place: true },
  campfire:  { cost: { wood: 5, stone: 3 }, station: null, place: true },
  axe:       { cost: { wood: 6, fiber: 4 }, station: 'workbench', tool: true },
  pick:      { cost: { wood: 6, stone: 4 }, station: 'workbench', tool: true },
  spick:     { cost: { wood: 8, stone: 10 }, station: 'workbench', tool: true },
  sword:     { cost: { wood: 5, stone: 8, fiber: 2 }, station: 'workbench', tool: true },
  heatcloak: { cost: { fiber: 15, wood: 5 }, station: 'workbench', gear: true },
  furcloak:  { cost: { fiber: 20, wood: 8 }, station: 'workbench', gear: true },
  wall:      { cost: { wood: 4 }, station: 'workbench', place: true },
  forge:     { cost: { wood: 25, stone: 20, crystal: 6 }, station: 'workbench', place: true },
  cookedmeat:{ cost: { meat: 1, wood: 1 }, station: 'campfire' },
  torch:     { cost: { wood: 2, fiber: 1 }, station: null },
  chest:     { cost: { wood: 8 }, station: 'workbench', place: true },
  bed:       { cost: { wood: 10, fiber: 6 }, station: 'workbench', place: true },
  boat:      { cost: { wood: 25, fiber: 10 }, station: 'workbench' },
  sboat:     { cost: { wood: 20, fiber: 8, starmetal: 5 }, station: 'workbench' },
  mineshaft: { cost: { wood: 10, stone: 5 }, station: 'workbench', place: true },
  shelter:   { cost: { wood: 20, stone: 10 }, station: 'workbench', place: true },
  isword:    { cost: { iron: 6, wood: 4 }, station: 'forge', tool: true },
  core:      { cost: { crystal: 8, essence: 4 }, station: 'forge' },
  engine:    { cost: { wood: 40, stone: 40, crystal: 15, essence: 10 }, station: 'forge', place: true, engineOnly: true }
};

export const NAMES = {
  workbench: 'Workbench', campfire: 'Campfire', axe: 'Wooden Axe', pick: 'Wooden Pickaxe',
  spick: 'Stone Pickaxe', sword: 'Stone Sword', heatcloak: 'Heat Cloak', furcloak: 'Fur Cloak',
  wall: 'Palisade Wall', forge: 'Aether Forge', core: 'Monolith Core', engine: 'World Engine',
  wood: 'Wood', stone: 'Stone', fiber: 'Fiber', crystal: 'Crystal', essence: 'Essence',
  water: 'Water', meat: 'Raw Meat', cookedmeat: 'Cooked Meat',
  iron: 'Iron', diamond: 'Diamond', mineshaft: 'Mine Entrance', shelter: 'Shelter', isword: 'Iron Sword',
  starmetal: 'Starmetal', boat: 'Boat', sboat: 'Reinforced Boat', torch: 'Torch',
  chest: 'Chest', bed: 'Bed'
};
export const FURNITURE = new Set(['chest', 'bed', 'torch']);   // placeable only inside shelters (torch also in mines)

export const STRUCT_HP = { wall: 20, campfire: 10, workbench: 15, forge: 30, engine: 120, mineshaft: 25, shelter: 40 };
export const WOODEN = new Set(['wall', 'workbench']);   // erode in Blight Storms w/o campfire
export const RESOURCES = ['wood', 'stone', 'fiber', 'crystal', 'essence', 'iron', 'diamond', 'starmetal'];
export const PLACEABLES = ['wall', 'campfire', 'workbench', 'forge', 'engine', 'mineshaft', 'shelter'];

export const emptyInv = () => ({ wood: 0, stone: 0, fiber: 0, crystal: 0, essence: 0, iron: 0, diamond: 0, starmetal: 0, water: 0, meat: 0, cookedmeat: 0, wall: 0, campfire: 0, workbench: 0, forge: 0, engine: 0, core: 0, mineshaft: 0, shelter: 0, boat: 0, sboat: 0, torch: 0, chest: 0, bed: 0 });
export const canAfford = (inv, cost) => Object.entries(cost).every(([k, v]) => inv[k] >= v);
export const pay = (inv, cost) => Object.entries(cost).forEach(([k, v]) => inv[k] -= v);
