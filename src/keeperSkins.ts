import Phaser from 'phaser';

/* ────────────────────────────────────────────────────────────────────────────
 * Keeper skins — per-player shirt colour and worn gear, baked into textures.
 *
 * The keeper art has one fixed blue shirt and no gear. A skin is that same
 * frame set with (a) the shirt fills recoloured, (b) the Starmetal Armor
 * breastplate and/or (c) the keeper-equipment cloak drape injected into the
 * body group, so they follow every body motion while the arms, head and held
 * prop stay drawn on top. Layering, inside out: shirt → armor → cloak.
 *
 * Skin 0 without gear is the shipped art: its keys are the plain frame keys
 * the preloader already made, so nothing is generated for the common case.
 * Any other skin is built once per texture manager (lazily, async); until it
 * is ready the rig keeps showing the plain frames.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Shirt palette; index 0 is the art's own blue. Spread for legibility at 32px. */
export const SHIRTS = [
  '#456d89', '#a24a3c', '#4f7f3a', '#6d4c8f', '#b8742c', '#2f8a82', '#a8902e', '#a24f7f',
];
export const SHIRT_HEX = SHIRTS.map((s) => parseInt(s.slice(1), 16));

/** Stable palette slot from the server-broadcast name — every client agrees. */
export function shirtFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
  return h % SHIRTS.length;
}

export type Cloak = 'furcloak' | 'heatcloak' | null;

// keeper-equipment pack, fur/heat_cloak_idle_01 drape (32×48, keeper torso space)
const CLOAK_ART: Record<'furcloak' | 'heatcloak', string> = {
  furcloak:
    '<path d="M9 22q7-3 14 0l3 8 3 13-6 1-2-7-5 0-2 7-6-1 3-13Z" fill="#775b45" stroke="#4f3e33" stroke-width=".6"/>' +
    '<path d="m9 24-2 6-2 13 4 1 3-13 1-5Zm14 0 2 6 2 13-4 1-3-13-1-5Z" fill="#a17e60"/>' +
    '<path d="M9 22q7 5 14 0l2 4-6 4-3-4-3 4-6-4Z" fill="#d7c6a9" stroke="#4f3e33" stroke-width=".5"/>' +
    '<path d="m12 26 4 3 4-3" fill="none" stroke="#4f3e33" stroke-width=".6"/>' +
    '<circle cx="16" cy="29" r=".8" fill="#cfb784"/>' +
    '<path d="m7 26 2 2m14-2 2 2m-16 7 2 2m12-2-2 2" stroke="#eadcc3" stroke-width=".8"/>',
  heatcloak:
    '<path d="M9 22q7-3 14 0l3 8 3 13-6 1-2-7-5 0-2 7-6-1 3-13Z" fill="#9f4933" stroke="#6f3a30" stroke-width=".6"/>' +
    '<path d="m9 24-2 6-2 13 4 1 3-13 1-5Zm14 0 2 6 2 13-4 1-3-13-1-5Z" fill="#c87540"/>' +
    '<path d="M9 22q7 5 14 0l2 4-6 4-3-4-3 4-6-4Z" fill="#d89c5d" stroke="#6f3a30" stroke-width=".5"/>' +
    '<path d="m12 26 4 3 4-3" fill="none" stroke="#6f3a30" stroke-width=".6"/>' +
    '<circle cx="16" cy="29" r=".8" fill="#cfb784"/>' +
    '<path d="m10 33 2 2m10-2-2 2" stroke="#e6b369" stroke-width=".8"/>',
};

const CLOAK_TAG: Record<'furcloak' | 'heatcloak', string> = { furcloak: 'f', heatcloak: 'h' };

