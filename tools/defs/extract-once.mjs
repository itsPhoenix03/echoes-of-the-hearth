// One-shot: lift the data out of the ORIGINAL shared/defs.js into shared/defs.json.
// Kept in the tree as the audit trail for how defs.json was produced.
import { writeFileSync } from 'node:fs';
import * as d from '../../shared/defs.js';

const json = {
  MAX_HP: d.MAX_HP,
  MEDICINE_HEAL: d.MEDICINE_HEAL,
  NODE_KEYS: d.NODE_KEYS,
  NODE: d.NODE,
  NODE_DEF: d.NODE_DEF,
  RECIPES: d.RECIPES,
  NAMES: d.NAMES,
  FURNITURE: [...d.FURNITURE],
  STRUCT_HP: d.STRUCT_HP,
  WOODEN: [...d.WOODEN],
  RESOURCES: d.RESOURCES,
  PLACEABLES: d.PLACEABLES,
  DECOR_NONBLOCKING: [...d.DECOR_NONBLOCKING],
  CROPS: d.CROPS,
  INV_KEYS: Object.keys(d.emptyInv()),
  MEDIC_TRADE_POOLS: d.MEDIC_TRADE_POOLS,
};
writeFileSync(new URL('../../shared/defs.json', import.meta.url), JSON.stringify(json, null, 2) + '\n');
console.log('wrote shared/defs.json');
