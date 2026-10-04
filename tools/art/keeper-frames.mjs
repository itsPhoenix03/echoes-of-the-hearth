// Derives the keeper clips the art pack does not ship, from frames it does.
//
//   node tools/art/keeper-frames.mjs
//
// All human frames share one 32×48 template: body group → legs, torso, two
// stroke-drawn arm groups (the second mirrored), then neck/head/vest. The pack's
// villager walk is re-dressed as the keeper (TEMPLATE) and its parts are cut
// out and re-posed, so every derived clip stays on-model:
//
//   keeper_walk_NN    8-step walk: knee-bending legs (plant → push → lift →
//                     swing through), body dips on contact, arms near still
//   keeper_chop_NN    one-handed axe cut into the trunk on the facing side
//   keeper_mine_NN    two-handed overhead pick, striking the ground ahead
//   keeper_spick_NN   the same swing with the stone pick
//   keeper_pickup_NN  bend at the hips, reach down, grab, straighten
//   keeper_jump_NN    standing jump: crouch, both feet up and tucked, soft landing
//   keeper_leap_NN    running jump: stride carries into a leap, lands on the lead foot
//   keeper_torch_NN   kneel and plant a torch in the ground ahead
//   keeper_row_NN     seated in the boat, two-handed paddle stroke (+ boat_front.svg)
//   keeper_slash_NN   level sword cut toward the facing side
//   keeper_islash_NN  the same cut with the ice-sword blade colours
//   keeper_punch_NN   the same lunge, empty fist (unarmed strike)
//   keeper_swim_NN    water band + ground shadow removed, below-waist faded so
//                     the legs read as submerged (rewritten in place, idempotent)
//
// Swings that reach past the body use a 64×48 canvas with viewBox -16..48, so
// the body stays centred and the sprite origin is the same as every 32×48
// frame. Tools are held in the facing-side arm (the mirrored arm group, image
// right); the rig flips the whole sprite to face left. Tool direction θ is in
// image space: 0 = level toward the facing side, −90 = straight up.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/sprites');
const read = (n) => readFileSync(`${SPR}/${n}.svg`, 'utf8');
const write = (n, s) => writeFileSync(`${SPR}/${n}.svg`, s);
const frames = (prefix) =>
  readdirSync(SPR).filter((f) => new RegExp(`^${prefix}_\\d\\d\\.svg$`).test(f)).map((f) => f.slice(0, -4)).sort();
const r2 = (n) => +n.toFixed(2);
const pad = (i) => String(i + 1).padStart(2, '0');
const SVG32 = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48" viewBox="0 0 32 48">';
const SVG64 = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="-16 0 64 48">';

// ── TEMPLATE: the villager walk frame re-dressed as the keeper ──────────────
const VILLAGER_TO_KEEPER = {
  '#534738': '#394454', // trousers
  '#3b3028': '#382e29', // boots + belt
  '#80634a': '#456d89', // shirt + sleeves
  '#d0b27b': '#a9c4c4', // shirt sheen
  '#896248': '#885d47', // skin outline
  '#bf8b63': '#bf865f', // skin
  '#e1b18b': '#e5af80', // skin highlight
};
const NECK = /<path d="M ?14 +22h ?4v ?3h ?-4Z"/;
const PROP = /<g transform="translate\([^)]*\) rotate\(\s*-?[\d.]+\s*\)">[\s\S]*?<\/g>/;
const keeperBase = read('keeper');
const keeperTail = keeperBase.slice(keeperBase.search(NECK), keeperBase.lastIndexOf('</svg>')).trimEnd();

const TEMPLATE = (() => {
  const src = read('villager_walk_05');
  const cut = src.search(NECK);
  if (cut < 0) throw new Error('template: neck not found');
  const unmapped = new Set();
  const body = src.slice(0, cut).replace(/#[0-9a-f]{6}/gi, (c) => {
    const k = VILLAGER_TO_KEEPER[c.toLowerCase()];
    if (k) return k;
    if (!/^#(16151a|302d2b|292623|3f3b37|433d38|c4a879)$/i.test(c)) unmapped.add(c);
    return c;
  });
  if (unmapped.size) throw new Error(`template: unmapped colours ${[...unmapped]}`);
  return `${body}${keeperTail}</g></svg>\n`;
})();