// Starmetal Armor, keeper torso space: slate cuirass with a pale steel plate,
// the starmetal star on the chest, and pauldrons the arms are drawn over.
const ARMOR_ART =
  '<ellipse cx="9.6" cy="25.6" rx="3" ry="2.1" fill="#6e8393" stroke="#253547" stroke-width=".5"/>' +
  '<ellipse cx="22.4" cy="25.6" rx="3" ry="2.1" fill="#6e8393" stroke="#253547" stroke-width=".5"/>' +
  '<path d="M10.3 24.4Q16 22.6 21.7 24.4L22.9 34.6Q16 37.2 9.1 34.6Z" fill="#4b5b70" stroke="#253547" stroke-width=".6"/>' +
  '<path d="M11.8 25.4Q16 24.1 20.2 25.4L21 32.9Q16 34.9 11 32.9Z" fill="#6e8393" stroke="#9eb8bc" stroke-width=".45"/>' +
  '<path d="M16 24.6V34.4" stroke="#41576b" stroke-width=".6"/>' +
  '<path d="M16 27.2 16.8 29 18.7 29.3 17.3 30.5 17.7 32.3 16 31.4 14.3 32.3 14.7 30.5 13.3 29.3 15.2 29Z" fill="#a4dbe1"/>' +
  '<path d="M16 28.3 16.4 29.4 17.5 29.6 16.7 30.3 16.9 31.3 16 30.8 15.1 31.3 15.3 30.3 14.5 29.6 15.6 29.4Z" fill="#d7f2e9"/>';

export function skinId(shirt: number, cloak: Cloak, armor = false): string {
  return `${shirt}${armor ? 'a' : ''}${cloak ? CLOAK_TAG[cloak] : ''}`;
}

/** Texture key of `frame` in a skin ('0' is the shipped art itself). */
export function skinKey(frame: string, id: string): string {
  return id === '0' ? frame : `${frame}@${id}`;
}

const mix = (hex: string, to: number, t: number) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - t) + to * t);
  return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
};

function skinSvg(src: string, shirt: number, cloak: Cloak, armor = false): string {
  let s = src;
  if (cloak || armor) {
    // the vest trim and collar sit on the shirt front — the gear now covers it
    s = s.replace(/<path[^>]*fill="#688fa5"[^>]*\/>/i, '').replace(/<path[^>]*stroke="#d3cec0"[^>]*\/>/i, '');
  }
  // Gear goes right after the belt buckle: over the torso, under arms/head/prop.
  // Cloak first, then armor at the same point, so the cloak ends up outermost.
  const BUCKLE = /(<path[^>]*fill="#c4a879"[^>]*\/>)/i;
  if (cloak) s = s.replace(BUCKLE, `$1${CLOAK_ART[cloak]}`);
  if (armor) s = s.replace(BUCKLE, `$1${ARMOR_ART}`);
  if (shirt) {
    const c = SHIRTS[shirt];
    s = s.replace(/#456d89/gi, c).replace(/#688fa5/gi, mix(c, 255, 0.25));
  }
  return s;
}

const sources = new Map<string, Promise<string>>();
const getSource = (frame: string) => {
  let p = sources.get(frame);
  if (!p) {
    p = fetch(`/sprites/${frame}.svg`).then((r) => {
      if (!r.ok) throw new Error(`keeper skin: ${frame} ${r.status}`);
      return r.text();
    });
    sources.set(frame, p);
  }
  return p;
};

// per texture manager: a game restart gets a fresh manager and rebuilds
const built = new WeakMap<Phaser.Textures.TextureManager, Map<string, boolean>>();

/** True once every frame of skin `id` exists; starts the bake on first ask. */
export function ensureSkin(scene: Phaser.Scene, frames: string[], shirt: number, cloak: Cloak, armor = false): boolean {
  const id = skinId(shirt, cloak, armor);
  if (id === '0') return true;
  const tm = scene.textures;
  let m = built.get(tm);
  if (!m) built.set(tm, (m = new Map()));
  const state = m.get(id);
  if (state !== undefined) return state;
  m.set(id, false);
  Promise.all(
    frames.map(async (f) => {
      const key = skinKey(f, id);
      if (tm.exists(key)) return;
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(skinSvg(await getSource(f), shirt, cloak, armor));
      await img.decode();
      if (!tm.exists(key)) tm.addImage(key, img);
    }),
  ).then(
    () => m!.set(id, true),
    (e) => console.warn('keeper skin failed', id, e),   // stays false: rig keeps the plain art
  );
  return false;
}
