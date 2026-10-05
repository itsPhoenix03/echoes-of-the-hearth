// Grounded faces for every human character: weathered survivors, not mascots.
//
//   node tools/art/faces.mjs
//
// The art pack gives all ten humans the same cartoon face — glossy highlight
// blob, big white eyes with shine dots, heavy brows, blush dashes. This pass
// restyles each face element by its ROLE, so every per-frame expression the pack
// animates (squints, gritted teeth, open mouths, shiver brows) keeps its shape:
//
//   highlight blob  → modelled planes: shadowed side of the face, eye sockets,
//                     chin shadow, a little light on the forehead and cheekbone
//   eye whites      → muted toward the skin, pupils smaller and dark brown,
//                     shine dots reduced to a faint glint
//   brows           → thinner;  mouth → thinner, lip-toned;  nose → shaded plane
//   smile lines     → softer
//   blush dashes    → replaced by what each life has left on the face (stubble,
//                     a grizzled beard, freckles, ochre stripes, age lines …)
//
// Idempotent: a restyled file carries a marker and is skipped. Run it BEFORE
// tools/art/keeper-frames.mjs (which copies the keeper's face into the derived
// clips) and again after it — the second run only touches unmarked files.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/sprites');
const MARK = '<!--face:grounded-1-->';
// longest names first so `medic_snow_walk_01` is not read as `medic`
const CHARS = ['ashmark_hunter', 'elder_yvenne', 'woods_child', 'medic_snow', 'villager2', 'villager', 'medic', 'keeper', 'tribal', 'shaman'];

const HEAD = /<path d="M9 14Q9 7 16 6Q23 6 24 14L23 19Q21 24 16 24Q11 24 9 19Z" fill="(#[0-9a-f]{6})" stroke="(#[0-9a-f]{6})"[^>]*\/>/i;
const GLOSS = /<path d="M10 14Q11 8 16 8Q19 8 21 10Q15 9 12 13L11 19Q9\.5 18 10 14Z" fill="(#[0-9a-f]{6})" opacity="\.58"\/>/i;
const BLUSH = /<path d="M11\.4 19\.8 12\.5 20\.2M19\.5 20\.2 20\.6 19\.8"[^>]*\/>/;
const BLUSH_DOTS = /<circle cx="(?:11\.5|20\.5)" cy="19\.5" r="\.26"[^>]*\/>/g;
const JOWLS = /<path d="M11 20Q12 22\.5 15 23M21 20Q20 22\.5 17 23"([^>]*)\/>/;
const NOSE = /(<path d="M15\.9 16\.7 15\.1 19 16\.8 19\.4"[^>]*stroke-width=")\.57("[^>]*\/>)/;

const hex = (c) => parseInt(c.slice(1), 16);
const mix = (a, b, t) => {
  const x = hex(a), y = hex(b);
  const ch = (s) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
};

/** Light and shadow planes that replace the glossy highlight blob. */
const modelling = (skin, line, light) =>
  // shadowed side of the face (light comes from the upper left, like the world art)
  `<path d="M20.6 9.6Q23.6 11.6 23.7 14.6L22.9 19Q21.4 23.3 16.6 23.9Q20.4 21.6 21.4 17.6Q21.9 13.2 20.6 9.6Z" fill="${line}" opacity=".26"/>` +
  // under the chin and the jaw line
  `<path d="M12.2 21.6Q16 24.6 19.8 21.6Q18.6 23.6 16 24Q13.4 23.6 12.2 21.6Z" fill="${line}" opacity=".3"/>` +
  // soft eye sockets under the brow ridge
  `<ellipse cx="13.2" cy="15.7" rx="2.1" ry="1.05" fill="${line}" opacity=".16"/>` +
  `<ellipse cx="18.8" cy="15.7" rx="2.1" ry="1.05" fill="${line}" opacity=".2"/>` +
  // a little light on the forehead and the near cheekbone
  `<path d="M11.2 12.6Q12.4 9.4 16 9Q18.6 9 20 10.4Q16.4 10.2 13.2 12Z" fill="${light}" opacity=".32"/>` +
  `<path d="M10.5 16.9Q11.7 17.3 12.8 18.5Q11.7 19.1 10.8 18.6Z" fill="${light}" opacity=".28"/>`;

