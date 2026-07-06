import { RECIPES, NAMES, RESOURCES, canAfford } from '../shared/defs.js';

const $ = (id: string) => document.getElementById(id)!;
let msgTimer = 0;

export function showMsg(s: string, ms = 3500) {
  const el = $('msg');
  el.textContent = s; el.style.display = 'block';
  clearTimeout(msgTimer); msgTimer = window.setTimeout(() => (el.style.display = 'none'), ms);
}

export interface UIState {
  hp: number; hunger: number; thirst: number;
  inv: any; tools: Set<string>; gear: Set<string>; equipped: string | null;
  mono: boolean[]; day: number; time: number; won: boolean;
  nearWorkbench: boolean; nearForge: boolean; nearCampfire: boolean;
  structCount: (kind: string) => number;
  waveSecs: number;
}

const icon = (k: string) =>
  ({ wood: '🪵', stone: '🪨', fiber: '🌿', crystal: '💎', essence: '🟣', water: '💧', meat: '🥩',
     cookedmeat: '🍖', wall: '🧱', campfire: '🔥', workbench: '🛠', forge: '⚙', core: '🔮',
     engine: '💠', axe: '🪓', pick: '⛏', spick: '⛏', sword: '🗡', heatcloak: '🧥', furcloak: '🧣',
     iron: '🔩', diamond: '🔷', mineshaft: '🕳', shelter: '🏠', isword: '⚔',
     starmetal: '✨', boat: '🛶', sboat: '🚤', torch: '🕯' } as any)[k] || '▪';

const HOTBAR = ['axe', 'pick', 'spick', 'sword', 'isword'];