// parts cut out of the template
const INNER = TEMPLATE.slice(TEMPLATE.indexOf('>', TEMPLATE.indexOf('<g')) + 1, TEMPLATE.lastIndexOf('</g>'));
const [SHADOW_EL, LEG_L, LEG_R, BOOT_L, BOOT_R] = INNER.match(/<ellipse[^>]*\/>|<path[^>]*\/>/g);
const UPPER = INNER.slice(INNER.indexOf(BOOT_R) + BOOT_R.length);        // torso → arms → head
const TORSO = UPPER.slice(0, UPPER.indexOf('<g>'));                       // torso + belt
const CALM_FACE = UPPER.slice(UPPER.search(NECK));                        // neck, head, hair, vest
const atk = read('keeper_attack_04');
const GRIT_FACE = atk.slice(atk.search(NECK), atk.search(PROP));          // the pack's impact expression
const ARM_L = /<g>[\s\S]*?<\/g>/, ARM_R = /<g transform="translate\(\s*32\s+0\)\s*scale\(\s*-1\s+1\)">[\s\S]*?<\/g>/;
if (!TORSO.includes('#c4a879') || !CALM_FACE.includes('#688fa5') || !GRIT_FACE.includes('#688fa5') || !ARM_L.test(UPPER) || !ARM_R.test(UPPER))
  throw new Error('template: parts not found');
// The vest trim, collar and pouch are drawn after the head in the source art;
// posed clips put them on the torso instead, so an arm crossing the chest
// covers them rather than the trim showing through the sleeve.
const VEST_EL = /<path[^>]*(?:fill="#688fa5"|stroke="#d3cec0"|fill="#ad9472")[^>]*\/>/g;
const VEST = CALM_FACE.match(VEST_EL).join('');
const CALM_HEAD = CALM_FACE.replace(VEST_EL, '');
const GRIT_HEAD = GRIT_FACE.replace(VEST_EL, '');
const BODY = TORSO + VEST;

// ── drawing helpers ─────────────────────────────────────────────────────────
/** One stroke-drawn arm, shoulder (10,25) → elbow → hand, in arm-local space. */
const ARM = (ex, ey, hx, hy) => {
  const up = `M10 25Q${r2((10 + ex) / 2 - .6)} ${r2((25 + ey) / 2)} ${r2(ex)} ${r2(ey)}`;
  const fo = `M${r2(ex)} ${r2(ey)}Q${r2((ex + hx) / 2)} ${r2((ey + hy) / 2)} ${r2(hx)} ${r2(hy)}`;
  return `<path d="${up}" fill="none" stroke="#433d38" stroke-width="4.6" stroke-linecap="round"/>` +
    `<path d="${up}" fill="none" stroke="#456d89" stroke-width="3.9" stroke-linecap="round"/>` +
    `<path d="${fo}" fill="none" stroke="#885d47" stroke-width="3.5" stroke-linecap="round"/>` +
    `<path d="${fo}" fill="none" stroke="#bf865f" stroke-width="2.8" stroke-linecap="round"/>` +
    `<ellipse cx="${r2(hx)}" cy="${r2(hy)}" rx="1.6" ry="2" fill="#e5af80" stroke="#885d47" stroke-width=".4"/>`;
};
/** Arm drawn on the image left (unmirrored group), elbow/hand in image space. */
const armLeft = (e, h) => `<g>${ARM(e[0], e[1], h[0], h[1])}</g>`;
/** Arm drawn on the image right / facing side (mirrored group), image space. */
const armRight = (e, h) => `<g transform="translate(32 0) scale(-1 1)">${ARM(32 - e[0], e[1], 32 - h[0], h[1])}</g>`;
/** Elbow for a reach from shoulder `s` to hand `h`, bowed `bow` px (+ = down/out). */
const elbow = (s, h, bow) => {
  const mx = (s[0] + h[0]) / 2, my = (s[1] + h[1]) / 2, d = Math.hypot(h[0] - s[0], h[1] - s[1]) || 1;
  return [mx - ((h[1] - s[1]) / d) * bow, my + ((h[0] - s[0]) / d) * bow];
};

