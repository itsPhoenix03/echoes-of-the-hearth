import { RECIPES, NAMES, RESOURCES, canAfford } from '../shared/defs.js';
// Decor kinds that are zone-restricted (for UI greying)
const DECOR_ZONE_IN  = new Set(Object.entries(RECIPES as any).filter(([,r]: any) => r.decor && r.zone === 'in').map(([k]) => k));
const DECOR_ZONE_OUT = new Set(Object.entries(RECIPES as any).filter(([,r]: any) => r.decor && r.zone === 'out').map(([k]) => k));
import { isNightTime } from '../shared/time.js';

const $ = (id: string) => document.getElementById(id)!;
let msgTimer = 0;
// set by initUI() so reset() can reach the singleton's closure state without exporting it
let resetSession: (() => void) | null = null;

export function showMsg(s: string, ms = 3500) {
  const el = $('msg');
  el.textContent = s; el.style.display = 'block';
  clearTimeout(msgTimer); msgTimer = window.setTimeout(() => (el.style.display = 'none'), ms);
}

// Drop every scrap of per-session state (signature caches, selection, chest + medic offer)
// on quit-to-menu. The caches exist to skip redundant DOM writes, so a re-join that produced
// an identical signature — e.g. the same medic offer — would otherwise never be drawn at all,
// leaving its panel hidden. initUI() itself is deliberately NOT re-run (listeners would double).
export function reset() {
  clearTimeout(msgTimer); msgTimer = 0;
  resetSession?.();
}

export interface UIState {
  hp: number; hunger: number; thirst: number;
  inv: any; tools: Set<string>; gear: Set<string>; equipped: string | null;
  wornGear: string | null;
  inWater: boolean;
  selectedVehicle: 'boat' | 'sboat' | null;
  mono: boolean[]; day: number; time: number; won: boolean;
  nearWorkbench: boolean; nearForge: boolean; nearCampfire: boolean;
  structCount: (kind: string) => number;
  waveSecs: number;
  engineHp: number | null;
  zone: 'in' | 'out';
  medicOffer: { medicId: string; offerId: string; resource: string; amount: number; expiresAt: number } | null;
}

const icon = (k: string) =>
  ({ wood: '🪵', stone: '🪨', fiber: '🌿', crystal: '💎', essence: '🟣', water: '💧', meat: '🥩',
     cookedmeat: '🍖', wall: '🧱', campfire: '🔥', workbench: '🛠', forge: '⚙', core: '🔮',
     engine: '💠', axe: '🪓', pick: '⛏', spick: '⛏', sword: '🗡', heatcloak: '🧥', furcloak: '🧣',
     iron: '🔩', diamond: '🔷', mineshaft: '🕳', shelter: '🏠', isword: '⚔',
     starmetal: '✨', boat: '🛶', sboat: '🚤', torch: '🕯', chest: '📦', bed: '🛏',
     banner: '🚩', stone_path: '🪨', lantern: '🏮', reed_vase: '🌾', rug: '🟫', trophy_antler: '🦌',
     fence: '🪵', farmplot: '🌱', grain: '🌾', glowcap: '✨', bread: '🍞', medicine: '🧪' } as any)[k] || '▪';

const HOTBAR = ['axe', 'pick', 'spick', 'sword', 'isword'];
const CLOAKS = ['heatcloak', 'furcloak'];

