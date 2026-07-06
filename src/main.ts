import Phaser from 'phaser';
import { genWorld, nearestLand, SIZE, T, TILE_KEYS, MONOLITHS, ISLES } from '../shared/world.js';
import { NODE_KEYS, RECIPES, NAMES, emptyInv } from '../shared/defs.js';
import { Rig, makePartTextures } from './rig.ts';
import { initUI, showMsg, UIState } from './ui.ts';
import { GameAudio } from './audio.ts';

const TW = 64, TH = 32;
const MONO_NAMES = ['Whispering Woods', 'Sinking Dunes', 'Frozen Spire', 'Blighted Marsh'];
const NODE_SPR: Record<string, [string, number, number]> = { // texture, w, h
  tree: ['tree', 48, 64], boulder: ['boulder', 44, 36], bush: ['bush', 36, 28],
  stone: ['stone', 24, 16], crystal: ['crystal', 36, 44], starmetal: ['starmetal', 38, 32]
};
const STRUCT_SPR: Record<string, [number, number]> = {
  wall: [48, 52], campfire: [40, 36], workbench: [52, 42], forge: [52, 60], engine: [64, 84],
  mineshaft: [52, 48], shelter: [104, 100]
};
const STORY_OFF: Record<string, number> = { wall: 25, shelter: 52 };
const MAX_LVL: Record<string, number> = { wall: 2, shelter: 3 };
const colorFor = (id: string) => {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
  return Phaser.Display.Color.HSLToColor(((h % 360) / 360), 0.6, 0.55).color;
};

const CRE_TEX: Record<string, string> = { crawler: 'creature', stalker: 'stalker', brute: 'brute', wisp: 'wisp' };
const CHW = 1024, CHH = 512;

// Hidden clue notes — each island's note hints at the next, never with exact coordinates.
const NOTE_DEFS: [number, number, string][] = [
  [ISLES[0][0] + 7, ISLES[0][1] + 4, '📜 Weathered journal: "I left the whispering pines and sailed into the RISING SUN for a full day. When hope thinned, golden dunes broke the horizon. And mark this — where forests and marshes grow, gold-flecked starfall stone hides among the rocks."'],
  [ISLES[1][0] + 7, ISLES[1][1] + 4, '📜 Sun-bleached scroll: "From these dunes I fled DUE SOUTH across an empty sea, a day and a night. Where the water turns black and the earth breathes, the marsh waits — and things wait in the marsh."'],
  [ISLES[3][0] + 7, ISLES[3][1] + 4, '📜 Mud-stained page: "Chase the SETTING SUN from this bog and a frozen crown rises, ringed by white teeth of ice. My wooden hull was matchwood in a breath. Only a hull bound in fallen-star metal survives the teeth."'],
  [ISLES[2][0] + 7, ISLES[2][1] + 4, '📜 Frost-rimed letter: "From the Spire\'s peak I finally saw it — a wound in the heart of the sea, EQUALLY FAR FROM EVERY SHORE. Four songs must wake before its engine will turn."']
];

class Hearth extends Phaser.Scene {
  ws!: WebSocket; id = '';
  world!: { tiles: Uint8Array; elev: Uint8Array; veins: Uint8Array; nodes: Map<number, number>; bergs: Set<number> };
  chunks = new Map<string, Phaser.GameObjects.RenderTexture>();
  mutTiles = new Map<number, string>();   // tile overrides: mud, blight infection
  weather: string | null = null;
  rainFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  snowFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  sandFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  sandOverlay!: Phaser.GameObjects.Rectangle;
  offX = (SIZE - 1) * TW / 2;
  me!: Rig; px = 40; py = 40; hp = 10; hunger = 10; thirst = 10;
  inv: any = emptyInv(); tools = new Set<string>(); gear = new Set<string>(); equipped: string | null = null;
  mono = [false, false, false, false]; day = 1; wtime = 0.3; won = false; waveEnd = 0;
  others = new Map<string, { rig: Rig; tx: number; ty: number; z: number }>();
  monoSpr: Phaser.GameObjects.Sprite[] = [];
  creSpr = new Map<string, Phaser.GameObjects.Sprite>();
  aniSpr = new Map<string, Phaser.GameObjects.Sprite>();
  nodeSpr = new Map<number, Phaser.GameObjects.Sprite>();
  structSpr = new Map<number, { spr: Phaser.GameObjects.Sprite; extra: Phaser.GameObjects.Sprite[]; kind: string; hp: number; lvl: number; glow?: Phaser.GameObjects.Arc }>();
  mud = new Set<number>();
  z = 0; digs = new Set<number>();
  ugFloor = new Map<number, Phaser.GameObjects.Image>();
  ugRock = new Map<number, Phaser.GameObjects.Image>();
  ugOre = new Map<number, Phaser.GameObjects.Image>();
  jumpT = -1; faceX = 1; faceY = 0; zToggleAt = 0;
  sailing = false; boatKind = 0; boatSpr: Phaser.GameObjects.Image | null = null;
  bergSpr = new Map<number, Phaser.GameObjects.Image>();
  torchSpr = new Map<number, Phaser.GameObjects.Image>();
  darkRT!: Phaser.GameObjects.RenderTexture;
  notes: { x: number; y: number; text: string }[] = [];
  keys!: any;
  nightRect!: Phaser.GameObjects.Rectangle;
  ghost: Phaser.GameObjects.Sprite | null = null; placing: string | null = null; placeDir = 0;
  updateUI!: (st: UIState) => void;
  audio = new GameAudio();
  stepTimer = 0; growlTimer = 1;
  lastSend = 0; lastGather = 0; ready = false;

