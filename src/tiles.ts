// Streamed terrain store.
//
// Before Slice 1 the client called genWorld() and held the entire generated world in
// memory. The Go game server is now the sole source of truth for what terrain *is*, and
// streams it as 64x64 chunks (docs/10_GO_WIRE_PROTOCOL.md §4). This module owns the tile
// arrays the renderer reads and knows which chunks have actually arrived.
//
// Field names deliberately mirror the old genWorld() return value (`tiles`, `elev`,
// `veins`, `waterTemp`, `tileVis`, `nodes`, `decor`, `bergs`) so every existing read site
// in main.ts keeps working verbatim.

import { SIZE } from "../shared/world.js";

/** Chunk edge in tiles. The server also sends this in `init.chunk`; this is the default. */
export const CHUNK = 64;
/** Chunks along one world edge. */
export const CHUNK_GRID = SIZE / CHUNK;
/** Tiles per chunk — the exact decoded length every RLE layer must have. */
export const CHUNK_TILES = CHUNK * CHUNK;

/**
 * Sentinel tile value for "this tile has not been streamed yet". Real tile types are
 * 0..5 (see T in shared/world.js), so 255 can never collide. It is distinct from
 * T.WATER on purpose: water is walkable, and painting the void as ocean would invite the
 * player to swim into terrain that does not exist yet.
 */
export const UNLOADED = 255;

const N = SIZE * SIZE;

/**
 * RLE decode (§4.3): base64 of 2-byte runs `(value, count 1..255)`.
 * Returns null — never a partial buffer — if the payload is malformed or does not decode
 * to exactly `want` bytes. The spec requires such a chunk to be dropped, not rendered.
 */
export function decodeRLE(b64: string, want = CHUNK_TILES): Uint8Array | null {
  if (typeof b64 !== "string") return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length % 2 !== 0) return null;
  const out = new Uint8Array(want);
  let o = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const v = bin.charCodeAt(i) & 0xff;
    const n = bin.charCodeAt(i + 1) & 0xff;
    if (n === 0) return null; // a zero-length run is malformed
    if (o + n > want) return null; // overlong: corrupt
    out.fill(v, o, o + n);
    o += n;
  }
  return o === want ? out : null;
}

/** Raw `chunk` message shape, as received. */
export interface ChunkMsg {
  cx: number;
  cy: number;
  tiles: string;
  elev: string;
  veins: string;
  waterTemp: string;
  tileVis: string;
  nodes?: [number, number][];
  decor?: [number, string][];
  bergs?: number[];
  digs?: number[];
  /** [localIdx, kind, hp, dir, lvl] — `dir` drives fence/decor orientation and must survive. */
  structs?: any[][];
}

/** Everything a freshly applied chunk introduced, in WORLD tile indices. */
export interface ChunkDelta {
  cx: number;
  cy: number;
  nodes: number[];
  decor: [number, string][];
  bergs: number[];
  digs: number[];
  structs: { i: number; kind: string; hp: number; dir: number; lvl: number }[];
}

export class TileStore {
  // The five layers are 1.6 MB each. They are allocated on first touch rather than in the
  // constructor so a client that never enters a world never pays for them.
  private _tiles: Uint8Array | null = null;
  private _elev: Uint8Array | null = null;
  private _veins: Uint8Array | null = null;
  private _waterTemp: Uint8Array | null = null;
  private _tileVis: Uint8Array | null = null;

  get tiles(): Uint8Array {
    return (this._tiles ??= new Uint8Array(N).fill(UNLOADED));
  }
  get elev(): Uint8Array {
    return (this._elev ??= new Uint8Array(N).fill(1));
  }
  get veins(): Uint8Array {
    return (this._veins ??= new Uint8Array(N));
  }
  get waterTemp(): Uint8Array {
    return (this._waterTemp ??= new Uint8Array(N));
  }
  get tileVis(): Uint8Array {
    return (this._tileVis ??= new Uint8Array(N));
  }

  nodes = new Map<number, number>();
  decor = new Map<number, string>();
  bergs = new Set<number>();

  /** Chunk keys (cy * CHUNK_GRID + cx) that have been fully applied. */
  private loaded = new Set<number>();
  /** Chunks dropped as corrupt, so the warning is logged once per chunk, not per frame. */
  private corrupt = new Set<number>();

  chunkKey(cx: number, cy: number) {
    return cy * CHUNK_GRID + cx;
  }

  /** Has chunk (cx, cy) arrived? */
  chunkLoaded(cx: number, cy: number) {
    return this.loaded.has(this.chunkKey(cx, cy));
  }