// Legs: hip → knee → ankle with two-bone IK (knee bends toward the facing side),
// trouser strokes in the template's colours, boot carried to the ankle.
const SEG = 4.25;
const BOOT_ANKLE = { L: [12.4, 42], R: [20, 42] };
const leg = (side, hip, ankle, tilt = 0) => {
  const [hx, hy] = hip, [ax, ay] = ankle;
  const vx = ax - hx, vy = ay - hy, d = Math.hypot(vx, vy) || 1;
  const reach = Math.min(d, 2 * SEG - 0.01);
  const h = Math.sqrt(Math.max(0, SEG * SEG - (reach / 2) ** 2));
  const kx = hx + vx / 2 + (vy / d) * h, ky = hy + vy / 2 - (vx / d) * h;
  const p = `M${r2(hx)} ${r2(hy)}L${r2(kx)} ${r2(ky)}L${r2(ax)} ${r2(ay)}`;
  const [bx, by] = BOOT_ANKLE[side];
  const boot = side === 'L' ? BOOT_L : BOOT_R;
  return `<path d="${p}" fill="none" stroke="#302d2b" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${p}" fill="none" stroke="#394454" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<g transform="translate(${r2(ax - bx)} ${r2(ay - by)}) rotate(${r2(tilt)} ${bx} ${by})">${boot}</g>`;
};
const HIP_L = 12.5, HIP_R = 19.5, HIP_Y = 34;
/** Both legs: hips dropped by `dy`; ankle offsets [dx, lift] per side. */
const legs = (dy, l, r) =>
  leg('L', [HIP_L, HIP_Y + dy], [BOOT_ANKLE.L[0] + l[0], 42 - l[1]], -l[1] * 6) +
  leg('R', [HIP_R, HIP_Y + dy], [BOOT_ANKLE.R[0] + r[0], 42 - r[1]], r[1] * 6);

/** A tool group placed at hand `h` pointing along θ (image degrees). */
const tool = (art, h, th) => `<g transform="translate(${r2(h[0])} ${r2(h[1])}) rotate(${r2(th + 90)})">${art}</g>`;
const dir = (th) => [Math.cos((th * Math.PI) / 180), Math.sin((th * Math.PI) / 180)];

// ── tool art, hand space (handle along −y, head at the top) ─────────────────
const HANDLE = '<path d="M-.8 4V-12H.8V4Z" fill="#805b3b" stroke="#5d422f" stroke-width=".45"/>';
const AXE = HANDLE +
  '<path d="M.6-14.2 5.6-15.6Q7.6-11.6 5.6-7.6L.6-9.2Z" fill="#9aa3a8" stroke="#3e4b50" stroke-width=".55"/>' +
  '<path d="M5.4-14.8Q6.9-11.6 5.4-8.4" fill="none" stroke="#e1e8e2" stroke-width=".55"/>' +
  '<path d="M-.6-13.6-2.6-13.1V-10.4L-.6-10Z" fill="#6c767b" stroke="#3e4b50" stroke-width=".45"/>';
const PICK = HANDLE +
  '<path d="M-7.2-10Q0-16.4 7.2-10L6.4-9.2Q0-13.6-6.4-9.2Z" fill="#b8bec8" stroke="#3e4b50" stroke-width=".55"/>' +
  '<path d="M-5-11.6Q0-14.6 5-11.6" fill="none" stroke="#eef2f4" stroke-width=".45"/>' +
  '<path d="M-1.3-13.6H1.3V-10.6H-1.3Z" fill="#6c767b"/>';
const SPICK = PICK
  .replace('#b8bec8', '#6a6f78').replace('stroke="#3e4b50"', 'stroke="#2d3036"')
  .replace('#eef2f4', '#9aa0a8').replace('#6c767b', '#4a4e55');
const SWORD =
  '<path d="M-1.3 -1 -2.1 -12 0 -16 2.1 -12 1.3 -1Z" fill="#c4d4d2" stroke="#415963" stroke-width=".55"/>' +
  '<path d="M0 -14V-3" stroke="#eff7e8" stroke-width=".65"/>' +
  '<path d="M-4 -2 4 -2 4 -.7 -4 -.7Z" fill="#8b6e4c"/>' +
  '<path d="M-.8 -1H.8V4H-.8Z" fill="#694a34"/><circle cx="0" cy="4" r="1" fill="#b79a6d"/>';
const ICE = { '#c4d4d2': '#9ad4e8', '#415963': '#2f6f86', '#eff7e8': '#e6fbff', '#8b6e4c': '#4a5568', '#694a34': '#3b4250' };
const SPRIG = // a pulled handful: two leaves on a stem, drawn around the hand
  '<path d="M0 0Q-.6-2.6 .8-4.4" fill="none" stroke="#5a7a34" stroke-width=".7"/>' +
  '<path d="M.6-3.6Q3-5.6 4-3.2Q2-2.2.6-3.6Z" fill="#7fae4e" stroke="#3f5e27" stroke-width=".4"/>' +
  '<path d="M.2-2.2Q-2.6-3.8-3.4-1.4Q-1.4-.6.2-2.2Z" fill="#6c9a42" stroke="#3f5e27" stroke-width=".4"/>';