  iso(x: number, y: number) { return { x: (x - y) * TW / 2 + this.offX, y: (x + y) * TH / 2 }; }
  elevAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return 1;
    return this.world.elev[(y | 0) * SIZE + (x | 0)];
  }
  // iso position lifted by tile elevation (hills render 10px higher per level)
  isoE(x: number, y: number) {
    const p = this.iso(x, y);
    p.y -= Math.max(0, this.elevAt(x, y) - 1) * 10;
    return p;
  }
  unIso(sx: number, sy: number) {
    const lx = sx - this.offX;
    return { x: Math.floor(sy / (TH / 2) / 2 + lx / TW), y: Math.floor(sy / (TH / 2) / 2 - lx / TW) };
  }

  preload() {
    for (const k of TILE_KEYS) this.load.svg(k, `/tiles/${k}.svg`, { width: 64, height: 40 });
    for (const [k, [tex, w, h]] of Object.entries(NODE_SPR)) this.load.svg(tex, `/sprites/${tex}.svg`, { width: w, height: h });
    for (const [k, [w, h]] of Object.entries(STRUCT_SPR)) this.load.svg(k, `/sprites/${k}.svg`, { width: w, height: h });
    this.load.svg('monolith', '/sprites/monolith.svg', { width: 48, height: 80 });
    this.load.svg('creature', '/sprites/blight-creature.svg', { width: 40, height: 36 });
    this.load.svg('stalker', '/sprites/stalker.svg', { width: 44, height: 30 });
    this.load.svg('brute', '/sprites/brute.svg', { width: 56, height: 54 });
    this.load.svg('wisp', '/sprites/wisp.svg', { width: 32, height: 40 });
    this.load.svg('boar', '/sprites/boar.svg', { width: 40, height: 28 });
    this.load.svg('crab', '/sprites/crab.svg', { width: 30, height: 20 });
    this.load.svg('hare', '/sprites/hare.svg', { width: 26, height: 26 });
    this.load.svg('rock', '/tiles/rock.svg', { width: 64, height: 64 });
    this.load.svg('cavefloor', '/tiles/cavefloor.svg', { width: 64, height: 40 });
    this.load.svg('ironore', '/sprites/ironore.svg', { width: 30, height: 24 });
    this.load.svg('diamondore', '/sprites/diamondore.svg', { width: 30, height: 24 });
    this.load.svg('boat', '/sprites/boat.svg', { width: 56, height: 30 });
    this.load.svg('iceberg', '/sprites/iceberg.svg', { width: 44, height: 42 });
    this.load.svg('torch', '/sprites/torch.svg', { width: 16, height: 34 });
    this.load.svg('note', '/sprites/note.svg', { width: 26, height: 30 });
    this.load.svg('deer', '/sprites/animal.svg', { width: 36, height: 30 });
    this.load.svg('lizard', '/sprites/lizard.svg', { width: 36, height: 22 });
    this.load.svg('fox', '/sprites/fox.svg', { width: 34, height: 26 });
    this.load.svg('toad', '/sprites/toad.svg', { width: 28, height: 22 });
  }

  create() {
    makePartTextures(this);
    this.makeWeatherFx();
    this.makeGlowTextures();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.hostname}:8081`);
    this.ws.onopen = () => {
      let tok = localStorage.getItem('hearth-tok');
      if (!tok) { tok = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('hearth-tok', tok); }
      this.send({ t: 'hello', tok });
    };
    this.ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
    this.ws.onclose = () => showMsg('Disconnected. Is the server running? (npm run server)', 60000);

    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT,E,SPACE');
    this.input.keyboard!.on('keydown-SPACE', () => this.jump());
    this.input.keyboard!.on('keydown-F', () => this.attack());
    this.input.keyboard!.on('keydown-ESC', () => this.setPlacing(null));
    this.input.keyboard!.on('keydown-R', () => {
      if (this.placing === 'wall') { this.placeDir ^= 1; this.ghost?.setFlipX(this.placeDir === 1); }
    });
    this.input.keyboard!.on('keydown-T', () => {
      if (this.z === 1 && this.inv.torch > 0) this.send({ t: 'torch' });
      else if (this.z === 1) showMsg('Craft torches first (2 wood + 1 fiber).');
    });
    const HOTBAR = ['axe', 'pick', 'spick', 'sword', 'isword'];
    this.input.keyboard!.on('keydown', (e: KeyboardEvent) => {
      this.audio.start();                                  // audio unlocks on first gesture
      const n = parseInt(e.key);
      if (n >= 1 && n <= 5) this.setEquip(HOTBAR[n - 1]);
      if (e.key === 'm' || e.key === 'M') showMsg(this.audio.toggleMute() ? '🔇 Muted' : '🔊 Sound on', 1000);
      if (e.key === 'F9') this.send({ t: 'dev' });
    });
    this.input.on('pointerdown', () => this.audio.start());
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => this.onClick(ptr));
    this.updateUI = initUI(
      (r) => this.send({ t: 'craft', r }),
      (k) => this.setPlacing(k),
      (k) => this.send({ t: 'use', k }),
      (k) => this.setEquip(k)
    );
    showMsg('Connecting to The Hearth...');
  }

  send(m: any) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  makeGlowTextures() {
    for (const [key, size] of [['glow-s', 220], ['glow-l', 380]] as [string, number][]) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0.75)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      this.textures.addCanvas(key, c);
    }
    this.darkRT = this.add.renderTexture(0, 0, this.scale.width, this.scale.height)
      .setOrigin(0).setScrollFactor(0).setDepth(999993).setVisible(false);
  }

  makeWeatherFx() {
    const g = this.add.graphics();
    g.fillStyle(0x9ac7ff); g.fillRect(0, 0, 2, 12); g.generateTexture('fx-rain', 2, 12); g.clear();
    g.fillStyle(0xffffff); g.fillCircle(3, 3, 3); g.generateTexture('fx-snow', 6, 6); g.clear();
    g.fillStyle(0xd8b060); g.fillRect(0, 0, 12, 2); g.generateTexture('fx-sand', 12, 2); g.destroy();
    this.rainFx = this.add.particles(0, 0, 'fx-rain', {
      x: { min: 0, max: 2200 }, y: -20, speedY: { min: 600, max: 800 }, speedX: { min: -60, max: -120 },
      lifespan: 1800, quantity: 8, alpha: { min: 0.4, max: 0.8 }, emitting: false
    }).setScrollFactor(0).setDepth(999995);
    this.snowFx = this.add.particles(0, 0, 'fx-snow', {
      x: { min: 0, max: 2200 }, y: -10, speedY: { min: 50, max: 110 }, speedX: { min: -40, max: 40 },
      lifespan: 14000, quantity: 2, alpha: { min: 0.4, max: 0.9 }, scale: { min: 0.4, max: 1 }, emitting: false
    }).setScrollFactor(0).setDepth(999995);
    this.sandFx = this.add.particles(0, 0, 'fx-sand', {
      x: -20, y: { min: 0, max: 1400 }, speedX: { min: 500, max: 800 }, speedY: { min: -40, max: 40 },
      lifespan: 3000, quantity: 6, alpha: { min: 0.3, max: 0.7 }, emitting: false
    }).setScrollFactor(0).setDepth(999995);
    this.sandOverlay = this.add.rectangle(0, 0, 4000, 3000, 0xcc8833)
      .setOrigin(0).setScrollFactor(0).setDepth(999994).setAlpha(0);
  }

  // --- chunk-streamed terrain (whole map is too large for one texture) ---
  ensureChunks() {
    const cam = this.cameras.main.worldView;
    const x0 = Math.floor((cam.x - 64) / CHW), x1 = Math.floor((cam.right + 64) / CHW);
    const y0 = Math.floor((cam.y - 80) / CHH), y1 = Math.floor((cam.bottom + 40) / CHH);
    const need = new Set<string>();
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) {
        const k = cx + ',' + cy;
        need.add(k);
        if (!this.chunks.has(k)) this.chunks.set(k, this.drawChunk(cx, cy));
      }
    if (this.chunks.size > 24)
      for (const [k, rt] of this.chunks) {
        if (!need.has(k)) { rt.destroy(); this.chunks.delete(k); }
        if (this.chunks.size <= 24) break;
      }
  }

  private tileKey(i: number) { return this.mutTiles.get(i) || TILE_KEYS[this.world.tiles[i]]; }

  drawChunk(cx: number, cy: number) {
    const rt = this.add.renderTexture(cx * CHW, cy * CHH, CHW, CHH).setOrigin(0).setDepth(-1).setAlpha(this.z === 1 ? 0.15 : 1);
    const pad = 80, rx = cx * CHW, ry = cy * CHH;
    const inv = (sx: number, sy: number) => ({
      tx: (sy / (TH / 2) + (sx - this.offX) / (TW / 2)) / 2,
      ty: (sy / (TH / 2) - (sx - this.offX) / (TW / 2)) / 2
    });
    const cs = [inv(rx - pad, ry - pad), inv(rx + CHW + pad, ry - pad), inv(rx - pad, ry + CHH + pad), inv(rx + CHW + pad, ry + CHH + pad)];
    const tx0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c.tx))));
    const tx1 = Math.min(SIZE - 1, Math.ceil(Math.max(...cs.map((c) => c.tx))));
    const ty0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c.ty))));
    const ty1 = Math.min(SIZE - 1, Math.ceil(Math.max(...cs.map((c) => c.ty))));
    rt.beginDraw();
    for (let y = ty0; y <= ty1; y++)
      for (let x = tx0; x <= tx1; x++) {
        const p = this.iso(x, y);
        if (p.x < rx - pad || p.x > rx + CHW + pad || p.y < ry - pad || p.y > ry + CHH + pad) continue;
        const i = y * SIZE + x;
        const key = this.tileKey(i);
        const e = Math.max(1, this.world.elev[i]);
        for (let l = 0; l < e; l++) rt.batchDraw(key, p.x - TW / 2 - rx, p.y - l * 10 - ry);   // stacked skirts form cliffs
      }
    rt.endDraw();
    return rt;
  }

  // change a tile (mud / infection / cure) and repaint it on any loaded chunks
  setTileMut(i: number, key: string | null) {
    if (key) this.mutTiles.set(i, key); else this.mutTiles.delete(i);
    const x = i % SIZE, y = (i / SIZE) | 0;
    const list = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]
      .filter(([a, b]) => a < SIZE && b < SIZE);
    for (const [k, rt] of this.chunks) {
      const [cx, cy] = k.split(',').map(Number);
      rt.beginDraw();
      for (const [tx2, ty2] of list) {
        const p = this.iso(tx2, ty2);
        const lx = p.x - TW / 2 - cx * CHW, ly = p.y - cy * CHH;
        if (lx < -110 || lx > CHW + 110 || ly < -110 || ly > CHH + 110) continue;
        const ii = ty2 * SIZE + tx2;
        const kk = this.tileKey(ii);
        const e = Math.max(1, this.world.elev[ii]);
        for (let l = 0; l < e; l++) rt.batchDraw(kk, lx, ly - l * 10);
      }
      rt.endDraw();
    }
  }

  jump() {
    if (!this.ready || this.jumpT >= 0 || this.sailing) return;
    this.jumpT = 0;
    this.send({ t: 'anim', a: 'j' });
    this.audio.swing();
  }

  // --- underground mining layer ---
  addDug(i: number) {
    if (this.digs.has(i)) return;
    this.digs.add(i);
    this.ugRock.get(i)?.destroy(); this.ugRock.delete(i);
    this.ugOre.get(i)?.destroy(); this.ugOre.delete(i);
    const x = i % SIZE, y = (i / SIZE) | 0;
    const p = this.iso(x, y);
    const f = this.add.image(p.x, p.y, 'cavefloor').setOrigin(0.5, 0).setDepth(-0.5).setVisible(this.z === 1);
    this.ugFloor.set(i, f);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      const ni = ny * SIZE + nx;
      if (!this.digs.has(ni) && !this.ugRock.has(ni)) {
        const np = this.iso(nx, ny);
        const r = this.add.image(np.x, np.y, 'rock').setOrigin(0.5, 0).setDepth(np.y + 20).setVisible(this.z === 1);
        this.ugRock.set(ni, r);
        const v = this.world.veins[ni];
        if (v && (this.world.tiles[ni] === T.GRASS || this.world.tiles[ni] === T.SAND || this.world.tiles[ni] === T.SNOW)) {
          const o = this.add.image(np.x, np.y + 14, v === 1 ? 'ironore' : 'diamondore')
            .setDepth(np.y + 21).setVisible(this.z === 1);
          this.ugOre.set(ni, o);
        }
      }
    }
  }

  setZ(z: number) {
    if (this.z === z) return;
    this.z = z;
    const surfA = z === 1 ? 0.15 : 1;
    for (const rt of this.chunks.values()) rt.setAlpha(surfA);
    for (const s of this.nodeSpr.values()) s.setAlpha(surfA);
    for (const e of this.structSpr.values()) { e.spr.setAlpha(surfA); e.extra.forEach((s) => s.setAlpha(surfA)); e.glow?.setAlpha(z === 1 ? 0.03 : 0.13); }
    this.monoSpr.forEach((s) => s.setAlpha(surfA));
    for (const s of this.creSpr.values()) s.setVisible(z === 0);
    for (const s of this.aniSpr.values()) s.setVisible(z === 0);
    for (const s of this.ugFloor.values()) s.setVisible(z === 1);
    for (const s of this.ugRock.values()) s.setVisible(z === 1);
    for (const s of this.ugOre.values()) s.setVisible(z === 1);
    for (const s of this.torchSpr.values()) s.setVisible(z === 1);
    for (const s of this.bergSpr.values()) s.setAlpha(surfA);
    for (const o of this.others.values()) o.rig.setVisible(o.z === z);
    this.send({ t: 'pos', x: +this.px.toFixed(2), y: +this.py.toFixed(2), z });
    showMsg(z === 1 ? '⛏ You descend into the mine. Dig with E — watch for ore glints in the rock.' : 'You climb back to the surface.');
  }

  setEquip(k: string | null) {
    if (k && !this.tools.has(k)) return;
    this.equipped = this.equipped === k ? null : k;
    this.me?.hold(this.equipped);
    this.send({ t: 'eq', k: this.equipped });
    if (this.equipped) showMsg(`Equipped: ${NAMES[this.equipped]}`, 1200);
  }

  setPlacing(kind: string | null) {
    this.placing = kind;
    this.ghost?.destroy(); this.ghost = null;
    if (kind) {
      this.ghost = this.add.sprite(0, 0, kind).setAlpha(0.55).setDepth(999999);
      if (kind === 'wall') this.ghost.setFlipX(this.placeDir === 1);
      showMsg(`Placing ${NAMES[kind]} — click a tile (ESC cancels${kind === 'wall' ? ', R rotates, click an existing wall to stack' : ''})`);
    }
  }

  onClick(ptr: Phaser.Input.Pointer) {
    if (!this.ready || !this.placing) return;
    const wp = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
    const { x, y } = this.unIso(wp.x, wp.y);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    this.send({ t: 'build', i: y * SIZE + x, kind: this.placing, dir: this.placeDir });
    if (this.inv[this.placing] <= 1) this.setPlacing(null);
  }

  addOther(pid: string, x: number, y: number) {
    if (this.others.has(pid) || pid === this.id) return;
    const p = this.isoE(x, y);
    const rig = new Rig(this, p.x, p.y, colorFor(pid));
    rig.setDepth(p.y);
    this.others.set(pid, { rig, tx: p.x, ty: p.y, z: 0 });
  }

  onMsg(m: any) {
    if (m.t === 'init') {
      this.id = m.id; this.px = m.x; this.py = m.y; this.wtime = m.time; this.day = m.day;
      this.mono = m.mono; this.won = m.won; this.inv = m.inv;
      this.weather = m.weather;
      this.buildWorld(m.seed, m.removed, m.mud, m.infected, m.brokenBergs);
      for (const [i, kind, hp, dir, lvl] of m.structures) for (let l = 1; l <= (lvl || 1); l++) this.addStruct(i, kind, hp, dir, l);
      for (const i of m.digs || []) this.addDug(i);
      for (const i of m.torches || []) this.addTorch(i);
      for (const [pid, x, y, eq, pz] of m.players) {
        this.addOther(pid, x, y);
        const o = this.others.get(pid);
        if (o) { o.z = pz || 0; o.rig.setVisible(o.z === this.z); if (eq) o.rig.hold(eq); }
      }
      this.ready = true;
      showMsg('You are a Keeper. Follow the objective tracker (top right). Press C to craft.', 6000);
    } else if (m.t === 'pj') { this.addOther(m.id, m.x, m.y); showMsg('A fellow Keeper has joined.'); }
    else if (m.t === 'pl') { const o = this.others.get(m.id); o?.rig.destroy(); this.others.delete(m.id); }
    else if (m.t === 'pos') {
      const o = this.others.get(m.id);
      if (o) {
        const nz = m.z || 0;
        const p = nz === 1 ? this.iso(m.x, m.y) : this.isoE(m.x, m.y);
        if (nz === 1) p.y += 16;
        o.tx = p.x; o.ty = p.y;
        if (nz !== o.z) { o.z = nz; o.rig.setVisible(o.z === this.z); o.rig.setPosition(p.x, p.y); }
      }
    }
    else if (m.t === 'anim') {
      const o = this.others.get(m.id);
      if (!o) return;
      if (m.a === 'j') this.tweens.add({ targets: o.rig, y: o.rig.y - 20, duration: 220, yoyo: true, ease: 'Sine.out' });
      else o.rig.act(m.a || null);
    }
    else if (m.t === 'eq') { const o = this.others.get(m.id); o?.rig.hold(m.k); }
    else if (m.t === 'inv') { this.inv = m.inv; this.tools = new Set(m.tools); this.gear = new Set(m.gear); }
    else if (m.t === 'msg') showMsg(m.s);
    else if (m.t === 'node') {
      const s = this.nodeSpr.get(m.i);
      if (m.hp === 0 && s) {           // depleted: fall + fade
        this.nodeSpr.delete(m.i);
        this.tweens.add({ targets: s, angle: 12, alpha: 0, y: s.y + 6, duration: 350, onComplete: () => s.destroy() });
      } else if (m.hp === -1) this.spawnNode(m.i);   // respawned
      else if (s) this.tweens.add({ targets: s, angle: { from: -5, to: 0 }, duration: 120 }); // hit shake
    }
    else if (m.t === 'mud') { for (const i of m.tiles) { this.mud.add(i); this.setTileMut(i, 'mud'); } showMsg('The soil sours — this sector\'s ecosystem is collapsing!'); }
    else if (m.t === 'dig') { for (const i of m.tiles) this.addDug(i); }
    else if (m.t === 'torch') { this.addTorch(m.i); this.audio.build(); }
    else if (m.t === 'boat') {
      this.sailing = false; this.boatKind = 0;
      this.boatSpr?.destroy(); this.boatSpr = null;
      this.audio.hurt();
      showMsg('💥 An iceberg shattered your boat! You wash ashore. A Reinforced Boat needs Starmetal.', 6000);
    }
    else if (m.t === 'berg') {
      this.bergSpr.get(m.i)?.destroy(); this.bergSpr.delete(m.i);
      if (m.pid === this.id) { this.audio.hitmob(); showMsg('Your reinforced hull smashes through the iceberg!'); }
    }
    else if (m.t === 'infect') { for (const i of m.tiles) this.setTileMut(i, 'blight'); }
    else if (m.t === 'cure') { for (const i of m.tiles) this.setTileMut(i, null); }
    else if (m.t === 'wx') {
      this.weather = m.kind;
      if (m.kind === 'rain') showMsg('🌧 Rain sweeps across the lowlands.');
      else if (m.kind === 'sandstorm') showMsg('🌪 A SANDSTORM scours the Dunes — shelter beside structures!');
      else if (m.kind === 'snowstorm') showMsg('❄ A BLIZZARD engulfs the Spire — reach a campfire!');
      else showMsg('The skies clear.');
    }
    else if (m.t === 'build') { this.audio.build(); this.addStruct(m.i, m.kind, m.hp, m.dir, m.lvl); }
    else if (m.t === 'sd') {
      const s = this.structSpr.get(m.i);
      if (!s) return;
      if (m.hp <= 0) { s.glow?.destroy(); s.extra.forEach((e) => e.destroy()); s.spr.destroy(); this.structSpr.delete(m.i); }
      else { s.hp = m.hp; this.tweens.add({ targets: [s.spr, ...s.extra], x: '+=2', duration: 60, yoyo: true }); }
    }
    else if (m.t === 'mono') {
      this.mono[m.i] = true;
      this.monoSpr[m.i]?.setTint(0x6dd6c8);
      showMsg(`⚡ Monolith of the ${MONO_NAMES[m.i]} awakened! (${this.mono.filter(Boolean).length}/4)`, 5000);
    }
    else if (m.t === 'wave') { this.waveEnd = Date.now() + m.secs * 1000; showMsg('⚔ THE FINAL ASSAULT BEGINS — DEFEND THE WORLD ENGINE!', 8000); }
    else if (m.t === 'win') { this.won = true; this.waveEnd = 0; showMsg('✨ THE WORLD ENGINE ROARS — THE BLIGHT IS PURGED. VICTORY!', 600000); }
    else if (m.t === 'hp') {
      if (m.hp < this.hp) this.audio.hurt();
      if (m.hp === 10 && this.hp <= 1) { this.px = m.x; this.py = m.y; if (this.z === 1) this.setZ(0); showMsg('You fell... reborn at your hearth.'); }
      else if (m.hp === 10 && this.hp < 10) { /* regen */ }
      else if (m.x !== undefined && Math.hypot(m.x - this.px, m.y - this.py) > 3) { this.px = m.x; this.py = m.y; }
      this.hp = m.hp;
    }
    else if (m.t === 'stat') { this.hunger = m.hunger; this.thirst = m.thirst; }
    else if (m.t === 'chit') { this.audio.hitmob(); const s = this.creSpr.get(m.id) || this.aniSpr.get(m.id); if (s) { s.setTintFill(0xffffff); setTimeout(() => s.clearTint(), 80); } }
    else if (m.t === 'cre') {
      this.wtime = m.time;
      const seen = new Set<string>();
      for (const [cid, x, y, type] of m.c) {
        seen.add(cid);
        let s = this.creSpr.get(cid);
        const p = this.isoE(x, y);
        if (!s) {
          s = this.add.sprite(p.x, p.y, CRE_TEX[type] || 'creature').setOrigin(0.5, 0.9).setVisible(this.z === 0);
          this.creSpr.set(cid, s);
          if (type === 'brute') s.setScale(1.15);
          if (type === 'wisp') { s.setAlpha(0.85); this.tweens.add({ targets: s, y: '-=6', duration: 900, yoyo: true, repeat: -1, ease: 'Sine.inOut' }); }
          else this.tweens.add({ targets: s, scaleY: s.scaleY * 0.92, duration: type === 'stalker' ? 180 : 300, yoyo: true, repeat: -1 });
        }
        s.setData('tx', p.x).setData('ty', p.y);
      }
      for (const [cid, s] of this.creSpr) if (!seen.has(cid)) { s.destroy(); this.creSpr.delete(cid); }
      const aseen = new Set<string>();
      for (const [aid, x, y, type] of m.a || []) {
        aseen.add(aid);
        let s = this.aniSpr.get(aid);
        const p = this.isoE(x, y);
        if (!s) {
          s = this.add.sprite(p.x, p.y, type || 'deer').setOrigin(0.5, 0.9).setVisible(this.z === 0);
          this.aniSpr.set(aid, s);
        }
        if (p.x < s.x - 0.5) s.setFlipX(true); else if (p.x > s.x + 0.5) s.setFlipX(false);
        s.setData('tx', p.x).setData('ty', p.y);
      }
      for (const [aid, s] of this.aniSpr) if (!aseen.has(aid)) { s.destroy(); this.aniSpr.delete(aid); }
    }
  }

  spawnNode(i: number) {
    const kind = NODE_KEYS[this.world.nodes.get(i)!];
    const p = this.isoE(i % SIZE, (i / SIZE) | 0);
    const [tex] = NODE_SPR[kind];
    const s = this.add.sprite(p.x, p.y + 20, tex).setOrigin(0.5, 0.92).setDepth(p.y + 20).setAlpha(1).setAngle(0);
    this.nodeSpr.set(i, s);
  }

  addStruct(i: number, kind: string, hp: number, dir = 0, lvl = 1) {
    const existing = this.structSpr.get(i);
    if (existing && lvl > 1 && existing.kind === kind) {   // stacked story on top
      existing.lvl = lvl; existing.hp = hp;
      const off = (STORY_OFF[kind] || 26) * (lvl - 1);
      const s = this.add.sprite(existing.spr.x, existing.spr.y - off, kind)
        .setOrigin(existing.spr.originX, existing.spr.originY)
        .setDepth(existing.spr.depth + lvl - 1).setFlipX(existing.spr.flipX)
        .setAlpha(this.z === 1 ? 0.15 : 1);
      existing.extra.push(s);
      return;
    }
    if (existing) return;
    const p = this.isoE(i % SIZE, (i / SIZE) | 0);
    // walls sit on the tile center and span the full diagonal so neighbors overlap
    const spr = kind === 'wall'
      ? this.add.sprite(p.x, p.y + 16, 'wall').setOrigin(0.5, 0.55).setDepth(p.y + 20)
      : this.add.sprite(p.x, p.y + 20, kind).setOrigin(0.5, 0.92).setDepth(p.y + 20);
    if (kind === 'wall' && dir) spr.setFlipX(true);
    if (this.z === 1) spr.setAlpha(0.15);
    const entry: any = { spr, extra: [], kind, hp, lvl };
    if (kind === 'campfire') {
      entry.glow = this.add.circle(p.x, p.y + 12, 70, 0xffaa44, 0.13).setDepth(p.y + 19).setBlendMode(Phaser.BlendModes.ADD);
    }
    this.structSpr.set(i, entry);
  }

  addTorch(i: number) {
    if (this.torchSpr.has(i)) return;
    const p = this.iso(i % SIZE, (i / SIZE) | 0);
    const s = this.add.image(p.x, p.y + 16, 'torch').setOrigin(0.5, 0.95).setDepth(p.y + 17).setVisible(this.z === 1);
    this.torchSpr.set(i, s);
  }

  buildWorld(seed: string, removed: number[], mudArr: number[], infectedArr: number[], brokenBergArr: number[]) {
    this.world = genWorld(seed);
    const broken = new Set(brokenBergArr || []);
    for (const i of this.world.bergs) {
      if (broken.has(i)) continue;
      const p = this.iso(i % SIZE, (i / SIZE) | 0);
      this.bergSpr.set(i, this.add.image(p.x, p.y + 16, 'iceberg').setOrigin(0.5, 0.85).setDepth(p.y + 16));
    }
    for (const [nx, ny, text] of NOTE_DEFS) {
      const [lx, ly] = nearestLand(this.world, nx, ny);
      const p = this.iso(lx, ly);
      this.add.image(p.x, p.y + 14, 'note').setOrigin(0.5, 0.9).setDepth(p.y + 14);
      this.notes.push({ x: lx, y: ly, text });
    }
    const gone = new Set(removed);
    this.mud = new Set(mudArr);
    for (const i of mudArr) this.mutTiles.set(i, 'mud');
    for (const i of infectedArr || []) this.mutTiles.set(i, 'blight');
    const W = SIZE * TW, H = SIZE * TH + 80;

    for (const i of this.world.nodes.keys()) if (!gone.has(i)) this.spawnNode(i);
    MONOLITHS.forEach(([mx, my], idx) => {
      const p = this.isoE(mx, my);
      const s = this.add.sprite(p.x, p.y + 16, 'monolith').setOrigin(0.5, 0.95).setDepth(p.y + 16);
      if (this.mono[idx]) s.setTint(0x6dd6c8);
      this.monoSpr.push(s);
    });

    const mp = this.isoE(this.px, this.py);
    this.me = new Rig(this, mp.x, mp.y, 0x3a6ea5);
    this.me.setDepth(mp.y);
    this.cameras.main.startFollow(this.me, true, 0.15, 0.15);
    this.cameras.main.setBounds(0, -80, W, H + 160);
    this.ensureChunks();
    this.nightRect = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x0a0a2e)
      .setOrigin(0).setScrollFactor(0).setDepth(999990).setAlpha(0);
  }

  tileAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return T.WATER;
    const i = (y | 0) * SIZE + (x | 0);
    if (this.mud.has(i)) return T.MUD;
    return this.world.tiles[i];
  }
  blockedAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return true;
    if (this.z === 1) return !this.digs.has((y | 0) * SIZE + (x | 0));   // underground: only carved tunnels
    if (this.tileAt(x, y) === T.WATER)
      return !(this.sailing || this.inv.boat > 0 || this.inv.sboat > 0);  // boats open the sea
    const climb = this.jumpT >= 0 ? 2 : 1;                               // jumping clears higher ledges
    if (Math.abs(this.elevAt(x, y) - this.elevAt(this.px, this.py)) > climb) return true;
    const st = this.structSpr.get((y | 0) * SIZE + (x | 0));
    return !!st && st.kind !== 'shelter';                                // shelters are enterable
  }

  nearMineshaft() {
    for (const [i, s] of this.structSpr)
      if (s.kind === 'mineshaft' && Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) < 2) return i;
    return -1;
  }

  interact() {
    if (!this.ready) return;
    const now = Date.now();
    if (now - this.lastGather < 300) return;
    this.lastGather = now;

    if (this.z === 1) {
      // exit via the shaft, or dig the rock face you're moving toward
      const shaft = this.nearMineshaft();
      if (shaft >= 0 && now - this.zToggleAt > 900) { this.zToggleAt = now; this.setZ(0); return; }
      const cx = this.px | 0, cy = this.py | 0;
      let best = -1, bs = -2;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const ni = ny * SIZE + nx;
        if (this.digs.has(ni)) continue;
        const tt = this.world.tiles[ni];
        if (tt !== T.GRASS && tt !== T.SAND && tt !== T.SNOW) continue;
        const score = (nx - cx) * this.faceX + (ny - cy) * this.faceY;
        if (score > bs) { bs = score; best = ni; }
      }
      if (best >= 0) {
        this.audio.chop();
        this.me.act(this.tools.has('spick') ? 'spick' : 'pick');
        this.send({ t: 'anim', a: 'pick' });
        this.send({ t: 'dig', i: best });
      }
      return;
    }
    // mine entrance? descend (checked first so nearby trees don't steal the keypress)
    const shaft = this.nearMineshaft();
    if (shaft >= 0 && now - this.zToggleAt > 900) {
      if (!this.digs.has(shaft)) { showMsg('The shaft is collapsed.'); return; }
      this.zToggleAt = now;
      this.px = (shaft % SIZE) + 0.5; this.py = ((shaft / SIZE) | 0) + 0.5;
      this.setZ(1);
      return;
    }
    // a hidden note?
    for (const n of this.notes)
      if (Math.hypot(n.x - this.px, n.y - this.py) < 1.8) { showMsg(n.text, 15000); return; }
    // nearest live node in reach
    let best = -1, bd = 2.4;
    for (const i of this.nodeSpr.keys()) {
      const d = Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      const kind = this.world.nodes.get(best)!;
      const tool = kind === 0 && this.tools.has('axe') ? 'axe' : (kind === 1 || kind === 4) ? (this.tools.has('spick') || this.tools.has('pick') ? 'pick' : null) : null;
      this.audio.chop();
      this.me.act(tool);
      this.send({ t: 'anim', a: tool });
      this.send({ t: 'gather', i: best });
      return;
    }
    // monolith?
    for (let idx = 0; idx < 4; idx++) {
      const [mx, my] = MONOLITHS[idx];
      if (!this.mono[idx] && Math.hypot(mx - this.px, my - this.py) < 3) {
        if (this.inv.core > 0) this.send({ t: 'usecore', i: idx });
        else showMsg('This Monolith needs a Monolith Core (forge: 8 crystal + 4 essence).');
        return;
      }
    }
    // water's edge? collect water
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (this.tileAt(this.px + dx, this.py + dy) === T.WATER) {
          this.me.act(null);
          this.send({ t: 'water' });
          return;
        }
  }

  attack() {
    if (!this.ready) return;
    this.audio.swing();
    this.me.act(this.equipped);
    this.send({ t: 'anim', a: this.equipped });
    this.send({ t: 'atk' });
  }

  update(t: number, dtMs: number) {
    if (!this.ready) return;
    const dt = Math.min(dtMs / 1000, 0.05);
    const k = this.keys;
    let dx = (+(k.D.isDown || k.RIGHT.isDown)) - (+(k.A.isDown || k.LEFT.isDown));
    let dy = (+(k.S.isDown || k.DOWN.isDown)) - (+(k.W.isDown || k.UP.isDown));
    this.me.moving = !!(dx || dy);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const wx = dx / len + dy / len, wy = dy / len - dx / len;
      this.me.face(dx || wx);
      this.faceX = Math.abs(wx) > Math.abs(wy) ? Math.sign(wx) : 0;
      this.faceY = this.faceX ? 0 : Math.sign(wy);
      const speed = (this.sailing ? 6.2 : this.z === 0 && this.tileAt(this.px, this.py) === T.MUD ? 2.2 : 4.4) * dt * 0.707;
      const nx = this.px + wx * speed, ny = this.py + wy * speed;
      if (!this.blockedAt(nx, this.py)) this.px = Math.max(0, Math.min(SIZE - 1, nx));
      if (!this.blockedAt(this.px, ny)) this.py = Math.max(0, Math.min(SIZE - 1, ny));
    }
    if (k.E.isDown) this.interact();
    this.me.tick(dt);
    // jump arc
    let hop = 0;
    if (this.jumpT >= 0) {
      this.jumpT += dt / 0.45;
      if (this.jumpT >= 1) this.jumpT = -1;
      else hop = Math.sin(Math.PI * this.jumpT) * 20;
    }
    // underground is flat — no hill offsets down there
    const p = this.z === 1 ? this.iso(this.px, this.py) : this.isoE(this.px, this.py);
    if (this.z === 1) p.y += 16;   // stand on the cave floor's center
    this.me.setPosition(p.x, p.y - hop).setDepth(p.y);
    this.ensureChunks();

    // boarding / disembarking boats at the water's edge
    if (this.z === 0) {
      const onWater = this.tileAt(this.px, this.py) === T.WATER;
      if (onWater && !this.sailing) {
        this.sailing = true;
        this.boatKind = this.inv.sboat > 0 ? 2 : 1;
        this.boatSpr = this.add.image(p.x, p.y + 4, 'boat').setOrigin(0.5, 0.6);
        if (this.boatKind === 2) this.boatSpr.setTint(0x9ad4e8);
        showMsg(this.boatKind === 2 ? '⛵ Sailing — your reinforced hull fears no ice.' : '⛵ You set sail. Beware icebergs near the Frozen Spire!');
      } else if (!onWater && this.sailing) {
        this.sailing = false; this.boatKind = 0;
        this.boatSpr?.destroy(); this.boatSpr = null;
      }
      if (this.sailing && this.boatSpr) this.boatSpr.setPosition(p.x, p.y + 4).setDepth(p.y - 1);
    }

    // see-through structures: fade anything standing in front of the player
    if (this.z === 0) {
      for (const e of this.structSpr.values()) {
        const occ = e.spr.depth > p.y && Math.abs(e.spr.x - p.x) < 64 && e.spr.y - p.y < 90 && e.spr.y - p.y > -10;
        const a = occ ? 0.35 : 1;
        if (e.spr.alpha !== a) { e.spr.setAlpha(a); e.extra.forEach((s) => s.setAlpha(a)); }
      }
    }

    // remote players: lerp + walk anim
    for (const o of this.others.values()) {
      const d = Math.hypot(o.tx - o.rig.x, o.ty - o.rig.y);
      o.rig.moving = d > 2;
      if (d > 0.5) {
        o.rig.face(o.tx - o.rig.x);
        o.rig.x += (o.tx - o.rig.x) * 0.18; o.rig.y += (o.ty - o.rig.y) * 0.18;
        o.rig.setDepth(o.rig.y);
      }
      o.rig.tick(dt);
    }
    // creatures & animals: lerp
    for (const s of [...this.creSpr.values(), ...this.aniSpr.values()]) {
      const tx = s.getData('tx'), ty = s.getData('ty');
      if (tx !== undefined) { s.x += (tx - s.x) * 0.15; s.y += (ty - s.y) * 0.15; s.setDepth(s.y); }
    }
    // ghost placement preview
    if (this.ghost) {
      const wp = this.cameras.main.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);
      const g = this.unIso(wp.x, wp.y);
      const gp = this.isoE(g.x, g.y);
      if (this.placing === 'wall') this.ghost.setPosition(gp.x, gp.y + 16).setOrigin(0.5, 0.55);
      else this.ghost.setPosition(gp.x, gp.y + 20).setOrigin(0.5, 0.92);
      const gi = g.y * SIZE + g.x;
      const target = this.structSpr.get(gi);
      const stackOk = !!target && target.kind === this.placing && target.lvl < (MAX_LVL[this.placing!] || 1);
      const ok = (stackOk || (!this.blockedAt(g.x, g.y) && !this.nodeSpr.has(gi))) &&
        Math.hypot(g.x - this.px, g.y - this.py) <= 6;
      this.ghost.setTint(ok ? 0x88ff88 : 0xff6666);
    }

    if (t - this.lastSend > 100) {
      this.lastSend = t;
      this.send({ t: 'pos', x: +this.px.toFixed(2), y: +this.py.toFixed(2), z: this.z, b: this.sailing ? this.boatKind : 0 });
    }

    // mine darkness: black veil with light pools around you, torches and the shaft
    if (this.z === 1) {
      const cam = this.cameras.main;
      if (this.darkRT.width !== this.scale.width || this.darkRT.height !== this.scale.height)
        this.darkRT.setSize(this.scale.width, this.scale.height);
      this.darkRT.setVisible(true).clear();
      this.darkRT.fill(0x02020a, 0.93);
      this.darkRT.erase('glow-s', p.x - cam.scrollX - 110, p.y - cam.scrollY - 110);
      for (const [i, s] of this.torchSpr) {
        const sx = s.x - cam.scrollX, sy = s.y - cam.scrollY;
        if (sx > -200 && sy > -200 && sx < this.scale.width + 200 && sy < this.scale.height + 200)
          this.darkRT.erase('glow-l', sx - 190, sy - 190);
      }
      for (const [i, e] of this.structSpr) {
        if (e.kind !== 'mineshaft') continue;
        const sx = e.spr.x - cam.scrollX, sy = e.spr.y - cam.scrollY;   // daylight spills down the shaft
        if (sx > -200 && sy > -200 && sx < this.scale.width + 200 && sy < this.scale.height + 200)
          this.darkRT.erase('glow-l', sx - 190, sy - 190);
      }
    } else this.darkRT.setVisible(false);

    const night = this.wtime > 0.65 || this.wtime < 0.1;
    const target = night ? 0.55 : this.wtime > 0.55 ? (this.wtime - 0.55) * 5.5 : 0;
    this.nightRect.setAlpha(Phaser.Math.Linear(this.nightRect.alpha, Math.min(target, 0.55), 0.02));
    this.nightRect.setSize(this.scale.width, this.scale.height);

    // weather visuals depend on which biome the player stands in (none underground)
    const zt = this.tileAt(this.px, this.py);
    const zone = zt === T.SAND ? 'sand' : zt === T.SNOW ? 'snow' : 'rain';
    const under = this.z === 1;
    const rainOn = !under && this.weather === 'rain' && zone === 'rain';
    const snowOn = !under && zone === 'snow';
    const sandOn = !under && this.weather === 'sandstorm' && zone === 'sand';
    if (rainOn !== this.rainFx.emitting) rainOn ? this.rainFx.start() : this.rainFx.stop();
    if (snowOn !== this.snowFx.emitting) {
      snowOn ? this.snowFx.start() : this.snowFx.stop();
    }
    if (snowOn) this.snowFx.setFrequency(this.weather === 'snowstorm' ? 15 : 130, this.weather === 'snowstorm' ? 6 : 2);
    if (sandOn !== this.sandFx.emitting) sandOn ? this.sandFx.start() : this.sandFx.stop();
    this.sandOverlay.setAlpha(Phaser.Math.Linear(this.sandOverlay.alpha, sandOn ? 0.2 : 0, 0.03));

    // audio: weather beds, generative score, footsteps, monster growls
    this.audio.setWeather(rainOn, sandOn, this.weather === 'snowstorm' && zone === 'snow', zone === 'snow');
    this.audio.update(dt, night);
    if (this.me.moving) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = 0.32;
        this.audio.step(under ? 'cave' : TILE_KEYS[zt] || 'grass');
      }
    } else this.stepTimer = 0;
    this.growlTimer -= dt;
    if (this.growlTimer <= 0) {
      let minD = 1e9;
      const myP = this.isoE(this.px, this.py);
      if (!under) for (const s of this.creSpr.values()) minD = Math.min(minD, Math.hypot(s.x - myP.x, s.y - myP.y) / 36);
      if (minD < 14) { this.audio.growl(1 - minD / 14); this.growlTimer = 1.2 + (minD / 14) * 3.5; }
      else this.growlTimer = 1.5;
    }

    this.updateUI({
      hp: this.hp, hunger: this.hunger, thirst: this.thirst,
      inv: this.inv, tools: this.tools, gear: this.gear, equipped: this.equipped,
      mono: this.mono, day: this.day, time: this.wtime, won: this.won,
      nearWorkbench: this.nearKind('workbench'), nearForge: this.nearKind('forge'), nearCampfire: this.nearKind('campfire'),
      structCount: (kind) => { let n = 0; for (const s of this.structSpr.values()) if (s.kind === kind) n++; return n; },
      waveSecs: this.waveEnd ? Math.max(0, Math.ceil((this.waveEnd - Date.now()) / 1000)) : 0
    });
  }

  nearKind(kind: string, r = 4) {
    for (const [i, s] of this.structSpr)
      if (s.kind === kind && Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) <= r) return true;
    return false;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#0d1520',
  scene: Hearth,
  scale: { mode: Phaser.Scale.RESIZE }
});
