# worldparity — JS ↔ Go worldgen parity harness

Proves that the Go port in `gameserver/world` produces a **bit-exact** copy of
the world produced by `shared/world.js`. `test.mjs` asserts against concrete
tiles and nodes of `genWorld('hearth-1')`, so any divergence would silently
invalidate the whole protocol suite.

## Run it

From the repo root:

```sh
node tools/worldparity/compare.mjs
```

Requires Node (for the reference implementation) and `go` on PATH. It builds
the Go digester into a temp directory (nothing is left in the repo), generates
every seed in `seeds.json` on both sides, prints a seed × field table, and
exits non-zero on any mismatch.

The Go unit test pins the same digests without needing Node:

```sh
cd gameserver && go test ./...
```

## What is compared

Per seed:

| field | encoding hashed |
| --- | --- |
| `tiles`, `elev`, `veins`, `waterTemp`, `tileVis` | raw 1,638,400 bytes of the `Uint8Array` |
| `nodes` | `"<tileIndex> <kind>\n"` lines, sorted by tile index |
| `bergs` | `"<tileIndex>\n"` lines, sorted |
| `decor` | `"<tileIndex> <propKey>\n"` lines, sorted |

Everything is SHA-256'd. Entry counts are compared separately so a
count mismatch is reported even when the contents also differ.

Sorting matters: JS `Map`/`Set` iterate in insertion order while Go map
iteration is randomised, so the digest must not depend on iteration order.

## On mismatch

`compare.mjs` re-runs both sides in `dump` mode for the offending field, writes
the raw bytes to a temp dir, and prints:

```
=== MISMATCH  seed="hearth-1"  field=elev
    js sha=59eb30...
    go sha=83fbda...
    FIRST DIFFERING TILE index=138060 (x=1100, y=107)
      js value = 3
      go value = 2
    total differing tiles: 1089 / 1638400
```

For `nodes`/`bergs`/`decor` it prints the first differing entry of the sorted
listing instead.

## Files

- `seeds.json` — the seed list, shared by both sides. Seeds are referenced by
  **index** on the command line so non-ASCII seeds never have to survive a
  shell. `πλ-🌊-9` is deliberately included: it exercises `Mash`'s
  `charCodeAt` over UTF-16 code units including a surrogate pair.
- `digest.mjs` — reference (JavaScript) side. Importable as a library; as a CLI:
  `node tools/worldparity/digest.mjs digest`, or
  `node tools/worldparity/digest.mjs dump <seedIndex> <field> <outFile>`.
- `compare.mjs` — the runner.
- `../../gameserver/cmd/worldparity` — Go side, same two modes:
  `go run ./cmd/worldparity -seeds ../tools/worldparity/seeds.json` (run from
  `gameserver/`).

## Adding a seed

Append it to `seeds.json` and re-run `compare.mjs`. Nothing else needs editing.