  /**
   * Has the chunk containing this tile arrived? Out-of-bounds counts as loaded: the
   * renderer paints open ocean outside the world and always has.
   */
  loadedAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return true;
    return this.loaded.has(
      this.chunkKey((x | 0) / CHUNK | 0, (y | 0) / CHUNK | 0),
    );
  }

  /** Number of chunks applied so far — handy for HUD/loading copy. */
  get loadedCount() {
    return this.loaded.size;
  }

  /**
   * Decode and apply one `chunk` frame. Returns null (and warns once) if any layer is
   * corrupt — nothing is written in that case, so a bad frame can never half-paint.
   */
  applyChunk(m: ChunkMsg): ChunkDelta | null {
    const { cx, cy } = m;
    if (
      !Number.isInteger(cx) ||
      !Number.isInteger(cy) ||
      cx < 0 ||
      cy < 0 ||
      cx >= CHUNK_GRID ||
      cy >= CHUNK_GRID
    ) {
      console.warn("[tiles] chunk out of range", cx, cy);
      return null;
    }
    const key = this.chunkKey(cx, cy);
    const layers = {
      tiles: decodeRLE(m.tiles),
      elev: decodeRLE(m.elev),
      veins: decodeRLE(m.veins),
      waterTemp: decodeRLE(m.waterTemp),
      tileVis: decodeRLE(m.tileVis),
    };
    for (const [name, buf] of Object.entries(layers)) {
      if (!buf) {
        if (!this.corrupt.has(key)) {
          this.corrupt.add(key);
          console.warn(
            `[tiles] chunk ${cx},${cy} dropped: layer "${name}" did not decode to ${CHUNK_TILES} bytes`,
          );
        }
        return null;
      }
    }

    const x0 = cx * CHUNK,
      y0 = cy * CHUNK;
    const T_ = this.tiles,
      E = this.elev,
      V = this.veins,
      W = this.waterTemp,
      TV = this.tileVis;
    for (let ly = 0; ly < CHUNK; ly++) {
      const src = ly * CHUNK;
      const dst = (y0 + ly) * SIZE + x0;
      T_.set(layers.tiles!.subarray(src, src + CHUNK), dst);
      E.set(layers.elev!.subarray(src, src + CHUNK), dst);
      V.set(layers.veins!.subarray(src, src + CHUNK), dst);
      W.set(layers.waterTemp!.subarray(src, src + CHUNK), dst);
      TV.set(layers.tileVis!.subarray(src, src + CHUNK), dst);
    }

    // localIdx -> world tile index
    const world = (local: number) =>
      (y0 + ((local / CHUNK) | 0)) * SIZE + (x0 + (local % CHUNK));
    const inRange = (local: any) =>
      Number.isInteger(local) && local >= 0 && local < CHUNK_TILES;

    const delta: ChunkDelta = {
      cx,
      cy,
      nodes: [],
      decor: [],
      bergs: [],
      digs: [],
      structs: [],
    };
    for (const e of m.nodes || []) {
      if (!Array.isArray(e) || !inRange(e[0])) continue;
      const i = world(e[0]);
      this.nodes.set(i, e[1] | 0);
      delta.nodes.push(i);
    }
    for (const e of m.decor || []) {
      if (!Array.isArray(e) || !inRange(e[0])) continue;
      const i = world(e[0]);
      this.decor.set(i, String(e[1]));
      delta.decor.push([i, String(e[1])]);
    }
    for (const local of m.bergs || []) {
      if (!inRange(local)) continue;
      const i = world(local);
      this.bergs.add(i);
      delta.bergs.push(i);
    }
    for (const local of m.digs || []) {
      if (!inRange(local)) continue;
      delta.digs.push(world(local));
    }
    for (const e of m.structs || []) {
      if (!Array.isArray(e) || !inRange(e[0])) continue;
      // Spec tuple is [localIdx, kind, hp, dir, lvl]. A 4-tuple (no dir) is tolerated so a
      // server that has not caught up yet still renders, with dir defaulting to 0.
      const [local, kind, hp, a, b] = e;
      const has5 = e.length >= 5;
      delta.structs.push({
        i: world(local),
        kind: String(kind),
        hp: hp | 0,
        dir: has5 ? a | 0 : 0,
        lvl: (has5 ? b : a) | 0 || 1,
      });
    }

    this.loaded.add(key);
    this.corrupt.delete(key);
    return delta;
  }

  /**
   * Legacy path only: adopt a locally generated world wholesale and mark every chunk
   * loaded. Used when `?legacy=1` points the client at the old :8081 server, which never
   * sends chunks.
   */
  loadFull(w: {
    tiles: Uint8Array;
    elev: Uint8Array;
    veins: Uint8Array;
    waterTemp: Uint8Array;
    tileVis: Uint8Array;
    nodes: Map<number, number>;
    decor?: Map<number, string>;
    bergs: Set<number>;
  }) {
    this._tiles = w.tiles;
    this._elev = w.elev;
    this._veins = w.veins;
    this._waterTemp = w.waterTemp;
    this._tileVis = w.tileVis;
    this.nodes = w.nodes;
    this.decor = w.decor || new Map();
    this.bergs = w.bergs;
    for (let k = 0; k < CHUNK_GRID * CHUNK_GRID; k++) this.loaded.add(k);
  }
}
