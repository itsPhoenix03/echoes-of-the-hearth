// Parity runner: generates every seed in seeds.json with both the JavaScript
// shared/world.js and the Go port (gameserver/world), compares the digests,
// and on any mismatch dumps the offending field from both sides and reports
// the FIRST differing tile index with both values.
//
//   node tools/worldparity/compare.mjs
//
// Exit code 0 = bit-exact parity on every seed and every field.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEEDS, ARRAY_FIELDS, MAP_FIELDS, digestSeed } from './digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const GOMOD = path.join(REPO, 'gameserver');
const SEEDS_JSON = path.join(HERE, 'seeds.json');
const FIELDS = [...ARRAY_FIELDS, ...MAP_FIELDS];

function go(args) {
  return execFileSync('go', args, { cwd: GOMOD, encoding: 'utf8', maxBuffer: 1 << 28 });
}

console.log(`worldparity: ${SEEDS.length} seeds x ${FIELDS.length} fields\n`);

// Build into a temp dir so no binary is left in the repo.
const BUILD = mkdtempSync(path.join(tmpdir(), 'worldparity-bin-'));
const GOBIN = path.join(BUILD, process.platform === 'win32' ? 'worldparity.exe' : 'worldparity');
console.log('building Go digester...');
go(['build', '-o', GOBIN, './cmd/worldparity']);
process.on('exit', () => rmSync(BUILD, { recursive: true, force: true }));

const goRun = (args) =>
  execFileSync(GOBIN, args, { cwd: GOMOD, encoding: 'utf8', maxBuffer: 1 << 28 });

console.log('running Go worldgen...');
const goDigests = JSON.parse(goRun(['-seeds', SEEDS_JSON, '-mode', 'digest']));
console.log('running JS worldgen...');
const jsDigests = SEEDS.map(digestSeed);

// --- report table -----------------------------------------------------------
const rows = [];
let failures = 0;
for (let si = 0; si < SEEDS.length; si++) {
  const js = jsDigests[si];
  const gd = goDigests[si];
  for (const f of FIELDS) {
    const ok = js[f] === gd[f];
    if (!ok) failures++;
    rows.push({ seed: SEEDS[si], field: f, ok, si, js: js[f], go: gd[f] });
  }
  for (const c of ['nodesCount', 'bergsCount', 'decorCount']) {
    if (js[c] !== gd[c]) {
      failures++;
      rows.push({ seed: SEEDS[si], field: c, ok: false, si, js: js[c], go: gd[c] });
    }
  }
}

const w1 = Math.max(4, ...SEEDS.map((s) => s.length));
console.log(`\n${'seed'.padEnd(w1)}  ${'field'.padEnd(10)}  result`);
console.log('-'.repeat(w1 + 22));
for (const r of rows) {
  console.log(`${r.seed.padEnd(w1)}  ${r.field.padEnd(10)}  ${r.ok ? 'MATCH' : 'DIFFER'}`);
}
console.log();

// --- first-difference diagnostics -------------------------------------------
if (failures) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'worldparity-'));
  try {
    for (const r of rows.filter((x) => !x.ok && FIELDS.includes(x.field))) {
      const jsFile = path.join(tmp, `js-${r.si}-${r.field}.bin`);
      const goFile = path.join(tmp, `go-${r.si}-${r.field}.bin`);
      execFileSync(process.execPath, [path.join(HERE, 'digest.mjs'), 'dump', String(r.si), r.field, jsFile]);
      goRun(['-seeds', SEEDS_JSON, '-mode', 'dump', '-seed', String(r.si), '-field', r.field, '-out', goFile]);
      const a = readFileSync(jsFile);
      const b = readFileSync(goFile);
      console.error(`=== MISMATCH  seed=${JSON.stringify(r.seed)}  field=${r.field}`);
      console.error(`    js sha=${r.js}`);
      console.error(`    go sha=${r.go}`);
      if (ARRAY_FIELDS.includes(r.field)) {
        if (a.length !== b.length) console.error(`    length differs: js=${a.length} go=${b.length}`);
        const n = Math.min(a.length, b.length);
        let diffs = 0;
        for (let i = 0; i < n; i++) {
          if (a[i] !== b[i]) {
            if (diffs === 0) {
              console.error(`    FIRST DIFFERING TILE index=${i} (x=${i % 1280}, y=${Math.floor(i / 1280)})`);
              console.error(`      js value = ${a[i]}`);
              console.error(`      go value = ${b[i]}`);
            }
            diffs++;
          }
        }
        console.error(`    total differing tiles: ${diffs} / ${n}`);
      } else {
        const la = a.toString('utf8').split('\n');
        const lb = b.toString('utf8').split('\n');
        console.error(`    entries: js=${la.length - 1} go=${lb.length - 1}`);
        const n = Math.min(la.length, lb.length);
        let diffs = 0;
        for (let i = 0; i < n; i++) {
          if (la[i] !== lb[i]) {
            if (diffs === 0) {
              console.error(`    FIRST DIFFERING ENTRY at sorted position ${i}`);
              console.error(`      js = ${JSON.stringify(la[i])}`);
              console.error(`      go = ${JSON.stringify(lb[i])}`);
            }
            diffs++;
          }
        }
        console.error(`    total differing entries: ${diffs} / ${n}`);
      }
      console.error();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.error(`PARITY FAILED: ${failures} mismatched field(s).`);
  process.exit(1);
}

console.log(`PARITY OK: all ${SEEDS.length} seeds match on all ${FIELDS.length} fields (plus counts).`);
console.log('hearth-1 digest:');
console.log(JSON.stringify(jsDigests[0], null, 2));