const SMILE = /<path d="M14\.1 21Q16 21\.6 17\.9 21"[^>]*\/>/;
const OPEN_MOUTH = '<path d="M15 20.7Q16 20.1 17 20.7Q17.5 22 16 22.4Q14.5 22 15 20.7Z" fill="#74493d"/>' +
  '<path d="M15.3 21Q16 21.3 16.7 21" fill="none" stroke="#dda482" stroke-width=".4"/>';

const SHOULDER_L = [10, 25], SHOULDER_R = [22, 25];
const ease = (t) => t * t * (3 - 2 * t);

// ── walk: 8 steps, legs carry it, arms barely move ──────────────────────────
// Each foot: stance (planted, sliding back under the body) for half the cycle,
// swing (lifted, carried forward) for the other half; the feet are half a cycle
// apart. The body is lowest when the feet are spread (contact) and highest as
// one leg passes under it. Arms hang and sway a hair against the legs.
{
  const STRIDE = 2.4, LIFT = 1.9;
  const foot = (ph) => {
    ph = ((ph % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (ph < Math.PI) { const s = ph / Math.PI; return [STRIDE - 2 * STRIDE * s, 0]; }
    const s = (ph - Math.PI) / Math.PI;
    return [-STRIDE + 2 * STRIDE * ease(s), LIFT * Math.sin(Math.PI * s)];
  };
  for (let k = 0; k < 8; k++) {
    const ph = (k / 8) * 2 * Math.PI;
    const l = foot(ph), r = foot(ph + Math.PI);
    const dy = 0.45 - 0.9 * Math.abs(Math.sin(ph));
    // arms: hang close, swing opposite their own-side leg by under a pixel
    const la = -0.35 * (l[0] / STRIDE), ra = -0.35 * (r[0] / STRIDE);
    const arms =
      armLeft([7.6 + la * 0.5, 30.3], [7.5 + la, 35.4]) +
      armRight([24.4 + ra * 0.5, 30.3], [24.5 + ra, 35.4]);
    write(`keeper_walk_${pad(k)}`,
      SVG32 + SHADOW_EL + legs(dy, l, r) +
      `<g transform="translate(0 ${r2(dy)}) rotate(2 16 40)">${BODY}${arms}${CALM_HEAD}</g></svg>\n`);
  }
}

// ── posed tool swings (64×48) ───────────────────────────────────────────────
// row: lean°, hip drop, tool hand [x,y], θ°, off hand [x,y] | 'grip' (two-handed)
const swing = (name, art, rows, { pivot = [16, 40], face = GRIT_HEAD, stance = [[-1.2, 0], [2.4, 0]] } = {}) => {
  rows.forEach(([lean, dy, h, th, off], i) => {
    const e = elbow(SHOULDER_R, h, -1.2);
    let offHand = off, offElbow;
    if (off === 'grip') {
      const [cx, cy] = dir(th);
      offHand = [h[0] - cx * 4, h[1] - cy * 4];                      // lower on the haft
      offElbow = elbow(SHOULDER_L, offHand, 1.6);
    } else offElbow = elbow(SHOULDER_L, offHand, 1.2);
    write(`keeper_${name}_${pad(i)}`,
      SVG64 + SHADOW_EL + legs(dy, stance[0], stance[1]) +
      `<g transform="translate(0 ${r2(dy)}) rotate(${lean} ${pivot[0]} ${pivot[1]})">` +
      `${BODY}${tool(art, h, th)}${armLeft(offElbow, offHand)}${armRight(e, h)}${face}</g></svg>\n`);
  });
};

// axe: one-handed, cocked back over the shoulder, cut lands level in the trunk
swing('chop', AXE, [
  [0,  0,   [20.5, 30.5], -55,  [5.5, 32]],    // 01 ready, axe forward-up
  [-4, 0,   [17, 25],     -110, [6, 31]],      // 02 lift
  [-7, .5,  [14.5, 22.5], -150, [7, 30]],      // 03 cocked behind the shoulder
  [0,  1,   [21, 23.5],   -70,  [5, 30.5]],    // 04 swinging through
  [6,  1.5, [28, 27],     -8,   [3.5, 29]],    // 05 impact: level into the trunk
  [6,  1.5, [28, 27.5],   -4,   [3.5, 29.5]],  // 06 bite, held
  [2,  .8,  [24, 29],     -30,  [4.5, 31]],    // 07 wrench free
  [0,  0,   [21, 30.5],   -50,  [5.5, 32]],    // 08 recover
]);

// picks: two-handed overhead swing, tip driven into the ground ahead
const MINE = [
  [0,  0,   [21, 30],     -60,  'grip'],       // 01 ready
  [-4, 0,   [18, 23],     -115, 'grip'],       // 02 raise
  [-7, 0,   [15.5, 19.5], -160, 'grip'],       // 03 over the head
  [0,  .5,  [21, 21.5],   -80,  'grip'],       // 04 coming down
  [8,  2,   [26, 28],     35,   'grip'],       // 05 strike the ground ahead
  [9,  2.2, [26.5, 28.5], 40,   'grip'],       // 06 bite, held
  [4,  1,   [23, 28],     10,   'grip'],       // 07 pry loose
  [0,  0,   [21, 30],     -45,  'grip'],       // 08 recover
];
swing('mine', PICK, MINE);
swing('spick', SPICK, MINE);

// ── pickup: bend at the hips, reach the ground, grab, straighten ────────────
{
  // lean°, hip drop, hand [x,y] (body space, before the lean), holding?
  const PICKUP = [
    [5,  1,   [21, 33],   false],   // 01 lean in
    [13, 3,   [24, 38.5], false],   // 02 reach down
    [16, 3.5, [25, 39.5], false],   // 03 fingers at the ground
    [16, 3.5, [24.5, 39], true],    // 04 grab
    [9,  2,   [22.5, 35], true],    // 05 lift
    [3,  .5,  [20, 31.5], true],    // 06 up to the chest
    [0,  0,   [19.5, 32.5], true],  // 07 settle
  ];
  PICKUP.forEach(([lean, dy, h, held], i) => {
    const e = elbow(SHOULDER_R, h, -1.4);
    // off hand braces on the near knee while bent, hangs once upright
    const bent = lean > 8;
    const offHand = bent ? [10.5, 35.5] : [7.5, 35.2];
    const offElbow = bent ? [7.4, 30.6] : [7.6, 30.3];
    const item = held ? `<g transform="translate(${r2(h[0])} ${r2(h[1] - 1)})">${SPRIG}</g>` : '';
    write(`keeper_pickup_${pad(i)}`,
      SVG32 + SHADOW_EL + legs(dy, [-0.6, 0], [1.2, 0]) +
      `<g transform="translate(0 ${r2(dy)}) rotate(${lean} 16 35)">` +
      `${BODY}${armLeft(offElbow, offHand)}${armRight(e, h)}${item}${CALM_HEAD}</g></svg>\n`);
  });
}

// ── swim: no water band, no ground shadow, legs fading under the surface ────
const WATER = /<path d="M0 32Q4 30 8 32T16 32T24 32T32 32V48H0Z"[^>]*\/><path d="M0 32Q4 30 8 32T16 32T24 32T32 32"[^>]*\/>/;
const SHADOW = /<ellipse cx=" ?16" cy=" ?45\.5"[^>]*\/>/;
const UNDERWATER =
  '<defs><linearGradient id="kw-g" x1="0" y1="0" x2="0" y2="48" gradientUnits="userSpaceOnUse">' +
  '<stop offset=".69" stop-color="#fff"/><stop offset=".74" stop-color="#6e6e6e"/></linearGradient>' +
  '<mask id="kw-m" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="48">' +
  '<rect width="32" height="48" fill="url(#kw-g)"/></mask></defs>';
const WATERLINE = '<path d="M5 34.2Q10.5 32.9 16 34.2T27 34.2" fill="none" stroke="#e3f6ff" stroke-width=".7" opacity=".75"/>';
for (const f of frames('keeper_swim')) {
  let src = read(f).replace(WATER, '');
  if (!src.includes('kw-m')) {
    src = src.replace(SHADOW, '');
    const open = src.indexOf('>') + 1, close = src.lastIndexOf('</svg>');
    src = src.slice(0, open) + UNDERWATER + '<g mask="url(#kw-m)">' + src.slice(open, close) + '</g>' + WATERLINE + '</svg>\n';
  }
  write(f, src);
}

// ── jumps: the legs do the work, the arms stay close ────────────────────────
// No ground shadow in either clip: the rig draws one that stays on the ground
// while bodyRoot carries the body up. Hands move a pixel or so at most.
/** Both arms near rest; `ox` pushes the hands out (+) / in, `oy` down (+) / up; `sw` swings them apart. */
const quietArms = (ox, oy, sw = 0) =>
  armLeft([7.6 - ox * 0.5 + sw * 0.3, 30.3 + oy * 0.5], [7.5 - ox + sw * 0.6, 35.4 + oy]) +
  armRight([24.4 + ox * 0.5 - sw * 0.3, 30.3 + oy * 0.5], [24.5 + ox - sw * 0.6, 35.4 + oy]);
const headFor = (open) => (open ? CALM_HEAD.replace(SMILE, OPEN_MOUTH) : CALM_HEAD);

// standing jump: straight up — deep crouch, both feet leave together and tuck
// evenly, then a soft two-footed landing.
//   dy (hip drop), feet lift, feet spread, arms out, arms down, open mouth
const JUMP = [
  [3,   0,   .4, .3,  .4,  false],  // 01 gather: deep crouch
  [-1,  .6,  0,  -.2, -1.1, false], // 02 launch: body long, toes leaving
  [0,   2.6, .5, .4,  -.8, true],   // 03 rise: knees drawing up
  [0,   3.6, .8, .8,  -.5, true],   // 04 apex: tucked
  [0,   1.4, .5, .6,  -.3, true],   // 05 fall: legs reaching for the ground
  [3,   0,   .6, .7,  .3,  false],  // 06 land: absorb
  [1,   0,   .2, .2,  .1,  false],  // 07 recover
];
JUMP.forEach(([dy, lift, spread, ox, oy, open], i) => {
  write(`keeper_jump_${pad(i)}`,
    SVG32 + legs(dy, [-spread, lift], [spread, lift]) +
    `<g transform="translate(0 ${r2(dy)})">${BODY}${quietArms(ox, oy)}${headFor(open)}</g></svg>\n`);
});

// running jump: no stop to crouch — the stride carries into a leap. Lead leg
// drives forward and up, the back leg trails, the body leans into the run and
// lands on the lead foot, already stepping on.
//   dy, lean°, back foot [dx, lift], lead foot [dx, lift], arm swing, open mouth
const LEAP = [
  [.5,  4, [-2.4, 0],   [2, 2.6],   .5, false],  // 01 take-off off the back foot
  [-.5, 5, [-3, 1.4],   [3, 2.4],   .7, true],   // 02 drive: lead knee up
  [0,   4, [-3.2, 2.4], [3.2, 2],   .7, true],   // 03 stretched stride in the air
  [0,   3, [-2.6, 3],   [3, 2.6],   .6, true],   // 04 apex
  [0,   3, [-1.6, 2.6], [2.6, .6],  .4, false],  // 05 lead foot reaching down
  [2.5, 3, [-1.4, 1],   [2.2, 0],   .3, false],  // 06 land on the lead foot
  [.8,  2, [-.2, 1.2],  [1.2, 0],   .1, false],  // 07 back leg swinging through
];
LEAP.forEach(([dy, lean, back, lead, sw, open], i) => {
  write(`keeper_leap_${pad(i)}`,
    SVG32 + legs(dy, back, lead) +
    `<g transform="translate(0 ${r2(dy)}) rotate(${lean} 16 40)">${BODY}${quietArms(0, 0, sw)}${headFor(open)}</g></svg>\n`);
});

// ── boat: seated inside the hull, two-handed paddle stroke ──────────────────
// The rig draws `boat` behind the keeper and `boat_front` (the near gunwale cut
// out of boat.svg) in front, so the keeper sits *in* the boat: tunic hem and
// knees show above the near wall, everything lower is hidden by it. Frame hip
// height (y 34) lines up with the boat floor; see rig.ts BOAT_SEAT.
{
  // near wall of boat.svg: between the interior's lower edge and the keel line
  write('boat_front',
    '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="30" viewBox="0 0 56 30">' +
    '<path d="M10 19 28 25 46 19 48 21Q41 26 28 27Q14 26 7 21Z" fill="#64452e" stroke="#342c28" stroke-width=".8" stroke-linejoin="round"/>' +
    '<path d="M10 19 28 25 46 19" fill="none" stroke="#b78a55" stroke-width=".7"/>' +
    '<path d="m7 20 9 3m24 0 9-3m-23 6 4 0" stroke="#bc8c55" stroke-width=".8"/></svg>\n');

  const KNEES = // seated: thighs come toward the viewer, knees just over the gunwale
    '<ellipse cx="13" cy="38.6" rx="3.1" ry="2.3" fill="#394454" stroke="#302d2b" stroke-width=".5"/>' +
    '<ellipse cx="19.4" cy="38.6" rx="3.1" ry="2.3" fill="#394454" stroke="#302d2b" stroke-width=".5"/>';
  /** Paddle from the top grip T through the lower hand L, blade past L; blade faded while under water. */
  const paddle = (T, L, wet) => {
    const dx = L[0] - T[0], dy = L[1] - T[1], d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
    const top = [T[0] - ux * 2, T[1] - uy * 2], neck = [L[0] + ux * 9, L[1] + uy * 9], bc = [L[0] + ux * 12.5, L[1] + uy * 12.5];
    const ang = r2((Math.atan2(uy, ux) * 180) / Math.PI - 90);
    const shaft = `M${r2(top[0])} ${r2(top[1])}L${r2(neck[0])} ${r2(neck[1])}`;
    return `<path d="${shaft}" stroke="#3e2b25" stroke-width="2.1" stroke-linecap="round"/>` +
      `<path d="${shaft}" stroke="#8a5f3a" stroke-width="1.3" stroke-linecap="round"/>` +
      `<g opacity="${wet ? .5 : 1}"><ellipse cx="${r2(bc[0])}" cy="${r2(bc[1])}" rx="1.9" ry="3.8" transform="rotate(${ang} ${r2(bc[0])} ${r2(bc[1])})" fill="#9a6b40" stroke="#3e2b25" stroke-width=".5"/></g>`;
  };
  // lean°, top hand T (off arm, at the chest), lower hand L (facing arm), blade in water?
  const ROW = [
    [3,  [17, 25.5],   [25.5, 32],   true],    // 01 catch: reach forward, blade in
    [1,  [16.5, 26.5], [24.5, 33.5], true],    // 02 pull
    [-1, [15.5, 27.5], [23, 34.5],   true],    // 03 pull through
    [-2, [14.5, 28],   [21.5, 34.5], true],    // 04 exit at the hip
    [-2, [14.5, 27],   [21.5, 32.5], false],   // 05 lift out (also the resting pose)
    [0,  [15.5, 25.5], [23, 31],     false],   // 06 recover
    [2,  [16.5, 24.5], [24.5, 30.5], false],   // 07 recover, reaching
    [3,  [17, 25],     [25.5, 31.5], false],   // 08 blade dropping in
  ];
  ROW.forEach(([lean, T, L, wet], i) => {
    const off = armLeft(elbow(SHOULDER_L, T, 1.4), T);
    const lead = armRight(elbow(SHOULDER_R, L, -1.2), L);
    write(`keeper_row_${pad(i)}`,
      SVG64 + KNEES +
      `<g transform="rotate(${lean} 16 36)">${BODY}${paddle(T, L, wet)}${off}${lead}${CALM_HEAD}</g></svg>\n`);
  });
}

// ── torch: hold it up, kneel, plant it in the ground ahead, let go, stand ───
// Frames 01–03 carry the torch in the hand; from 04 it stands planted at a fixed
// spot on the ground (image space, outside the leaning body) and the hand comes
// to it / leaves it, so it never wobbles once it is in the earth.
{
  const TORCH =
    '<path d="M-1 6H1L1.4-3H-1.4Z" fill="#754a30" stroke="#3e2b25" stroke-width=".5"/>' +
    '<path d="M-1.9-3.8H1.9V-1.2H-1.9Z" fill="#483b32" stroke="#201d1e" stroke-width=".4"/>' +
    '<path d="M0-12Q3-9 2.4-6.4Q2-4.4 0-3.8Q-2-4.4-2.4-6.4Q-3-9 0-12Z" fill="#e3612e"/>' +
    '<path d="M0-9.6Q1.4-7.6 1-6.2Q.7-4.8 0-4.6Q-.8-4.9-1-6.2Q-1.2-7.6 0-9.6Z" fill="#ffca61"/>';
  const PLANT = [27, 38];                                 // grip point once planted (bottom at y 44)
  // lean°, hip drop, hand [x,y] in image space, torch: 'hand' | 'planted', hand on it?
  const ROWS = [
    [0,  0,   [26.5, 31], 'hand',    true],   // 01 torch held out at the side
    [6,  1,   [27, 33.5], 'hand',    true],   // 02 lean in
    [12, 3,   [27, 36],   'hand',    true],   // 03 kneel, torch coming down
    [14, 3.5, PLANT,      'planted', true],   // 04 driven into the ground
    [13, 3.2, [23.5, 35], 'planted', false],  // 05 let go
    [6,  1.2, [21.5, 33], 'planted', false],  // 06 rising
    [0,  0,   [20, 33.5], 'planted', false],  // 07 standing, torch burning ahead
  ];
  // the hand is drawn inside the leaning body: map image space back into it
  const toBody = ([x, y], lean, dy) => {
    const a = (-lean * Math.PI) / 180, px = x - 16, py = y - dy - 35;
    return [16 + px * Math.cos(a) - py * Math.sin(a), 35 + px * Math.sin(a) + py * Math.cos(a)];
  };
  ROWS.forEach(([lean, dy, hImg, where], i) => {
    const h = toBody(hImg, lean, dy);
    const e = elbow(SHOULDER_R, h, -1.3);
    const bent = lean > 8;
    const offHand = bent ? [10.5, 35.5] : [7.5, 35.2];
    const offElbow = bent ? [7.4, 30.6] : [7.6, 30.3];
    const held = where === 'hand' ? tool(TORCH, h, -90 - lean) : '';   // stays upright in the world
    const planted = where === 'planted' ? tool(TORCH, PLANT, -90) : '';
    write(`keeper_torch_${pad(i)}`,
      SVG32 + SHADOW_EL + legs(dy, [-0.6, 0], [1.2, 0]) + planted +
      `<g transform="translate(0 ${r2(dy)}) rotate(${lean} 16 35)">` +
      `${BODY}${armLeft(offElbow, offHand)}${armRight(e, h)}${CALM_HEAD}${held}</g></svg>\n`);
  });
}

// ── slash: a level cut at the enemy, not an overhead chop ───────────────────
//  lean° front-leg back-leg  sword elbow   sword hand   θ°    off elbow    off hand
const SLASH = [
  [-3,  0,  2,  20,   30,   17,  27.5, -12,  7,   28.5, 5.5, 31.5],  // 01 draw back across the chest
  [-4,  2,  3,  21.5, 29,   19,  26.5, -16,  6.5, 27.5, 4.5, 30],    // 02 coiled, blade level behind the cut
  [2,   8,  4,  24,   27,   26,  25.5, -6,   6,   27,   3,   29],    // 03 lunge, blade sweeping out
  [5,  13,  6,  26,   25.5, 30,  25,   0,    5.5, 26.5, 2,   28],    // 04 impact: arm and blade level at the enemy
  [5,  13,  6,  26,   26.5, 30,  26.5, 9,    5.5, 27,   2.5, 29],    // 05 follow-through, tip dipping
  [2,   8,  4,  24,   28,   26,  28.5, 12,   6,   28,   3.5, 30.5],  // 06 drawing back
  [0,   3,  2,  21.5, 30,   21,  31,   18,   7,   28.5, 5.5, 31.5],  // 07 recover, blade lowered
];
{
  const ice = SWORD.replace(/#[0-9a-f]{6}/gi, (c) => ICE[c.toLowerCase()] ?? c);
  const legAt = (x, rot, a, b) => `<g transform="rotate(${rot} ${x} 34)">${a}${b}</g>`;
  SLASH.forEach(([lean, fr, bk, sex, sey, shx, shy, th, oex, oey, ohx, ohy], i) => {
    // punch: the same lunge with an empty fist — the unarmed strike
    for (const [name, art] of [['slash', SWORD], ['islash', ice], ['punch', '']])
      write(`keeper_${name}_${pad(i)}`,
        SVG64 + SHADOW_EL + legAt(12.5, bk, LEG_L, BOOT_L) + legAt(19.5, -fr, LEG_R, BOOT_R) +
        `<g transform="rotate(${lean} 16 40)">${BODY}${armLeft([oex, oey], [ohx, ohy])}` +
        `${tool(art, [shx, shy], th)}${armRight([sex, sey], [shx, shy])}${GRIT_HEAD}</g></svg>\n`);
  });
}

console.log('keeper frames derived');
