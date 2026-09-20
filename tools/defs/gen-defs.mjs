// Generates shared/defs.js from shared/defs.json.
//
// shared/defs.json is the ONE source of truth for the game's rules data. The Go
// server unmarshals it directly at boot; the browser client, the legacy :8081
// server and test.mjs consume it through the generated shared/defs.js, which
// keeps exactly the export surface those callers already import.
//
// The wrapper is generated rather than doing a runtime `import ... from
// './defs.json'` because there is no JSON-import syntax that works in both this
// repo's Node 18 (needs the deprecated `assert`) and a Vite browser build
// (needs bare or `with`). Generating removes that portability problem while
// still leaving a single authored source; `--check` fails if the two drift.
//
//   node tools/defs/gen-defs.mjs           regenerate shared/defs.js
//   node tools/defs/gen-defs.mjs --check   exit 1 if shared/defs.js is stale
import { readFileSync, writeFileSync } from 'node:fs';

const jsonURL = new URL('../../shared/defs.json', import.meta.url);
const jsURL = new URL('../../shared/defs.js', import.meta.url);
const raw = readFileSync(jsonURL, 'utf8');
const D = JSON.parse(raw);

const body = `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/defs.json  (the Go game server unmarshals the same file).
// Regenerate: node tools/defs/gen-defs.mjs      Verify: node tools/defs/gen-defs.mjs --check
//
// Shared game definitions — recipes, nodes, structures. Used by client UI and server validation.

const D = ${JSON.stringify(D, null, 2)};

export const MAX_HP = D.MAX_HP;
export const MEDICINE_HEAL = D.MEDICINE_HEAL;

export const NODE_KEYS = D.NODE_KEYS;
export const NODE = D.NODE;
// [hp, tool required (null=hand), yield resource, yield amount, respawn seconds]
export const NODE_DEF = D.NODE_DEF;

export const RECIPES = D.RECIPES;

export const NAMES = D.NAMES;
// placeable only inside shelters (torch also in mines)
export const FURNITURE = new Set(D.FURNITURE);

export const STRUCT_HP = D.STRUCT_HP;
// erode in Blight Storms w/o campfire
export const WOODEN = new Set(D.WOODEN);
export const RESOURCES = D.RESOURCES;
export const PLACEABLES = D.PLACEABLES;
// decor kinds that do NOT block movement (fence is blocking, farmplot is walkable)
export const DECOR_NONBLOCKING = new Set(D.DECOR_NONBLOCKING);
export const CROPS = D.CROPS;
// crafted intermediates (planks, blocks, panes...) — spent on building modules,
// never placed directly. Recipes carry material:true; this is the display order.
export const MATERIALS = D.MATERIALS;

export const emptyInv = () => Object.fromEntries(D.INV_KEYS.map((k) => [k, 0]));

// island id -> weighted resource pool a medic on that island may request in a bargain.
// Only 'woods' and 'spire' host a medic in this release; 'dunes'/'marsh' are kept for a later expansion.
export const MEDIC_TRADE_POOLS = D.MEDIC_TRADE_POOLS;

// Not expressible as JSON — these are algorithms, and they stay here by design.
export const canAfford = (inv, cost) => Object.entries(cost).every(([k, v]) => inv[k] >= v);
export const pay = (inv, cost) => Object.entries(cost).forEach(([k, v]) => inv[k] -= v);
`;

if (process.argv.includes('--check')) {
  const on_disk = readFileSync(jsURL, 'utf8');
  if (on_disk !== body) {
    console.error('shared/defs.js is stale — run: node tools/defs/gen-defs.mjs');
    process.exit(1);
  }
  console.log('shared/defs.js is up to date with shared/defs.json');
} else {
  writeFileSync(jsURL, body);
  console.log('wrote shared/defs.js');
}