export function initUI(onCraft: (r: string) => void, onSelectPlace: (kind: string | null) => void, onUse: (k: string) => void, onEquip: (k: string) => void) {
  let selected: string | null = null;
  let invSig = '', panelSig = '';

  const togglePanel = () => {
    const p = $('craftPanel');
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
    panelSig = '';
  };
  $('craftBtn').onclick = togglePanel;
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'c' || e.key === 'C') && !e.repeat) togglePanel();
    if (e.key === 'Escape' && selected) { selected = null; invSig = ''; onSelectPlace(null); }
  });

  // Delegated clicks: elements are only rebuilt when state changes, so clicks land reliably.
  $('inv').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
    if (!el) return;
    if (el.dataset.use) onUse(el.dataset.use);
    else if (el.dataset.eq) onEquip(el.dataset.eq);
    else if (el.dataset.k && RECIPES[el.dataset.k]?.place) {
      selected = selected === el.dataset.k ? null : el.dataset.k!;
      invSig = '';
      onSelectPlace(selected);
    }
  });
  $('craftPanel').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (b && !b.disabled && b.dataset.r) onCraft(b.dataset.r);
  });

  return function update(st: UIState) {
    const night = st.time > 0.65 || st.time < 0.1;
    const hour = ((st.time * 24 + 6) % 24) | 0;
    const warn = (v: number) => (v <= 3 ? `<b style="color:#ff6a6a">${v}</b>` : `${v}`);
    $('hud').innerHTML =
      `${'❤'.repeat(Math.max(0, st.hp))}${'🖤'.repeat(Math.max(0, 10 - st.hp))}` +
      ` 💧${warn(st.thirst)} 🍖${warn(st.hunger)}<br>` +
      `Day ${st.day} · ${String(hour).padStart(2, '0')}:00 ${night ? '🌙 <b style="color:#b98ef0">BLIGHT STORM</b>' : '☀'}` +
      ` · 🗿 ${st.mono.filter(Boolean).length}/4` +
      (st.waveSecs > 0 ? `<br><b style="color:#ff6a6a">⚔ DEFEND THE ENGINE: ${st.waveSecs}s</b>` : '') +
      (st.won ? '<br>✨ <b style="color:#6dd6c8">THE BLIGHT IS PURGED — VICTORY</b>' : '');

    let obj = '';
    if (st.won) obj = 'The Hearth is saved. Explore freely.';
    else if (st.waveSecs > 0) obj = 'Defend the World Engine from the Blight waves!';
    else if (!st.structCount('workbench')) obj = 'Gather wood (E on trees) → craft & place a Workbench [C]';
    else if (!st.tools.has('axe')) obj = 'Craft a Wooden Axe at the Workbench (fiber from bushes)';
    else if (!st.structCount('campfire')) obj = 'Place a Campfire — heals you, cooks food, shields buildings from Blight Storms';
    else if (!st.tools.has('pick')) obj = 'Craft a Wooden Pickaxe (loose stones lie on the ground)';
    else if (!st.tools.has('spick')) obj = 'Craft a Stone Pickaxe to mine boulders & crystal';
    else if (!st.gear.has('heatcloak') || !st.gear.has('furcloak')) obj = 'Craft Heat & Fur Cloaks to survive the Dunes and the Spire';
    else if (!st.structCount('forge')) obj = 'Mine Crystal in the Frozen Spire → build the Aether Forge';
    else if (st.mono.filter(Boolean).length < 4) obj = `Forge Monolith Cores (crystal + essence) and awaken all 4 Monoliths (${st.mono.filter(Boolean).length}/4)`;
    else obj = 'Build the World Engine at the Core Void center — then survive the final assault!';
    $('objective').innerHTML = `🎯 ${obj}<br><span style="color:#9ab">Hunt animals 🥩, drink at lakes (E) 💧, cook at campfires</span>`;

    // inventory bar — rebuild only when contents change
    const sig = JSON.stringify([st.inv, [...st.tools], [...st.gear], selected, st.equipped]);
    if (sig !== invSig) {
      invSig = sig;
      let html = RESOURCES.map((r) => `<span class="slot">${icon(r)} ${st.inv[r] || 0}</span>`).join('');
      for (const k of ['water', 'meat', 'cookedmeat'])
        if (st.inv[k]) html += `<span class="slot ${k !== 'meat' ? 'use' : ''}" ${k !== 'meat' ? `data-use="${k}"` : ''}>${icon(k)} ${NAMES[k]} ×${st.inv[k]}${k !== 'meat' ? ' (click)' : ''}</span>`;
      for (const k of ['boat', 'sboat', 'torch'])
        if (st.inv[k]) html += `<span class="slot">${icon(k)} ${NAMES[k]} ×${st.inv[k]}${k === 'torch' ? ' [T]' : ''}</span>`;
      for (const k of ['wall', 'campfire', 'workbench', 'forge', 'mineshaft', 'shelter', 'core', 'engine'])
        if (st.inv[k]) html += `<span class="slot place ${selected === k ? 'sel' : ''}" data-k="${k}">${icon(k)} ${NAMES[k]} ×${st.inv[k]}${RECIPES[k]?.place ? ' 🔨' : ''}</span>`;
      html += HOTBAR.filter((t) => st.tools.has(t)).map((t) =>
        `<span class="slot tool ${st.equipped === t ? 'eq' : ''}" data-eq="${t}">[${HOTBAR.indexOf(t) + 1}] ${icon(t)} ${NAMES[t]}${st.equipped === t ? ' ✓' : ''}</span>`).join('');
      html += [...st.gear].map((t) => `<span class="slot tool">${icon(t)} ${NAMES[t]}</span>`).join('');
      $('inv').innerHTML = html;
    }

    // craft panel — rebuild only when relevant state changes
    if ($('craftPanel').style.display === 'block') {
      const psig = JSON.stringify([st.inv, [...st.tools], [...st.gear], st.nearWorkbench, st.nearForge, st.nearCampfire]);
      if (psig !== panelSig) {
        panelSig = psig;
        let html = '<b>Crafting</b> <span style="color:#888">(C to close)</span><br>';
        for (const [key, r] of Object.entries(RECIPES) as [string, any][]) {
          if (r.tool && st.tools.has(key)) continue;
          if (r.gear && st.gear.has(key)) continue;
          const stationOk = !r.station ||
            (r.station === 'workbench' ? st.nearWorkbench : r.station === 'forge' ? st.nearForge : st.nearCampfire);
          const ok = canAfford(st.inv, r.cost) && stationOk;
          const cost = Object.entries(r.cost).map(([k, v]) => `${icon(k)}${v}`).join(' ');
          html += `<div class="recipe"><button data-r="${key}" ${ok ? '' : 'disabled'}>${NAMES[key]}</button>` +
            ` <span class="cost">${cost}</span>` +
            (r.station && !stationOk ? ` <span class="need">near ${NAMES[r.station]}</span>` : '') + `</div>`;
        }
        $('craftPanel').innerHTML = html;
      }
    }
  };
}