/** What each life has left on the face — replaces the blush dashes. */
function features(char, { skin, line, hair }) {
  const grey = mix(hair, '#9b9284', .45);
  switch (char) {
    case 'keeper': // days on the trail: stubble along the jaw and lip
      return `<path d="M10.6 18.6Q11.2 23.2 16 24Q20.8 23.2 21.4 18.6Q21 21.4 18.6 22.4Q16 23.1 13.4 22.4Q11 21.4 10.6 18.6Z" fill="${hair}" opacity=".45"/>` +
        `<path d="M14.2 20.4Q16 19.9 17.8 20.4Q16 20.9 14.2 20.4Z" fill="${hair}" opacity=".38"/>`;
    case 'villager': // older hearthfolk: grizzled full beard and moustache
      return `<path d="M10.5 18.4Q11 23.8 16 24.4Q21 23.8 21.5 18.4Q20.6 21.2 18.4 21.7Q16 22.4 13.6 21.7Q11.4 21.2 10.5 18.4Z" fill="${grey}" opacity=".9"/>` +
        `<path d="M13.8 20.6Q16 19.6 18.2 20.6Q17.2 21.2 16 20.9Q14.8 21.2 13.8 20.6Z" fill="${grey}"/>` +
        `<path d="M12.4 21.4 12.9 22.8M15 22.4 15.1 23.6M17 22.4 16.9 23.6M19.6 21.4 19.1 22.8" stroke="${mix(grey, '#000000', .25)}" stroke-width=".3" opacity=".7"/>`;
    case 'villager2': // a forager's sun freckles
    case 'woods_child':
      return [[12.4, 18.5], [13.3, 19.1], [12.2, 19.6], [19.6, 18.5], [18.7, 19.1], [19.8, 19.6]]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".2" fill="${line}" opacity=".45"/>`).join('');
    case 'medic': // a healer's grey moustache and short chin beard, clear of the collar
      return `<path d="M13.6 20.6Q16 19.4 18.4 20.6Q17.3 21.3 16 21Q14.7 21.3 13.6 20.6Z" fill="#6f685e"/>` +
        `<path d="M14.2 21.5Q16 23.2 17.8 21.5Q17.4 22.9 16 23.2Q14.6 22.9 14.2 21.5Z" fill="#6f685e" opacity=".9"/>`;
    case 'medic_snow': // wind-burn from the Spire
      return `<ellipse cx="12.2" cy="19" rx="1.5" ry=".85" fill="#b5584a" opacity=".24"/>` +
        `<ellipse cx="19.8" cy="19" rx="1.5" ry=".85" fill="#b5584a" opacity=".28"/>`;
    case 'tribal': // Ashmark ochre: stripes under the eyes and down the chin
      return `<path d="M10.8 17.7 13.9 18.2M18.1 18.2 21.2 17.7M10.9 18.9 13.6 19.3M18.4 19.3 21.1 18.9" stroke="#9a3b2a" stroke-width=".7" stroke-linecap="round" opacity=".85"/>` +
        `<path d="M16 22.4V23.8" stroke="#9a3b2a" stroke-width=".8" stroke-linecap="round" opacity=".85"/>`;
    case 'shaman': // ash marks and the lines of a long life
      return `<path d="M13.6 10.9H18.4M16 10.9V12.4" stroke="#e8e2d2" stroke-width=".6" stroke-linecap="round" opacity=".85"/>` +
        `<path d="M14.6 22.6 15 23.6M17.4 22.6 17 23.6" stroke="#e8e2d2" stroke-width=".45" opacity=".8"/>` +
        `<path d="M11.8 12.8Q16 12 20.2 12.8M10.4 16 9.7 15.6M21.6 16 22.3 15.6" fill="none" stroke="${line}" stroke-width=".3" opacity=".5"/>`;
    case 'ashmark_hunter': // a dark band of paint across the eyes, and an old scar
      return `<path d="M9.6 15Q16 13.8 22.4 15L22.2 17.3Q16 16.4 9.8 17.3Z" fill="#241f1c" opacity=".42"/>` +
        `<path d="M12.3 12.5 14.3 15.6" stroke="${mix(skin, '#ffffff', .3)}" stroke-width=".4" stroke-linecap="round"/>`;
    case 'elder_yvenne': // age: forehead lines, crow's feet, deeper cheeks
      return `<path d="M12.4 11.8Q16 11.2 19.6 11.8M12.8 12.8Q16 12.3 19.2 12.8" fill="none" stroke="${line}" stroke-width=".3" opacity=".5"/>` +
        `<path d="M10.4 15.8 9.7 15.4M10.4 16.6 9.6 16.8M21.6 15.8 22.3 15.4M21.6 16.6 22.4 16.8" stroke="${line}" stroke-width=".28" opacity=".55"/>` +
        `<path d="M11.4 18.4Q11.9 20.4 13.2 21.6M20.6 18.4Q20.1 20.4 18.8 21.6" fill="none" stroke="${line}" stroke-width=".3" opacity=".45"/>`;
  }
  return '';
}

// brow colour per character, read from its base art (brows are drawn in hair colour)
const BROW = /<path d="M11\.3 14Q13 13 14\.8 13\.5M17\.2 13\.5Q19 13 20\.7 14" fill="none" stroke="(#[0-9a-f]{6})"/i;
const hairOf = {};
for (const c of CHARS) {
  const m = readFileSync(`${SPR}/${c}.svg`, 'utf8').match(BROW);
  if (!m) throw new Error(`${c}: base brows not found`);
  hairOf[c] = m[1];
}

function restyle(src, char) {
  const head = src.match(HEAD), gloss = src.match(GLOSS);
  if (!head || !gloss || !BLUSH.test(src)) throw new Error('face anchors missing');
  const [, skin, line] = head, light = gloss[1], hair = hairOf[char];
  const lip = mix(line, '#5a2f28', .45);
  let s = src;
  s = s.replace(GLOSS, modelling(skin, line, light));
  // eyes: muted whites, smaller dark pupils, a faint glint instead of a shine dot
  s = s.replace(/fill="#f4e5cc"([^>]*?)stroke-width="\.45"/gi, `fill="${mix('#f4e5cc', skin, .5)}"$1stroke-width=".35"`);
  // narrowed eyes (squint, wince, sweat) are drawn as near-white strokes across the eye band
  s = s.replace(/(<path d="M11\.\d+ 1[56](?:\.\d+)?[^"]*" fill="none" stroke=")#[ef][0-9a-f]{5}(")/gi, `$1${mix('#f4e5cc', skin, .5)}$2`);
  s = s.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="\.73" fill="#2[67]30?[0-9a-f]{1,2}"\/>/gi, '<circle cx="$1" cy="$2" r=".6" fill="#2b221c"/>');
  s = s.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="\.(5|55)" fill="#2[67]30?[0-9a-f]{1,2}"\/>/gi, '<circle cx="$1" cy="$2" r=".$3" fill="#2b221c"/>');
  s = s.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="\.18" fill="#fff5dc"\/>/gi, '<circle cx="$1" cy="$2" r=".11" fill="#fff5dc" opacity=".55"/>');
  // brows (any expression): lines across y 12.5–15 starting at the inner/outer brow
  s = s.replace(/(<path d="M1[01]\.\d+ 1[2-5](?:\.\d+)?[^"]*M17\.\d+ 1[2-5][^"]*"[^>]*stroke-width=")([\d.]+)(")/g,
    (_, a, w, b) => `${a}${(+w * 0.7).toFixed(2)}${b} opacity=".9"`);
  // mouth lines (open/gritted mouths are filled shapes and keep their look)
  s = s.replace(/(<path d="M1[45](?:\.\d+)? 2[01](?:\.\d+)?Q[^"]*" fill="none" stroke=")#[0-9a-f]{6}(" stroke-width=")([\d.]+)(")/gi,
    (_, a, b, w, c) => `${a}${lip}${b}${(+w * 0.8).toFixed(2)}${c}`);
  s = s.replace(NOSE, `$1.45$2<path d="M16.2 16.9 16.9 19.1 16.3 19.4Z" fill="${line}" opacity=".3"/>`);
  s = s.replace(JOWLS, `<path d="M11 20Q12 22.5 15 23M21 20Q20 22.5 17 23" fill="none" stroke="${line}" stroke-width=".3" opacity=".35"/>`);
  s = s.replace(BLUSH_DOTS, '');
  s = s.replace(BLUSH, features(char, { skin, line, hair }) + MARK);
  return s;
}

let done = 0, skipped = 0;
for (const f of readdirSync(SPR)) {
  if (!f.endsWith('.svg')) continue;
  const name = f.slice(0, -4);
  const char = CHARS.find((c) => name === c || new RegExp(`^${c}_[a-z]+_\\d\\d$`).test(name));
  if (!char) continue;
  const src = readFileSync(`${SPR}/${f}`, 'utf8');
  if (src.includes(MARK)) { skipped++; continue; }
  writeFileSync(`${SPR}/${f}`, restyle(src, char));
  done++;
}
console.log(`faces: ${done} restyled, ${skipped} already grounded`);
