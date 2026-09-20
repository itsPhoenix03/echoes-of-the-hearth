// Canonical dump of every resolved export of shared/defs.js.
// Used to prove the JSON extraction changed nothing: run before the change,
// run after, diff the two files.  Key ORDER is preserved (it is observable via
// JSON.stringify and Object.keys), Sets are tagged, functions are probed.
import * as defs from '../../shared/defs.js';

const enc = (v) => {
  if (v instanceof Set) return { __set: [...v] };
  if (typeof v === 'function') return { __fn: v.name || 'anon', arity: v.length };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = enc(v[k]);   // insertion order
    return o;
  }
  return v;
};

const out = {};
for (const k of Object.keys(defs).sort()) out[k] = enc(defs[k]);

// Functions cannot be serialized, so probe their behaviour instead.
const inv = { wood: 5, stone: 0 };
out.__probe_canAfford = [
  defs.canAfford(inv, { wood: 5 }), defs.canAfford(inv, { wood: 6 }),
  defs.canAfford(inv, { wood: 1, stone: 1 }), defs.canAfford(inv, {}),
];
const payInv = { wood: 10, stone: 4, fiber: 1 };
defs.pay(payInv, { wood: 3, stone: 4 });
out.__probe_pay = payInv;
out.__probe_emptyInv = defs.emptyInv();
out.__probe_emptyInvKeys = Object.keys(defs.emptyInv());
out.__probe_emptyInvJSON = JSON.stringify(defs.emptyInv());
// Numeric-keyed lookups must still work through coercion.
out.__probe_nodeDefNumericKey = [defs.NODE_DEF[0], defs.NODE_DEF[5]];

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
