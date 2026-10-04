// Medic huts: round, primitive healer's huts instead of plank cabins.
//
//   node tools/art/medic-huts.mjs
//
// Same 96×88 canvas and ground contact as the art they replace (the game places
// them with origin (0.5, 0.92)), so nothing in placement changes:
//   medic_hut.svg       woven wattle walls, conical thatch, herbs drying under the eaves
//   medic_hut_snow.svg  hide-wrapped walls, snow-capped thatch, icicles and drifts
// Both keep the healer's sign — the green cross — on a hide hung from a post.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/sprites');
const r2 = (n) => +n.toFixed(2);

// round hut in iso: wall cylinder centred on x 48, ground ellipse at y 74
const CX = 48, GY = 74, WRX = 27, WRY = 9, WALL = 21;   // wall top at y 53
const TY = GY - WALL;
const ROOF_RX = 34, ROOF_RY = 11.5, APEX = [48, 11];

/** Point on an ellipse (angle 0 = right, 90 = front/bottom). */
const at = (rx, ry, cy, deg) => [CX + rx * Math.cos((deg * Math.PI) / 180), cy + ry * Math.sin((deg * Math.PI) / 180)];

function hut({ wall, wallDark, weave, roof, roofDark, roofLine, snow }) {
  const out = [];
  out.push(`<ellipse cx="49" cy="80" rx="38" ry="6" fill="#1b2623" opacity=".25"/>`);
  // wall: front half of the cylinder
  out.push(`<path d="M${CX - WRX} ${TY}V${GY}A${WRX} ${WRY} 0 0 0 ${CX + WRX} ${GY}V${TY}Z" fill="${wall}" stroke="#3d2c1f" stroke-width=".8"/>`);
  // shade on the right side of the drum
  out.push(`<path d="M${CX + 6} ${TY + 2}V${GY + WRY - .6}A${WRX} ${WRY} 0 0 0 ${CX + WRX} ${GY}V${TY}Z" fill="${wallDark}" opacity=".55"/>`);
  // woven wattle / wrapped hide: upright stakes + weave bands following the curve
  let stakes = '';
  for (let d = 15; d <= 165; d += 15) {
    const [x, yb] = at(WRX, WRY, GY, d);
    stakes += `M${r2(x)} ${r2(yb)}V${r2(yb - WALL)}`;
  }
  out.push(`<path d="${stakes}" stroke="${weave}" stroke-width=".8" opacity=".75"/>`);
  for (const h of [5, 10, 15]) {
    out.push(`<path d="M${CX - WRX} ${GY - h}A${WRX} ${WRY} 0 0 0 ${CX + WRX} ${GY - h}" fill="none" stroke="${weave}" stroke-width="1.1" opacity=".6"/>`);
  }
  // ring of stones at the base
  for (let d = 10; d <= 170; d += 16) {
    const [x, y] = at(WRX + 1.5, WRY + 1, GY, d);
    out.push(`<ellipse cx="${r2(x)}" cy="${r2(y + .5)}" rx="2.4" ry="1.4" fill="#8b8576" stroke="#4d4a42" stroke-width=".4"/>`);
  }
  // doorway: low arched opening with a hide flap tied back
  out.push(`<path d="M41 ${GY + 8.2}V64Q47 56 53 64V${GY + 8.4}Q47 ${GY + 9.6} 41 ${GY + 8.2}Z" fill="#241a13"/>`);
  out.push(`<path d="M49 59.4Q53.4 61 53.6 66L53.4 ${GY + 8}Q50.8 ${GY + 4} 51 68Z" fill="#b48a5c" stroke="#5c4029" stroke-width=".5"/>`);
  out.push(`<path d="M52 66.5Q53.6 67 54.6 66.2" stroke="#d9c39a" stroke-width=".7"/>`);
  // roof: cone over an overhanging rim
  const [lx, ly] = at(ROOF_RX, ROOF_RY, TY + 1, 180), [rx, ry] = at(ROOF_RX, ROOF_RY, TY + 1, 0);
  out.push(`<path d="M${r2(lx)} ${r2(ly)}A${ROOF_RX} ${ROOF_RY} 0 0 0 ${r2(rx)} ${r2(ry)}L${APEX[0]} ${APEX[1]}Z" fill="${roof}" stroke="#4d3a20" stroke-width=".8" stroke-linejoin="round"/>`);
  out.push(`<path d="M${APEX[0]} ${APEX[1]}L${r2(rx)} ${r2(ry)}A${ROOF_RX} ${ROOF_RY} 0 0 1 ${CX + 6} ${r2(TY + 1 + ROOF_RY)}Z" fill="${roofDark}" opacity=".5"/>`);
  // thatch: straw lines from the apex down to the rim
  let straw = '';
  for (let d = 8; d <= 172; d += 9) {
    const [x, y] = at(ROOF_RX - 1, ROOF_RY - .6, TY + 1, d);
    const t = .2 + (d % 18 === 8 ? 0 : .1);
    straw += `M${r2(APEX[0] + (x - APEX[0]) * t)} ${r2(APEX[1] + (y - APEX[1]) * t)}L${r2(x)} ${r2(y)}`;
  }
  out.push(`<path d="${straw}" stroke="${roofLine}" stroke-width=".7" opacity=".7"/>`);
  // ragged eave fringe
  let fringe = `M${r2(lx)} ${r2(ly)}`;
  for (let d = 180; d >= 0; d -= 7.5) {
    const [x, y] = at(ROOF_RX, ROOF_RY, TY + 1, 180 - (180 - d));
    const [x2, y2] = at(ROOF_RX - .5, ROOF_RY + 1.8, TY + 1, d - 3.75);
    fringe += `L${r2(x)} ${r2(y)}L${r2(x2)} ${r2(y2)}`;
  }
  out.push(`<path d="${fringe}" fill="none" stroke="${roofDark}" stroke-width=".9" stroke-linejoin="round"/>`);
  // tipi poles through the smoke hole, tied at the crown
  out.push(`<path d="M48 15 43.6 3.5M48 15 52.8 4.2M48 15 48.4 2.6" stroke="#5e4128" stroke-width="1.3" stroke-linecap="round"/>`);
  out.push(`<ellipse cx="48" cy="14" rx="3.4" ry="1.6" fill="#6f5a33" stroke="#3d2c1f" stroke-width=".5"/>`);

  if (snow) {
    // snow cap on the cone, drifts against the drum, icicles off the eave
    out.push(`<path d="M${APEX[0]} ${APEX[1] + 1}L30 40Q36 44 40 40Q45 45 50 41Q56 45 61 40Q65 43 67 39Z" fill="#f2f8fb" stroke="#b9cfdb" stroke-width=".6" stroke-linejoin="round"/>`);
    out.push(`<path d="M${APEX[0]} ${APEX[1] + 1}L58 40Q62 43 67 39Z" fill="#cfe0ea"/>`);
    let ice = '';
    for (let d = 25; d <= 155; d += 13) {
      const [x, y] = at(ROOF_RX - .5, ROOF_RY + 1.4, TY + 1, d);
      ice += `M${r2(x - 1)} ${r2(y)}L${r2(x)} ${r2(y + 3 + (d % 26 ? 1.6 : 0))}L${r2(x + 1)} ${r2(y)}Z`;
    }
    out.push(`<path d="${ice}" fill="#dff1fa" stroke="#9fc1d3" stroke-width=".35"/>`);
    out.push(`<path d="M16 ${GY + 4}Q24 ${GY - 2} 32 ${GY + 3}Q28 ${GY + 8} 18 ${GY + 7}Z" fill="#eef6fa" stroke="#bcd2de" stroke-width=".5"/>`);
    out.push(`<path d="M64 ${GY + 4}Q72 ${GY - 3} 82 ${GY + 2}Q78 ${GY + 8} 66 ${GY + 8}Z" fill="#eef6fa" stroke="#bcd2de" stroke-width=".5"/>`);
  } else {
    // herbs drying under the eave
    for (const [x, y] of [[61, 57.5], [67.5, 55.6], [30.5, 56.8]]) {
      out.push(`<path d="M${x} ${y - 3}V${y}" stroke="#5e4128" stroke-width=".5"/>` +
        `<path d="M${x - 2} ${y}Q${x} ${y + 5.5} ${x + 2} ${y}Q${x} ${y + 1.2} ${x - 2} ${y}Z" fill="#6f9a45" stroke="#3f5e27" stroke-width=".4"/>`);
    }
  }

  // healer's sign: a hide stretched on a frame, green cross, on a leaning post
  out.push(`<path d="M22 ${GY + 6}L24.5 46" stroke="#5e4128" stroke-width="1.8" stroke-linecap="round"/>`);
  out.push(`<path d="M15.5 48.5Q21 46.6 27 48.5L26 60Q20.8 61.6 16 60Z" fill="#dcc79f" stroke="#6b4c30" stroke-width=".7"/>`);
  out.push(`<path d="M19.6 51.5H22.6V54.1H25.2V57.1H22.6V59.6H19.6V57.1H17V54.1H19.6Z" fill="#3f8a6e" stroke="#25503f" stroke-width=".4"/>`);
  out.push(`<path d="M15.5 48.5 14.6 46.6M27 48.5 28 46.6" stroke="#6b4c30" stroke-width=".6"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="88" viewBox="0 0 96 88">\n${out.join('\n')}\n</svg>\n`;
}

writeFileSync(`${SPR}/medic_hut.svg`, hut({
  wall: '#a8814f', wallDark: '#5c4128', weave: '#6e4d2d',
  roof: '#c9a35a', roofDark: '#7d6130', roofLine: '#8e6f37',
}));
writeFileSync(`${SPR}/medic_hut_snow.svg`, hut({
  wall: '#8d7458', wallDark: '#4b3b2c', weave: '#5c4836',
  roof: '#b89b62', roofDark: '#6e5a36', roofLine: '#806a40', snow: true,
}));
console.log('medic huts written');