export function initUI(
  onCraft: (r: string) => void,
  onSelectPlace: (kind: string | null) => void,
  onUse: (k: string) => void,
  onEquip: (k: string) => void,
  onWear: (k: string | null) => void,
  onVehicle: (k: 'boat' | 'sboat') => void,
  onChestMove: (i: number, res: string, n: number) => void,
  onMedicAccept: (medicId: string, offerId: string) => void,
  onMedicDecline: (medicId: string) => void
) {
  let selected: string | null = null;
  let invSig = '', panelSig = '';
  let chestOpenI = -1;
  let chestSlots: Record<string, number> = {};
  let chestSig = '';
  let medicOffer: UIState['medicOffer'] = null;
  let medicSig = '';

  const closeChestPanel = () => {
    chestOpenI = -1;
    chestSlots = {};
    chestSig = '';
    $('chestPanel').style.display = 'none';
  };
  const togglePanel = () => {
    const p = $('craftPanel');
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
    panelSig = '';
  };
  const toggleModal = (id: string) => {
    const m = $(id);
    m.style.display = m.style.display === 'block' ? 'none' : 'block';
  };
  $('craftBtn').onclick = togglePanel;
  $('invBtn').onclick = () => toggleModal('invModal');
  $('helpBtn').onclick = () => toggleModal('helpModal');
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'c' || e.key === 'C') togglePanel();
    if (e.key === 'i' || e.key === 'I') toggleModal('invModal');
    if (e.key === 'h' || e.key === 'H') toggleModal('helpModal');
    if (e.key === 'Escape') {
      $('invModal').style.display = 'none';
      $('helpModal').style.display = 'none';
      closeChestPanel();
      if (selected) { selected = null; invSig = ''; onSelectPlace(null); }
    }
  });

  // Delegated chest panel buttons — attached once, never rebuilt
  $('chestPanel').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!btn || !btn.dataset.res || chestOpenI < 0) return;
    const res = btn.dataset.res;
    const n = parseInt(btn.dataset.n || '0', 10);
    if (n) onChestMove(chestOpenI, res, n);
  });

  // Delegated clicks: elements are only rebuilt when state changes, so clicks land reliably.
  $('inv').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
    if (!el) return;
    if (el.dataset.use) onUse(el.dataset.use);
    else if (el.dataset.eq) onEquip(el.dataset.eq);
    // Task 4: wear delegate — data-wear="" means null (unequip), data-wear="key" means equip
    else if (el.dataset.wear !== undefined) onWear(el.dataset.wear || null);
    // Task 4a: vehicle selection toggle
    else if (el.dataset.veh) onVehicle(el.dataset.veh as 'boat' | 'sboat');
    else if (el.dataset.k && RECIPES[el.dataset.k]?.place) {
      selected = selected === el.dataset.k ? null : el.dataset.k!;
      invSig = '';
      onSelectPlace(selected);
      if (selected) $('invModal').style.display = 'none';   // clear the view for placing
    }
  });
  $('quickbar').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
    if (!el) return;
    if (el.dataset.use) onUse(el.dataset.use);
    else if (el.dataset.eq) onEquip(el.dataset.eq);
    // Task 4: wear from quickbar
    else if (el.dataset.wear !== undefined) onWear(el.dataset.wear || null);
  });
  $('craftPanel').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (b && !b.disabled && b.dataset.r) onCraft(b.dataset.r);
  });
  // Delegated medic panel buttons — same rebuild-safe pattern as craftPanel/chestPanel above.
  $('medicPanel').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b || !medicOffer) return;
    if (b.dataset.medicAccept !== undefined && !b.disabled) onMedicAccept(medicOffer.medicId, medicOffer.offerId);
    else if (b.dataset.medicDecline !== undefined) onMedicDecline(medicOffer.medicId);
  });

  // Public surface for chest panel management (called from main.ts)
  const api = {
    openChest(i: number, slots: Record<string, number>) {
      chestOpenI = i;
      chestSlots = { ...slots };
      chestSig = '';
      $('chestPanel').style.display = 'block';
    },
    updateChest(i: number, slots: Record<string, number>) {
      if (i !== chestOpenI) return;
      chestSlots = { ...slots };
      chestSig = '';  // force redraw
    },
    closeChest: closeChestPanel,
    isChestOpen: () => chestOpenI >= 0,
  };

  // see reset() above — the whole closure state, in one place
  resetSession = () => {
    closeChestPanel();
    selected = null;
    invSig = ''; panelSig = '';
    medicOffer = null; medicSig = '';
    $('medicPanel').style.display = 'none';
  };

  return Object.assign(function update(st: UIState) {
    // Task 2: use isNightTime
    const night = isNightTime(st.time);
    const hour = ((st.time * 24 + 6) % 24) | 0;
    // The Go server decays hunger/thirst as floats, so display-round them — without this
    // the HUD reads "8.256999999999996".
    const warn = (raw: number) => {
      const v = Math.ceil(raw);
      return v <= 3 ? `<b style="color:#ff6a6a">${v}</b>` : `${v}`;
    };
    $('hud').innerHTML =
      `${'❤'.repeat(Math.max(0, st.hp))}${'🖤'.repeat(Math.max(0, 10 - st.hp))}` +
      ` 💧${warn(st.thirst)} 🍖${warn(st.hunger)}<br>` +
      `Day ${st.day} · ${String(hour).padStart(2, '0')}:00 ${night ? '🌙 <b style="color:#b98ef0">BLIGHT STORM</b>' : '☀'}` +
      ` · 🗿 ${st.mono.filter(Boolean).length}/4` +
      (st.waveSecs > 0 ? `<br><b style="color:#ff6a6a">⚔ DEFEND THE ENGINE: ${st.waveSecs}s</b>` : '') +
      (st.engineHp != null ? `<br>💠 <b style="color:${st.engineHp > 60 ? '#6dd6c8' : st.engineHp > 30 ? '#ffd97a' : '#ff6a6a'}">Engine: ${st.engineHp}/120 HP</b>` : '') +
      (st.won ? '<br>✨ <b style="color:#6dd6c8">THE BLIGHT IS PURGED — VICTORY</b>' : '');

    let obj = '';
    if (st.won) obj = 'The Hearth is saved. Explore freely.';
    else if (st.waveSecs > 0) obj = 'Defend the World Engine from the Blight waves!';
    else if (!st.structCount('workbench')) obj = 'Gather wood (E on trees) → craft & place a Workbench [C]';
    else if (!st.tools.has('axe')) obj = 'Craft a Wooden Axe at the Workbench (fiber from bushes)';
    else if (!st.structCount('campfire')) obj = 'Place a Campfire — heals you, cooks food, shields buildings from Blight Storms';
    else if (!st.tools.has('pick')) obj = 'Craft a Wooden Pickaxe (loose stones lie on the ground)';
    else if (!st.tools.has('spick')) obj = 'Craft a Stone Pickaxe to mine boulders & crystal';
    else if (!st.gear.has('heatcloak') || !st.gear.has('furcloak')) obj = 'Craft Heat & Fur Cloaks to survive the Dunes and the Spire, then WEAR the right cloak (click it in the Bag)';
    else if (!st.structCount('forge')) obj = 'Mine Crystal in the Frozen Spire → build the Aether Forge';
    else if (st.mono.filter(Boolean).length < 4) obj = `Forge Monolith Cores (crystal + essence) and awaken all 4 Monoliths (${st.mono.filter(Boolean).length}/4)`;
    else obj = 'Build the World Engine at the Core Void center — then survive the final assault!';
    $('objective').innerHTML = `🎯 ${obj}<br><span style="color:#9ab">Hunt animals 🥩, drink at lakes (E) 💧, cook at campfires</span>`;

    // inventory (modal) + quickbar — rebuild only when contents change
    // Task 4: add wornGear + selectedVehicle to signature
    const sig = JSON.stringify([st.inv, [...st.tools], [...st.gear], selected, st.equipped, st.wornGear, st.selectedVehicle, st.inWater, st.zone]);
    if (sig !== invSig) {
      invSig = sig;
      let html = RESOURCES.map((r) => `<span class="slot">${icon(r)} ${st.inv[r] || 0}</span>`).join('');
      for (const k of ['water', 'meat', 'cookedmeat', 'grain', 'glowcap', 'bread', 'medicine'])
        if (st.inv[k]) {
          const useable = ['water', 'cookedmeat', 'glowcap', 'bread', 'medicine'].includes(k);
          html += `<span class="slot ${useable ? 'use' : ''}" ${useable ? `data-use="${k}"` : ''}>${icon(k)} ${NAMES[k] || k} ×${st.inv[k]}${useable ? ' (click)' : ''}</span>`;
        }
      for (const k of ['boat', 'sboat', 'torch']) {
        if (!st.inv[k]) continue;
        if (k === 'boat' || k === 'sboat') {
          const sel = st.selectedVehicle === k;
          html += st.inWater
            ? `<span class="slot" style="opacity:0.45">${icon(k)} ${NAMES[k]} ×${st.inv[k]} (reach land)</span>`
            : `<span class="slot tool ${sel ? 'sel' : ''}" data-veh="${k}" style="cursor:pointer">${icon(k)} ${NAMES[k]} ×${st.inv[k]}${sel ? ' ⛵ selected' : ' (select)'}</span>`;
        } else {
          html += `<span class="slot">${icon(k)} ${NAMES[k]} ×${st.inv[k]}${k === 'torch' ? ' [T]' : ''}</span>`;
        }
      }
      for (const k of ['wall', 'campfire', 'workbench', 'forge', 'mineshaft', 'shelter', 'chest', 'bed', 'core', 'engine',
                        'banner', 'stone_path', 'lantern', 'reed_vase', 'rug', 'trophy_antler', 'fence', 'farmplot']) {
        if (!st.inv[k]) continue;
        const r = (RECIPES as any)[k];
        // hide (not grey) placeables that cannot go in the current zone:
        // interiors (shelter/mine) accept only chest/bed and indoor-eligible decor;
        // the surface hides indoor-only decor.
        if (r?.place) {
          const interiorOk = k === 'chest' || k === 'bed' || (r.decor && (r.zone === 'in' || r.zone === 'both'));
          if (st.zone === 'in' && !interiorOk) continue;
          if (st.zone === 'out' && r.zone === 'in') continue;
        }
        html += `<span class="slot place ${selected === k ? 'sel' : ''}" data-k="${k}">${icon(k)} ${NAMES[k] || k} ×${st.inv[k]}${r?.place ? ' 🔨' : ''}</span>`;
      }
      html += HOTBAR.filter((t) => st.tools.has(t)).map((t) =>
        `<span class="slot tool ${st.equipped === t ? 'eq' : ''}" data-eq="${t}">[${HOTBAR.indexOf(t) + 1}] ${icon(t)} ${NAMES[t]}${st.equipped === t ? ' ✓' : ''}</span>`).join('');
      // Task 4: gear slots are clickable to wear/unwear
      html += [...st.gear].map((t) =>
        `<span class="slot tool ${st.wornGear === t ? 'eq' : ''}" data-wear="${t}">${icon(t)} ${NAMES[t]} ${st.wornGear === t ? '✓ worn' : '(wear)'}</span>`
      ).join('');
      $('inv').innerHTML = html;
      // quickbar: equipped tools + quick consumables + owned cloaks
      let qb = HOTBAR.filter((t) => st.tools.has(t)).map((t) =>
        `<span class="slot tool ${st.equipped === t ? 'eq' : ''}" data-eq="${t}">${HOTBAR.indexOf(t) + 1} ${icon(t)}</span>`).join('');
      if (st.inv.water) qb += `<span class="slot use" data-use="water">${icon('water')}${st.inv.water}</span>`;
      if (st.inv.cookedmeat) qb += `<span class="slot use" data-use="cookedmeat">${icon('cookedmeat')}${st.inv.cookedmeat}</span>`;
      if (st.inv.bread) qb += `<span class="slot use" data-use="bread">${icon('bread')}${st.inv.bread}</span>`;
      if (st.inv.glowcap) qb += `<span class="slot use" data-use="glowcap">${icon('glowcap')}${st.inv.glowcap}</span>`;
      if (st.inv.medicine) qb += `<span class="slot use" data-use="medicine">${icon('medicine')}${st.inv.medicine}</span>`;
      // Task 4: cloaks in quickbar
      for (const t of CLOAKS) {
        if (st.gear.has(t)) {
          qb += `<span class="slot tool ${st.wornGear === t ? 'eq' : ''}" data-wear="${t}">${icon(t)}${st.wornGear === t ? '✓' : ''}</span>`;
        }
      }
      $('quickbar').innerHTML = qb;
    }

    // chest panel — rebuild only when slots signature changes
    if (chestOpenI >= 0) {
      const cSig = JSON.stringify([chestSlots, st.inv]);
      if (cSig !== chestSig) {
        chestSig = cSig;
        const CHEST_RES = ['wood','stone','fiber','crystal','essence','iron','diamond','starmetal'] as const;
        let cHtml = '<b>📦 Chest Storage</b> <span style="color:#888;font-size:11px">(ESC closes)</span><br><br>';
        cHtml += '<table style="width:100%;border-collapse:collapse">';
        cHtml += '<tr style="color:#aaa;font-size:11px"><th style="text-align:left">Resource</th><th>In Chest</th><th>In Bag</th><th></th></tr>';
        for (const r of CHEST_RES) {
          const inChest = chestSlots[r] || 0;
          const inBag = st.inv[r] || 0;
          cHtml += `<tr><td>${icon(r)} ${NAMES[r] || r}</td><td style="text-align:center">${inChest}</td><td style="text-align:center">${inBag}</td>` +
            `<td style="display:flex;gap:3px;padding:2px 0">` +
            `<button data-res="${r}" data-n="-10" style="font-size:11px;padding:1px 4px" ${inChest === 0 ? 'disabled' : ''}>−10</button>` +
            `<button data-res="${r}" data-n="-1"  style="font-size:11px;padding:1px 4px" ${inChest === 0 ? 'disabled' : ''}>−</button>` +
            `<button data-res="${r}" data-n="1"   style="font-size:11px;padding:1px 4px" ${inBag === 0 ? 'disabled' : ''}>+</button>` +
            `<button data-res="${r}" data-n="10"  style="font-size:11px;padding:1px 4px" ${inBag === 0 ? 'disabled' : ''}>+10</button>` +
            `</td></tr>`;
        }
        cHtml += '</table>';
        $('chestPanel').querySelector('.chest-body')!.innerHTML = cHtml;
      }
    }

    // medic offer panel — rebuild is gated on offer id + affordability (never the countdown),
    // so the live "expires in Ns" text is patched into an existing node every frame instead
    // of tearing down the buttons (that pattern is what made the craft panel unclickable once).
    medicOffer = st.medicOffer;
    const medicEl = $('medicPanel');
    if (medicOffer) {
      medicEl.style.display = 'block';
      const canPay = (st.inv[medicOffer.resource] || 0) >= medicOffer.amount;
      const msig = `${medicOffer.medicId}:${medicOffer.offerId}:${canPay}`;
      if (msig !== medicSig) {
        medicSig = msig;
        medicEl.innerHTML =
          `<b>🩺 A medic's offer</b><br>` +
          `Full healing for ${icon(medicOffer.resource)} ${medicOffer.amount} ${NAMES[medicOffer.resource] || medicOffer.resource}<br>` +
          `<span id="medicCountdown" style="color:#9ab;font-size:12px"></span><br><br>` +
          `<button data-medic-accept ${canPay ? '' : 'disabled'}>Accept</button> ` +
          `<button data-medic-decline>Decline</button>`;
      }
      const secsLeft = Math.max(0, Math.ceil((medicOffer.expiresAt - Date.now()) / 1000));
      const cdEl = document.getElementById('medicCountdown');
      if (cdEl) cdEl.textContent = `Expires in ${secsLeft}s`;
    } else {
      medicEl.style.display = 'none';
      medicSig = '';
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
          html += `<div class="recipe"><button data-r="${key}" ${ok ? '' : 'disabled'}>${NAMES[key] || key}</button>` +
            ` <span class="cost">${cost}</span>` +
            (r.station && !stationOk ? ` <span class="need">near ${NAMES[r.station]}</span>` : '') + `</div>`;
        }
        $('craftPanel').innerHTML = html;
      }
    }
  }, api);
}
