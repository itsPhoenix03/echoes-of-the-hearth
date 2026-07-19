import Phaser from "phaser";
import {
  genWorld,
  nearestLand,
  SIZE,
  T,
  TILE_KEYS,
  MONOLITHS,
  ISLES,
  CORE,
  MOUNTAINS,
  TEMPLE_PIECES,
  LANDMARK_BLOCK,
} from "../shared/world.js";
import {
  NODE_KEYS,
  RECIPES,
  NAMES,
  emptyInv,
  DECOR_NONBLOCKING,
  FURNITURE,
} from "../shared/defs.js";
import { isNightTime, NIGHT_START } from "../shared/time.js";
import { Rig, makePartTextures } from "./rig.ts";
import { initUI, showMsg, UIState } from "./ui.ts";
import { GameAudio } from "./audio.ts";
import { ASSET_MANIFEST, NODE_SPR, STRUCT_SPR } from "./assets.ts";

const TW = 64,
  TH = 32;
const MONO_NAMES = [
  "Whispering Woods",
  "Sinking Dunes",
  "Frozen Spire",
  "Blighted Marsh",
];
const STORY_OFF: Record<string, number> = { wall: 25, shelter: 52 };
const MAX_LVL: Record<string, number> = { wall: 2, shelter: 3 };
const colorFor = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
  return Phaser.Display.Color.HSLToColor((h % 360) / 360, 0.6, 0.55).color;
};

const CRE_TEX: Record<string, string> = {
  crawler: "creature",
  stalker: "stalker",
  brute: "brute",
  wisp: "wisp",
  husk_wolf: "wolf",
  bog_shambler: "creature",
  frost_wraith: "wisp",
};
// decor/furniture kind -> texture key. SINGLE source of truth — ghost preview,
// addStruct (outdoor) and addFurn (indoor) must all use this map.
const DECOR_TEX: Record<string, string> = {
  banner: "mod_banner_blank",
  stone_path: "mod_floor_stone",
  rug: "cloth_roll",
  reed_vase: "reed_bundle",
  trophy_antler: "bone_totem",
  fence: "mod_railing",
};
const CHW = 1024,
  CHH = 512;

// Hidden clue notes — each island's note hints at the next, never with exact coordinates.
const NOTE_DEFS: [number, number, string][] = [
  [
    ISLES[0][0] + 7,
    ISLES[0][1] + 4,
    '📜 Weathered journal: "I left the whispering pines and sailed into the RISING SUN for a full day — two minutes hard sailing east. When hope thinned, golden dunes broke the horizon. Watch for a rock islet at the midpoint; shelter there if a storm finds you. And mark this — where forests and marshes grow, gold-flecked starfall stone hides among the rocks."',
  ],
  [
    ISLES[1][0] + 7,
    ISLES[1][1] + 4,
    '📜 Sun-bleached scroll: "From these dunes I fled DUE SOUTH across an empty sea, a day and a night. The southern crossing is long; a ruined islet breaks the journey — rest there if your hull is weary. Where the water turns black and the earth breathes, the marsh waits — and things wait in the marsh."',
  ],
  [
    ISLES[3][0] + 7,
    ISLES[3][1] + 4,
    '📜 Mud-stained page: "Chase the SETTING SUN from this bog and a frozen crown rises. The white teeth ring the WHOLE frozen isle now — no wooden hull survives any approach. Only a hull bound in fallen-star metal smashes through the teeth."',
  ],
  [
    ISLES[2][0] + 7,
    ISLES[2][1] + 4,
    '📜 Frost-rimed letter: "From the Spire\'s peak I finally saw it — the heart lies at the exact center of the world, ringed in scalding water, EQUALLY FAR FROM EVERY SHORE. Four songs must wake before its engine will turn."',
  ],
];

// Bird species config: key prefix, frame-rate
const BIRD_SPECIES: [string, number][] = [
  ["gull", 8],
  ["snow_tern", 10],
  ["ember_kite", 7],
  ["marsh_heron", 5],
  ["dune_falcon", 9],
  ["woods_thrush", 9],
];
// Which tile type spawns which species index
const TILE_BIRD: Record<number, string> = {
  [T.GRASS]: "woods_thrush",
  [T.SAND]: "dune_falcon",
  [T.SNOW]: "snow_tern",
  [T.MUD]: "marsh_heron",
  [T.BLIGHT]: "ember_kite",
  [T.WATER]: "gull",
};

interface BirdEntry {
  spr: Phaser.GameObjects.Sprite;
  vx: number;
  vy: number;
  bobPhase: number;
  baseY: number;
}

class Hearth extends Phaser.Scene {
  ws!: WebSocket;
  id = "";
  world!: {
    tiles: Uint8Array;
    elev: Uint8Array;
    veins: Uint8Array;
    nodes: Map<number, number>;
    bergs: Set<number>;
    waterTemp: Uint8Array;
    tileVis: Uint8Array;
    decor: Map<number, string>;
  };
  chunks = new Map<string, Phaser.GameObjects.RenderTexture>();
  mutTiles = new Map<number, string>(); // tile overrides: mud, blight infection
  weather: string | null = null;
  rainFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  snowFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  sandFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  sandOverlay!: Phaser.GameObjects.Rectangle;
  blizFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  blizOverlay!: Phaser.GameObjects.Rectangle;
  offX = ((SIZE - 1) * TW) / 2;
  me!: Rig;
  px = 40;
  py = 40;
  hp = 10;
  hunger = 10;
  thirst = 10;
  inv: any = emptyInv();
  tools = new Set<string>();
  gear = new Set<string>();
  equipped: string | null = null;
  wornGear: string | null = null;
  mono = [false, false, false, false];
  day = 1;
  wtime = 0.3;
  won = false;
  waveEnd = 0;
  others = new Map<
    string,
    {
      rig: Rig;
      tx: number;
      ty: number;
      wx: number;
      wy: number;
      z: number;
      b: number;
      boat: Phaser.GameObjects.Image | null;
      label: Phaser.GameObjects.Text;
    }
  >();
  monoSpr: Phaser.GameObjects.Sprite[] = [];
  creSpr = new Map<string, Phaser.GameObjects.Sprite>();
  aniSpr = new Map<string, Phaser.GameObjects.Sprite>();
  nodeSpr = new Map<number, Phaser.GameObjects.Sprite>();
  structSpr = new Map<
    number,
    {
      spr: Phaser.GameObjects.Sprite;
      extra: Phaser.GameObjects.Sprite[];
      kind: string;
      hp: number;
      lvl: number;
      glow?: Phaser.GameObjects.Arc;
    }
  >();
  mud = new Set<number>();
  z = 0;
  digs = new Set<number>();
  ugFloor = new Map<number, Phaser.GameObjects.Image>();
  ugRock = new Map<number, Phaser.GameObjects.Image>();
  ugOre = new Map<number, Phaser.GameObjects.Image>();
  jumpT = -1;
  faceX = 1;
  faceY = 0;
  zToggleAt = 0;
  chestReqI = -1;   // chest we asked to open — broadcasts for other chests must not pop our panel
  sailing = false;
  swimming = false;
  boatKind = 0;
  boatSpr: Phaser.GameObjects.Image | null = null;
  selectedVehicle: "boat" | "sboat" | null = null;
  warnedWaterTemp = false;
  decorSpr: Map<number, Phaser.GameObjects.Image> = new Map();
  mountainSpr: Phaser.GameObjects.Image[] = [];
  templeSpr: Phaser.GameObjects.Image[] = [];
  bergSpr = new Map<number, Phaser.GameObjects.Image>();
  torchSpr = new Map<number, Phaser.GameObjects.Image>();
  darkRT!: Phaser.GameObjects.RenderTexture;
  notes: { x: number; y: number; text: string }[] = [];
  shelterAnchor = -1;
  shelterLvl = 1;
  intFloor: Phaser.GameObjects.Image[] = [];
  furnSpr = new Map<number, Phaser.GameObjects.Image>();
  exitSpr = new Map<number, Phaser.GameObjects.Image>();
  keys!: any;
  nightRect!: Phaser.GameObjects.Rectangle;
  ghost: Phaser.GameObjects.Sprite | null = null;
  placing: string | null = null;
  placeDir = 0;
  updateUI!: (st: UIState) => void;
  uiApi!: any;
  cropSpr = new Map<number, Phaser.GameObjects.Image>(); // farmplot i -> crop overlay sprite
  audio = new GameAudio();
  stepTimer = 0;
  growlTimer = 1;
  lastSend = 0;
  lastGather = 0;
  ready = false;
  meLabel: Phaser.GameObjects.Text | null = null;
  myName = "Keeper";
  knockedUntil = 0; // ms timestamp: player knockback active until this time
  slowUntil = 0; // tick count: frost_wraith slow active until this tick (client-side)
  vignetteRect!: Phaser.GameObjects.Rectangle; // red damage flash overlay

  // Bird system
  birds: BirdEntry[] = [];
  birdTimer = 0;

  iso(x: number, y: number) {
    return { x: ((x - y) * TW) / 2 + this.offX, y: ((x + y) * TH) / 2 };
  }
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
    return {
      x: Math.floor(sy / (TH / 2) / 2 + lx / TW),
      y: Math.floor(sy / (TH / 2) / 2 - lx / TW),
    };
  }

  preload() {
    for (const [k, u, w, h] of ASSET_MANIFEST)
      this.load.svg(k, u, { width: w, height: h });
  }

  create() {
    makePartTextures(this);
    this.makeWeatherFx();
    this.makeGlowTextures();
    this.registerBirdAnims();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.hostname}:8081`);
    this.ws.onopen = () => {
      let tok = localStorage.getItem("hearth-tok");
      if (!tok) {
        tok = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("hearth-tok", tok);
      }
      // Task 5: player display name
      const urlName = new URLSearchParams(location.search).get("name");
      if (urlName) {
        this.myName = urlName;
        localStorage.setItem("hearth-name", urlName);
      } else {
        let stored = localStorage.getItem("hearth-name");
        if (!stored) {
          stored = "Keeper-" + Math.floor(1000 + Math.random() * 9000);
          localStorage.setItem("hearth-name", stored);
        }
        this.myName = stored;
      }
      this.send({ t: "hello", tok, name: this.myName });
    };
    this.ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
    this.ws.onclose = () =>
      showMsg("Disconnected. Is the server running? (npm run server)", 60000);

    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,LEFT,DOWN,RIGHT,E,SPACE",
    );
    this.input.keyboard!.on("keydown-SPACE", () => this.jump());
    this.input.keyboard!.on("keydown-F", () => this.attack());
    this.input.keyboard!.on("keydown-ESC", () => this.setPlacing(null));
    this.input.keyboard!.on("keydown-R", () => {
      if (
        this.placing &&
        ((RECIPES as any)[this.placing]?.rot || this.placing === "wall")
      ) {
        this.placeDir ^= 1;
        this.ghost?.setFlipX(this.placeDir === 1);
      }
    });
    this.input.keyboard!.on("keydown-T", () => {
      if (this.z === 1 && this.inv.torch > 0) this.send({ t: "torch" });
      else if (this.z === 1) showMsg("Craft torches first (2 wood + 1 fiber).");
    });
    const HOTBAR = ["axe", "pick", "spick", "sword", "isword"];
    this.input.keyboard!.on("keydown", (e: KeyboardEvent) => {
      this.audio.start(); // audio unlocks on first gesture
      const n = parseInt(e.key);
      if (n >= 1 && n <= 5) this.setEquip(HOTBAR[n - 1]);
      if (e.key === "m" || e.key === "M")
        showMsg(this.audio.toggleMute() ? "🔇 Muted" : "🔊 Sound on", 1000);
      if (e.key === "F9") this.send({ t: "dev" });
    });
    this.input.on("pointerdown", () => this.audio.start());
    this.input.on("pointerdown", (ptr: Phaser.Input.Pointer) =>
      this.onClick(ptr),
    );
    const uiApi = initUI(
      (r) => this.send({ t: "craft", r }),
      (k) => this.setPlacing(k),
      (k) => this.send({ t: "use", k }),
      (k) => this.setEquip(k),
      (k) => this.setWear(k),
      (k) => {
        // TASK 4a: toggle selected vehicle — but never from the water: boats launch from shore
        if (this.swimming || this.sailing) {
          showMsg(
            "You cannot ready a boat in the water — reach land first!",
            2500,
          );
          return;
        }
        this.selectedVehicle = this.selectedVehicle === k ? null : k;
        showMsg(
          this.selectedVehicle
            ? `⛵ ${NAMES[k]} selected — walk into the sea to sail.`
            : "Vehicle deselected. You will swim.",
          2000,
        );
      },
      (i, res, n) => this.send({ t: "chest_move", i, res, n }),
    );
    this.updateUI = uiApi;
    this.uiApi = uiApi;
    showMsg("Connecting to The Hearth...");

    // Red vignette flash for player damage — create once, reuse (Guide §2.4)
    this.vignetteRect = this.add
      .rectangle(0, 0, 4000, 3000, 0xaa2222)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(9999)
      .setAlpha(0);

    // One-frame death-particle texture (Guide §2.4)
    if (!this.textures.exists("fx-death")) {
      const gd = this.add.graphics();
      gd.fillStyle(0xff4444);
      gd.fillRect(0, 0, 6, 6);
      gd.generateTexture("fx-death", 6, 6);
      gd.destroy();
    }
  }

  // Task 4: send wear request
  setWear(k: string | null) {
    this.send({ t: "wear", k });
  }

  send(m: any) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  makeGlowTextures() {
    for (const [key, size] of [
      ["glow-s", 220],
      ["glow-l", 380],
    ] as [string, number][]) {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d")!;
      const grad = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2,
      );
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.6, "rgba(255,255,255,0.75)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      this.textures.addCanvas(key, c);
    }
    this.darkRT = this.add
      .renderTexture(0, 0, this.scale.width, this.scale.height)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(999993)
      .setVisible(false);
  }

  makeWeatherFx() {
    const g = this.add.graphics();
    g.fillStyle(0x9ac7ff);
    g.fillRect(0, 0, 2, 12);
    g.generateTexture("fx-rain", 2, 12);
    g.clear();
    g.fillStyle(0xffffff);
    g.fillCircle(3, 3, 3);
    g.generateTexture("fx-snow", 6, 6);
    g.clear();
    g.fillStyle(0xd8b060);
    g.fillRect(0, 0, 12, 2);
    g.generateTexture("fx-sand", 12, 2);
    g.clear();
    g.fillStyle(0xffffff);
    g.fillRect(0, 0, 10, 2.5);
    g.generateTexture("fx-bliz", 10, 3);
    g.destroy();
    this.rainFx = this.add
      .particles(0, 0, "fx-rain", {
        x: { min: 0, max: 2200 },
        y: -20,
        speedY: { min: 600, max: 800 },
        speedX: { min: -60, max: -120 },
        lifespan: 1800,
        quantity: 8,
        alpha: { min: 0.4, max: 0.8 },
        emitting: false,
      })
      .setScrollFactor(0)
      .setDepth(999995);
    this.snowFx = this.add
      .particles(0, 0, "fx-snow", {
        x: { min: 0, max: 2200 },
        y: -10,
        speedY: { min: 50, max: 110 },
        speedX: { min: -40, max: 40 },
        lifespan: 14000,
        quantity: 2,
        alpha: { min: 0.4, max: 0.9 },
        scale: { min: 0.4, max: 1 },
        emitting: false,
      })
      .setScrollFactor(0)
      .setDepth(999995);
    this.sandFx = this.add
      .particles(0, 0, "fx-sand", {
        x: -20,
        y: { min: 0, max: 1400 },
        speedX: { min: 500, max: 800 },
        speedY: { min: -40, max: 40 },
        lifespan: 3000,
        quantity: 6,
        alpha: { min: 0.3, max: 0.7 },
        emitting: false,
      })
      .setScrollFactor(0)
      .setDepth(999995);
    this.sandOverlay = this.add
      .rectangle(0, 0, 4000, 3000, 0xcc8833)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(999994)
      .setAlpha(0);
    // blizzard: hard diagonal snow driven by wind + white-out haze
    this.blizFx = this.add
      .particles(0, 0, "fx-bliz", {
        x: { min: -100, max: 2600 },
        y: { min: -150, max: 1300 },
        speedX: { min: -650, max: -450 },
        speedY: { min: 120, max: 220 },
        lifespan: 3200,
        quantity: 10,
        alpha: { min: 0.5, max: 0.95 },
        scale: { min: 0.6, max: 1.2 },
        rotate: 17,
        emitting: false,
      })
      .setScrollFactor(0)
      .setDepth(999995);
    this.blizOverlay = this.add
      .rectangle(0, 0, 4000, 3000, 0xdce8f5)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(999994)
      .setAlpha(0);
  }

  registerBirdAnims() {
    for (const [species, rate] of BIRD_SPECIES) {
      this.anims.create({
        key: `${species}_fly`,
        frames: [
          { key: `${species}_fly_1` },
          { key: `${species}_fly_2` },
          { key: `${species}_fly_3` },
          { key: `${species}_fly_2` },
        ],
        frameRate: rate,
        repeat: -1,
      });
    }
  }

  // Deterministic world-space birds, seeded from the SHARED server clock (day + time-of-day):
  // every client near the same island computes the exact same species, path and timing.
  birdSeen = new Set<number>();
  maybeSpawnBirds() {
    const absSec = this.day * 900 + this.wtime * 900;
    const w = Math.floor(absSec / 12);                    // one flight per island per 12s window
    const CENTERS = [...ISLES, CORE];
    const SPEC = ["woods_thrush", "dune_falcon", "snow_tern", "marsh_heron", "ember_kite"];
    for (let k = 0; k < 5; k++) {
      const key = w * 5 + k;
      if (this.birdSeen.has(key) || this.birds.length >= 10) continue;
      if (Math.hypot(this.px - CENTERS[k][0], this.py - CENTERS[k][1]) > 80) continue;
      this.birdSeen.add(key);
      let h = (key * 2654435761) >>> 0;
      const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
      const species = SPEC[k];
      const p0 = this.iso(CENTERS[k][0], CENTERS[k][1]);
      const fromLeft = rnd() < 0.5;
      const range = 2600;
      const startX = p0.x + (fromLeft ? -range : range);
      const baseY = p0.y - 420 + rnd() * 600;
      const speed = 60 + rnd() * 50;
      const vx = fromLeft ? speed : -speed;
      const vy = (rnd() - 0.5) * 20;
      const age = absSec - w * 12;                        // late joiners place the bird mid-flight
      const spr = this.add
        .sprite(startX + vx * age, baseY + vy * age, `${species}_fly_1`)
        .setOrigin(0.5, 0.5)
        .setScale(0.8 + rnd() * 0.3)
        .setDepth(999980)
        .setFlipX(vx > 0); // all bird art faces LEFT — flip when flying right
      spr.play(`${species}_fly`);
      spr.setData("cullAt", w * 12 + (2 * range) / speed + 5);
      this.birds.push({ spr, vx, vy, bobPhase: rnd() * Math.PI * 2, baseY });
    }
    if (this.birdSeen.size > 600) this.birdSeen.clear();
  }

  // --- chunk-streamed terrain (whole map is too large for one texture) ---
  ensureChunks() {
    const cam = this.cameras.main.worldView;
    const x0 = Math.floor((cam.x - 64) / CHW),
      x1 = Math.floor((cam.right + 64) / CHW);
    const y0 = Math.floor((cam.y - 80) / CHH),
      y1 = Math.floor((cam.bottom + 40) / CHH);
    const need = new Set<string>();
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) {
        const k = cx + "," + cy;
        need.add(k);
        if (!this.chunks.has(k)) this.chunks.set(k, this.drawChunk(cx, cy));
      }
    if (this.chunks.size > 24)
      for (const [k, rt] of this.chunks) {
        if (!need.has(k)) {
          rt.destroy();
          this.chunks.delete(k);
        }
        if (this.chunks.size <= 24) break;
      }
  }

  private tileKey(i: number) {
    if (this.mutTiles.has(i)) return this.mutTiles.get(i)!;
    const t = this.world.tiles[i];
    if (t === T.WATER) {
      const wt = this.world.waterTemp?.[i] ?? 0;
      if (wt === 1) return "water_freezing";
      if (wt === 2) return "water_hot";
      return "water";
    }
    if (this.world.tileVis?.[i] === 1) {
      if (t === T.GRASS) return "flower_grass";
      if (t === T.SAND) return "cracked_sand";
      if (t === T.SNOW) return "packed_ice";
      if (t === T.MUD) return "moss_stone";
      if (t === T.BLIGHT) return "ash";
    }
    return TILE_KEYS[t];
  }

  drawChunk(cx: number, cy: number) {
    const rt = this.add
      .renderTexture(cx * CHW, cy * CHH, CHW, CHH)
      .setOrigin(0)
      .setDepth(-1)
      .setAlpha(this.z !== 0 ? 0.15 : 1);
    const pad = 80,
      rx = cx * CHW,
      ry = cy * CHH;
    const inv = (sx: number, sy: number) => ({
      tx: (sy / (TH / 2) + (sx - this.offX) / (TW / 2)) / 2,
      ty: (sy / (TH / 2) - (sx - this.offX) / (TW / 2)) / 2,
    });
    const cs = [
      inv(rx - pad, ry - pad),
      inv(rx + CHW + pad, ry - pad),
      inv(rx - pad, ry + CHH + pad),
      inv(rx + CHW + pad, ry + CHH + pad),
    ];
    // Task 3b: compute unclamped tile range for ocean rendering
    const tx0 = Math.floor(Math.min(...cs.map((c) => c.tx)));
    const tx1 = Math.ceil(Math.max(...cs.map((c) => c.tx)));
    const ty0 = Math.floor(Math.min(...cs.map((c) => c.ty)));
    const ty1 = Math.ceil(Math.max(...cs.map((c) => c.ty)));
    rt.beginDraw();
    for (let y = ty0; y <= ty1; y++)
      for (let x = tx0; x <= tx1; x++) {
        const p = this.iso(x, y);
        if (
          p.x < rx - pad ||
          p.x > rx + CHW + pad ||
          p.y < ry - pad ||
          p.y > ry + CHH + pad
        )
          continue;
        // Task 3b: out-of-bounds tiles render as ocean water
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
          rt.batchDraw("water", p.x - TW / 2 - rx, p.y - ry);
          continue;
        }
        const i = y * SIZE + x;
        const key = this.tileKey(i);
        const e = Math.max(1, this.world.elev[i]);
        for (let l = 0; l < e; l++)
          rt.batchDraw(key, p.x - TW / 2 - rx, p.y - l * 10 - ry); // stacked skirts form cliffs
      }
    rt.endDraw();
    return rt;
  }

  // change a tile (mud / infection / cure) and repaint it on any loaded chunks
  setTileMut(i: number, key: string | null) {
    if (key) this.mutTiles.set(i, key);
    else this.mutTiles.delete(i);
    const x = i % SIZE,
      y = (i / SIZE) | 0;
    const list = [
      [x, y],
      [x + 1, y],
      [x, y + 1],
      [x + 1, y + 1],
    ].filter(([a, b]) => a < SIZE && b < SIZE);
    for (const [k, rt] of this.chunks) {
      const [ccx, ccy] = k.split(",").map(Number);
      rt.beginDraw();
      for (const [tx2, ty2] of list) {
        const p = this.iso(tx2, ty2);
        const lx = p.x - TW / 2 - ccx * CHW,
          ly = p.y - ccy * CHH;
        if (lx < -110 || lx > CHW + 110 || ly < -110 || ly > CHH + 110)
          continue;
        const ii = ty2 * SIZE + tx2;
        const kk = this.tileKey(ii);
        const e = Math.max(1, this.world.elev[ii]);
        for (let l = 0; l < e; l++) rt.batchDraw(kk, lx, ly - l * 10);
      }
      rt.endDraw();
    }
  }

  jump() {
    if (!this.ready || this.jumpT >= 0 || this.sailing || this.swimming) return;
    this.jumpT = 0;
    this.send({ t: "anim", a: "j" });
    this.audio.swing();
  }

  // --- underground mining layer ---
  addDug(i: number) {
    if (this.digs.has(i)) return;
    this.digs.add(i);
    this.ugRock.get(i)?.destroy();
    this.ugRock.delete(i);
    this.ugOre.get(i)?.destroy();
    this.ugOre.delete(i);
    const x = i % SIZE,
      y = (i / SIZE) | 0;
    const p = this.iso(x, y);
    const f = this.add
      .image(p.x, p.y, "cavefloor")
      .setOrigin(0.5, 0)
      .setDepth(-0.5)
      .setVisible(this.z === 1);
    this.ugFloor.set(i, f);
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      const ni = ny * SIZE + nx;
      if (!this.digs.has(ni) && !this.ugRock.has(ni)) {
        const np = this.iso(nx, ny);
        const r = this.add
          .image(np.x, np.y, "rock")
          .setOrigin(0.5, 0)
          .setDepth(np.y + 20)
          .setVisible(this.z === 1);
        this.ugRock.set(ni, r);
        const v = this.world.veins[ni];
        if (
          v &&
          (this.world.tiles[ni] === T.GRASS ||
            this.world.tiles[ni] === T.SAND ||
            this.world.tiles[ni] === T.SNOW)
        ) {
          const o = this.add
            .image(np.x, np.y + 14, v === 1 ? "ironore" : "diamondore")
            .setDepth(np.y + 21)
            .setVisible(this.z === 1);
          this.ugOre.set(ni, o);
        }
      }
    }
  }

  // FIX 1: furniture visibility gate — only show furn tiles belonging to THIS shelter or THIS mine tunnel
  // furniture is only visible on the LAYER it was placed on (tile indices are shared
  // between layers — a mine tunnel can run directly under a shelter's floor)
  furnVisible(i: number, fz: number): boolean {
    if (fz !== this.z) return false;
    if (this.z === 2) {
      const ax = this.shelterAnchor % SIZE,
        ay = (this.shelterAnchor / SIZE) | 0;
      return (
        Math.max(Math.abs((i % SIZE) - ax), Math.abs(((i / SIZE) | 0) - ay)) <=
        this.shelterLvl + 2
      );
    }
    if (this.z === 1) return this.digs.has(i);
    return false;
  }

  addFurn(i: number, kind: string, fz = 2) {
    if (this.furnSpr.has(i)) return;
    const p = this.iso(i % SIZE, (i / SIZE) | 0);
    const tex = DECOR_TEX[kind] || kind;
    const flat = (RECIPES as any)[kind]?.flat; // rug lies on the floor
    const s = flat
      ? this.add
          .image(p.x, p.y + 16, tex)
          .setOrigin(0.5, 0.5)
          .setDepth(p.y + 2)
      : this.add
          .image(p.x, p.y + 28, tex)
          .setOrigin(0.5, 0.9)
          .setDepth(p.y + 28);
    s.setData("fz", fz).setVisible(this.furnVisible(i, fz));
    this.furnSpr.set(i, s);
  }

  addCropOverlay(i: number, crop: string, stage: number) {
    // stage 0 = nothing visible yet
    if (stage === 0) return;
    const existing = this.cropSpr.get(i);
    if (existing) {
      existing.destroy();
      this.cropSpr.delete(i);
    }
    const p = this.isoE(i % SIZE, (i / SIZE) | 0);
    // pick texture: glowcap uses glow_mushroom, wheat uses crop
    const tex = crop === "glowcap" ? "glow_mushroom" : "crop";
    const scale = stage === 1 ? 0.55 : 1.0;
    // FIX 2: crop overlay alpha driven entirely by z — underground/indoors show ghost-faint
    const baseAlpha = stage === 1 ? 0.8 : 1.0;
    const alpha = this.z === 0 ? baseAlpha : 0.15;
    const s = this.add
      .image(p.x, p.y + 16, tex)
      .setOrigin(0.5, 0.92)
      .setDepth(p.y + 21)
      .setScale(scale)
      .setAlpha(alpha);
    this.cropSpr.set(i, s);
  }

  setZ(z: number) {
    if (this.z === z) return;
    this.z = z;
    const surfA = z !== 0 ? 0.15 : 1;
    // FEATURE 1: camera zoom per layer
    this.cameras.main.zoomTo(z === 2 || z === 1 ? 1.15 : 1, 400);
    // shelter interior floor — FEATURE 1: room half-width = shelterLvl + 2
    this.intFloor.forEach((s) => s.destroy());
    this.intFloor = [];
    if (z === 2 && this.shelterAnchor >= 0) {
      const ax = this.shelterAnchor % SIZE,
        ay = (this.shelterAnchor / SIZE) | 0,
        r = this.shelterLvl + 2;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const p = this.iso(ax + dx, ay + dy);
          this.intFloor.push(
            this.add
              .image(p.x, p.y, "cavefloor")
              .setOrigin(0.5, 0)
              .setTint(0xb8865a)
              .setDepth(-0.4),
          );
        }
    }
    for (const rt of this.chunks.values()) rt.setAlpha(surfA);
    // nodes: fully hidden in mines (faded ghosts read as "inside the cave"), faded in shelters
    for (const s of this.nodeSpr.values()) {
      s.setVisible(z !== 1);
      s.setAlpha(surfA);
    }
    for (const e of this.structSpr.values()) {
      e.spr.setAlpha(surfA);
      e.extra.forEach((s) => s.setAlpha(surfA));
      e.glow?.setAlpha(z === 1 ? 0.03 : 0.13);
    }
    this.monoSpr.forEach((s) => s.setAlpha(surfA));
    for (const s of this.decorSpr.values()) s.setAlpha(surfA);
    for (const s of this.mountainSpr) s.setAlpha(surfA);
    for (const s of this.templeSpr) s.setAlpha(surfA);
    for (const s of this.creSpr.values()) s.setVisible(z === 0);
    for (const s of this.aniSpr.values()) s.setVisible(z === 0);
    for (const s of this.ugFloor.values()) s.setVisible(z === 1);
    for (const s of this.ugRock.values()) s.setVisible(z === 1);
    for (const s of this.ugOre.values()) s.setVisible(z === 1);
    for (const s of this.torchSpr.values()) s.setVisible(z === 1);
    // FIX 1: use furnVisible() per-tile instead of blanket z===2
    for (const [i, s] of this.furnSpr)
      s.setVisible(this.furnVisible(i, s.getData("fz") ?? 2));
    // FIX 2: crop overlays — alpha 1 on surface, 0.15 underground/indoors
    for (const s of this.cropSpr.values()) s.setAlpha(z === 0 ? 1 : 0.15);
    for (const s of this.bergSpr.values()) s.setAlpha(surfA);
    // FEATURE 3: mine exit sprites visible only underground
    for (const s of this.exitSpr.values()) s.setVisible(z === 1);
    for (const o of this.others.values()) {
      o.rig.setVisible(o.z === z);
      o.label.setVisible(o.z === z);
      o.boat?.setVisible(o.z === z);
    }
    // hide birds underground
    for (const b of this.birds) b.spr.setVisible(z === 0);
    this.send({ t: "pos", x: +this.px.toFixed(2), y: +this.py.toFixed(2), z });
    showMsg(
      z === 1
        ? "⛏ You descend into the mine. Dig with E — watch for ore glints in the rock."
        : "You climb back to the surface.",
    );
  }

  setEquip(k: string | null) {
    if (k && !this.tools.has(k)) return;
    this.equipped = this.equipped === k ? null : k;
    this.me?.hold(this.equipped);
    this.send({ t: "eq", k: this.equipped });
    if (this.equipped) showMsg(`Equipped: ${NAMES[this.equipped]}`, 1200);
  }

  setPlacing(kind: string | null) {
    this.placing = kind;
    this.ghost?.destroy();
    this.ghost = null;
    if (kind) {
      const tex = DECOR_TEX[kind] || kind;
      this.ghost = this.add.sprite(0, 0, tex).setAlpha(0.55).setDepth(999999);
      const r = (RECIPES as any)[kind];
      const rotable = r?.rot || kind === "wall";
      if (rotable) this.ghost.setFlipX(this.placeDir === 1);
      showMsg(
        `Placing ${NAMES[kind] || kind} — click a tile (ESC cancels${rotable ? ", R rotates" : ""}${kind === "wall" || kind === "shelter" ? ", click existing to stack" : ""})`,
      );
    }
  }

  onClick(ptr: Phaser.Input.Pointer) {
    if (!this.ready || !this.placing) return;
    const wp = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
    const { x, y } = this.unIso(wp.x, wp.y);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    // FEATURE 2: furniture can also be placed in mines (z===1)
    if (this.z !== 0) {
      // interiors accept ONLY furniture — never fall through to a surface build
      if (FURNITURE.has(this.placing)) this.send({ t: "furn", i: y * SIZE + x, kind: this.placing });
      else { showMsg("That can only be placed outside."); this.setPlacing(null); }
    } else
      this.send({
        t: "build",
        i: y * SIZE + x,
        kind: this.placing,
        dir: this.placeDir,
      });
    if (this.inv[this.placing] <= 1) this.setPlacing(null);
  }

  addOther(pid: string, x: number, y: number, name?: string) {
    if (this.others.has(pid) || pid === this.id) return;
    const p = this.isoE(x, y);
    // color derives from the server-broadcast NAME (same string every client sees),
    // so a player's color matches on every screen — including their own.
    const rig = new Rig(this, p.x, p.y, colorFor(name || pid));
    rig.setDepth(p.y);
    const labelText = name || "Keeper";
    const label = this.add
      .text(p.x, p.y - 58, labelText, {
        fontSize: "11px",
        fontFamily: "monospace",
        color: "#cfe8f5",
        stroke: "#0a0f14",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(p.y + 1);
    // new players join on the surface (z=0) — hide them unless WE are on the surface too,
    // otherwise a player inside a shelter/mine sees the newcomer walking through their interior
    rig.setVisible(this.z === 0);
    label.setVisible(this.z === 0);
    this.others.set(pid, {
      rig,
      tx: p.x,
      ty: p.y,
      wx: x,
      wy: y,
      z: 0,
      b: 0,
      boat: null,
      label,
    });
  }

  // server-driven boat state for a remote player (b: 0 none, 1 wooden, 2 reinforced)
  setOtherBoat(
    o: { b: number; boat: Phaser.GameObjects.Image | null; rig: Rig },
    b: number,
  ) {
    if (o.b === b) return;
    o.b = b;
    if (b > 0 && !o.boat) {
      o.boat = this.add
        .image(o.rig.x, o.rig.y + 4, "boat")
        .setOrigin(0.5, 0.6)
        .setVisible(o.rig.visible);
      if (b === 2) o.boat.setTint(0x9ad4e8);
    } else if (b > 0 && o.boat) {
      b === 2 ? o.boat.setTint(0x9ad4e8) : o.boat.clearTint();
    } else if (b === 0 && o.boat) {
      o.boat.destroy();
      o.boat = null;
    }
  }

  onMsg(m: any) {
    if (m.t === "init") {
      this.id = m.id;
      this.px = m.x;
      this.py = m.y;
      this.wtime = m.time;
      this.day = m.day;
      if (m.name) this.myName = m.name; // server-sanitized name: the authoritative color/name source
      this.mono = m.mono;
      this.won = m.won;
      this.inv = m.inv;
      this.weather = m.weather;
      // Task 4: wornGear from init
      this.wornGear = m.wornGear ?? null;
      this.buildWorld(m.seed, m.removed, m.mud, m.infected, m.brokenBergs);
      for (const [i, kind, hp, dir, lvl] of m.structures)
        for (let l = 1; l <= (lvl || 1); l++)
          this.addStruct(i, kind, hp, dir, l);
      for (const i of m.digs || []) this.addDug(i);
      for (const i of m.torches || []) this.addTorch(i);
      for (const [i, kind, fz] of m.furn || []) this.addFurn(i, kind, fz ?? 2);
      for (const [i, crop, stage] of m.farms || [])
        this.addCropOverlay(i, crop, stage);
      for (const [pid, x, y, eq, pz, pname, pb] of m.players) {
        this.addOther(pid, x, y, pname);
        const o = this.others.get(pid);
        if (o) {
          o.z = pz || 0;
          o.rig.setVisible(o.z === this.z);
          o.label.setVisible(o.z === this.z);
          if (eq) o.rig.hold(eq);
          this.setOtherBoat(o, pb | 0);
        }
      }
      this.ready = true;
      showMsg(
        "You are a Keeper. Follow the objective tracker (top right). Press C to craft.",
        6000,
      );
    } else if (m.t === "pj") {
      this.addOther(m.id, m.x, m.y, m.name);
      showMsg("A fellow Keeper has joined.");
    } else if (m.t === "pl") {
      const o = this.others.get(m.id);
      if (o) {
        o.label.destroy();
        o.boat?.destroy();
        o.rig.destroy();
      }
      this.others.delete(m.id);
    } else if (m.t === "pos") {
      const o = this.others.get(m.id);
      if (o) {
        const nz = m.z || 0;
        const p = nz !== 0 ? this.iso(m.x, m.y) : this.isoE(m.x, m.y);
        if (nz !== 0) p.y += 16;
        o.tx = p.x;
        o.ty = p.y;
        o.wx = m.x;
        o.wy = m.y;
        this.setOtherBoat(o, m.b | 0);
        if (nz !== o.z) {
          o.z = nz;
          o.rig.setVisible(o.z === this.z);
          o.label.setVisible(o.z === this.z);
          o.boat?.setVisible(o.z === this.z);
          o.rig.setPosition(p.x, p.y);
        }
      }
    } else if (m.t === "anim") {
      const o = this.others.get(m.id);
      if (!o) return;
      if (m.a === "j")
        this.tweens.add({
          targets: o.rig,
          y: o.rig.y - 20,
          duration: 220,
          yoyo: true,
          ease: "Sine.out",
        });
      else o.rig.act(m.a || null);
    } else if (m.t === "eq") {
      const o = this.others.get(m.id);
      o?.rig.hold(m.k);
    } else if (m.t === "inv") {
      this.inv = m.inv;
      this.tools = new Set(m.tools);
      this.gear = new Set(m.gear);
      // Task 4: wornGear from inv update
      this.wornGear = m.wornGear ?? null;
    } else if (m.t === "msg") showMsg(m.s);
    else if (m.t === "node") {
      const s = this.nodeSpr.get(m.i);
      if (m.hp === 0 && s) {
        // depleted: fall + fade
        this.nodeSpr.delete(m.i);
        this.tweens.add({
          targets: s,
          angle: 12,
          alpha: 0,
          y: s.y + 6,
          duration: 350,
          onComplete: () => s.destroy(),
        });
      } else if (m.hp === -1)
        this.spawnNode(m.i); // respawned
      else if (s)
        this.tweens.add({
          targets: s,
          angle: { from: -5, to: 0 },
          duration: 120,
        }); // hit shake
    } else if (m.t === "mud") {
      for (const i of m.tiles) {
        this.mud.add(i);
        this.setTileMut(i, "mud");
      }
      showMsg("The soil sours — this sector's ecosystem is collapsing!");
    } else if (m.t === "dig") {
      for (const i of m.tiles) this.addDug(i);
    } else if (m.t === "torch") {
      this.addTorch(m.i);
      this.audio.build();
    } else if (m.t === "furn") {
      this.addFurn(m.i, m.kind, m.z ?? 2);
      this.audio.build();
    } else if (m.t === "boat") {
      this.sailing = false;
      this.boatKind = 0;
      this.boatSpr?.destroy();
      this.boatSpr = null;
      this.audio.hurt();
      // the hull is gone — you're in the water now, swim for it
      if (this.z === 0 && this.tileAt(this.px, this.py) === T.WATER)
        this.swimming = true;
      showMsg(
        m.r === "burn"
          ? "🔥 The scalding sea sets your wooden hull ABLAZE! You plunge into the burning water — swim!"
          : "💥 An iceberg shattered your boat! You plunge into the freezing sea — swim for land!",
        6000,
      );
    } else if (m.t === "berg") {
      this.bergSpr.get(m.i)?.destroy();
      this.bergSpr.delete(m.i);
      if (m.pid === this.id) {
        this.audio.hitmob();
        showMsg("Your reinforced hull smashes through the iceberg!");
      }
    } else if (m.t === "infect") {
      for (const i of m.tiles) this.setTileMut(i, "blight");
    } else if (m.t === "cure") {
      for (const i of m.tiles) this.setTileMut(i, null);
    } else if (m.t === "wx") {
      this.weather = m.kind;
      if (m.kind === "rain") showMsg("🌧 Rain sweeps across the lowlands.");
      else if (m.kind === "sandstorm")
        showMsg("🌪 A SANDSTORM scours the Dunes — shelter beside structures!");
      else if (m.kind === "snowstorm")
        showMsg("❄ A BLIZZARD engulfs the Spire — reach a campfire!");
      else showMsg("The skies clear.");
    } else if (m.t === "build") {
      this.audio.build();
      this.addStruct(m.i, m.kind, m.hp, m.dir, m.lvl);
    } else if (m.t === "crop") {
      // FIX 2: remove existing and recreate — addCropOverlay now applies z-correct alpha
      const old = this.cropSpr.get(m.i);
      if (old) {
        old.destroy();
        this.cropSpr.delete(m.i);
      }
      if (m.crop) this.addCropOverlay(m.i, m.crop, m.stage);
    } else if (m.t === "chest") {
      // FIX 3: open the panel if not already open for this chest; otherwise update
      if (this.uiApi) {
        if (!this.uiApi.isChestOpen()) {
          // chest broadcasts go to ALL players (live sync) — only open if WE requested this chest
          if (m.i === this.chestReqI) {
            this.chestReqI = -1;
            this.uiApi.openChest(m.i, m.slots || {});
          }
        } else {
          this.uiApi.updateChest(m.i, m.slots || {});
        }
      }
    } else if (m.t === "sd") {
      const s = this.structSpr.get(m.i);
      if (!s) return;
      if (m.hp <= 0) {
        s.glow?.destroy();
        s.extra.forEach((e) => e.destroy());
        s.spr.destroy();
        this.structSpr.delete(m.i);
        // clean up crop overlay if farmplot demolished
        const crop = this.cropSpr.get(m.i);
        if (crop) {
          crop.destroy();
          this.cropSpr.delete(m.i);
        }
        // FEATURE 3: clean up mineshaft exit marker
        const ex = this.exitSpr.get(m.i);
        if (ex) {
          ex.destroy();
          this.exitSpr.delete(m.i);
        }
      } else {
        s.hp = m.hp;
        this.tweens.add({
          targets: [s.spr, ...s.extra],
          x: "+=2",
          duration: 60,
          yoyo: true,
        });
      }
    } else if (m.t === "mono") {
      this.mono[m.i] = true;
      this.monoSpr[m.i]?.setTint(0x6dd6c8);
      showMsg(
        `⚡ Monolith of the ${MONO_NAMES[m.i]} awakened! (${this.mono.filter(Boolean).length}/4)`,
        5000,
      );
    } else if (m.t === "wave") {
      this.waveEnd = Date.now() + m.secs * 1000;
      showMsg("⚔ THE FINAL ASSAULT BEGINS — DEFEND THE WORLD ENGINE!", 8000);
    } else if (m.t === "win") {
      this.won = true;
      this.waveEnd = 0;
      showMsg(
        "✨ THE WORLD ENGINE ROARS — THE BLIGHT IS PURGED. VICTORY!",
        600000,
      );
    } else if (m.t === "hp") {
      if (m.hp < this.hp) {
        this.audio.hurt();
        // ang is only present for creature contact damage — gate all hit effects on it (Guide §5 regression watchlist)
        if (m.ang !== undefined) {
          this.audio.thud();
          this.audio.whoosh();
          // camera shake + red vignette (Guide §2.4)
          this.cameras.main.shake(90, 0.004);
          this.tweens.add({
            targets: this.vignetteRect,
            alpha: { from: 0.25, to: 0 },
            duration: 220,
          });
          // rig hurt pose
          this.me?.hurt(m.ang);
          // player knockback impulse (Guide §2.3)
          const kbDist = 0.7;
          const kbX = this.px + Math.cos(m.ang) * kbDist;
          const kbY = this.py + Math.sin(m.ang) * kbDist;
          if (!this.blockedAt(kbX, kbY)) {
            const now2 = this.time.now;
            this.knockedUntil = now2 + 120;
            const p2 = this.isoE(kbX, kbY);
            this.tweens.add({
              targets: this.me,
              x: p2.x,
              y: p2.y,
              duration: 120,
              ease: "Sine.easeOut",
              onComplete: () => {
                this.px = kbX;
                this.py = kbY;
              },
            });
          }
        }
        // frost_wraith slow (Guide §4.3 / substitutions)
        if (m.slow) {
          this.slowUntil = (this.slowUntil || 0) + m.slow;
        }
      }
      if (m.hp === 10 && this.hp <= 1) {
        this.px = m.x;
        this.py = m.y;
        if (this.z === 1) this.setZ(0);
        showMsg("You fell... reborn at your hearth.");
      } else if (m.hp === 10 && this.hp < 10) {
        /* regen */
      } else if (
        m.x !== undefined &&
        Math.hypot(m.x - this.px, m.y - this.py) > 3
      ) {
        this.px = m.x;
        this.py = m.y;
      }
      this.hp = m.hp;
    } else if (m.t === "slow") {
      // frost_wraith slow: sent as standalone message (Guide substitutions)
      this.slowUntil = (this.slowUntil || 0) + (m.ticks || 30);
    } else if (m.t === "ctel") {
      // brute telegraph: tint brute 0xffaa00 + play telegraph sound (Guide §3.3)
      const bs = this.creSpr.get(m.id);
      if (bs) {
        bs.setTint(0xffaa00);
        this.audio.telegraph();
        // tint clears when next cre broadcast updates position (windup is 8 ticks ~0.8s)
        setTimeout(() => bs.clearTint(), 900);
      }
    } else if (m.t === "stat") {
      this.hunger = m.hunger;
      this.thirst = m.thirst;
    } else if (m.t === "chit") {
      this.audio.hitmob();
      this.audio.whoosh();
      const s = this.creSpr.get(m.id) || this.aniSpr.get(m.id);
      if (s) {
        s.setTintFill(0xffffff);
        setTimeout(() => s.clearTint(), 80);
        // tween toward pushed position over 90ms with Back.easeOut (Guide §2.2)
        if (m.ang !== undefined) {
          const tx2 = s.getData("tx"),
            ty2 = s.getData("ty");
          if (tx2 !== undefined) {
            // push in screen-space: convert ang (world tile space) to iso screen offset
            // ang is tile-space angle away from attacker; 1 tile ≈ TW/2 iso-x, TH/2 iso-y
            const pushIsoX = tx2 + Math.cos(m.ang) * TW * 0.45;
            const pushIsoY = ty2 + Math.sin(m.ang) * TH * 0.45;
            this.tweens.add({
              targets: s,
              x: pushIsoX,
              y: pushIsoY,
              duration: 90,
              ease: "Back.easeOut",
            });
          }
        }
      }
    } else if (m.t === "cre") {
      this.wtime = m.time;
      if (m.day) this.day = m.day;
      const seen = new Set<string>();
      for (const [cid, x, y, type] of m.c) {
        seen.add(cid);
        let s = this.creSpr.get(cid);
        const p = this.isoE(x, y);
        if (!s) {
          s = this.add
            .sprite(p.x, p.y, CRE_TEX[type] || "creature")
            .setOrigin(0.5, 0.9)
            .setVisible(this.z === 0);
          this.creSpr.set(cid, s);
          if (type === "brute") s.setScale(1.15);
          if (type === "bog_shambler") {
            s.setTint(0x557755);
            s.setScale(1.3);
          }
          if (type === "frost_wraith") {
            s.setTint(0xbfe8ff);
            s.setAlpha(0.8);
          }
          if (type === "wisp" || type === "frost_wraith") {
            s.setAlpha(type === "frost_wraith" ? 0.8 : 0.85);
            this.tweens.add({
              targets: s,
              y: "-=6",
              duration: 900,
              yoyo: true,
              repeat: -1,
              ease: "Sine.inOut",
            });
          } else
            this.tweens.add({
              targets: s,
              scaleY: s.scaleY * 0.92,
              duration: type === "stalker" || type === "husk_wolf" ? 180 : 300,
              yoyo: true,
              repeat: -1,
            });
        }
        s.setData("tx", p.x).setData("ty", p.y);
      }
      for (const [cid, s] of this.creSpr)
        if (!seen.has(cid)) {
          // death tween: 120 ms scale→0.7, alpha→0, angle±20, then 4 particles (Guide §2.4)
          this.audio.killmob();
          const angleDir = Math.random() < 0.5 ? 20 : -20;
          this.tweens.add({
            targets: s,
            scaleX: 0.7,
            scaleY: 0.7,
            alpha: 0,
            angle: angleDir,
            duration: 120,
            onComplete: () => {
              // spawn 4 one-frame particles
              for (let pi = 0; pi < 4; pi++) {
                const a = (pi / 4) * Math.PI * 2;
                const px2 = s.x + Math.cos(a) * 12,
                  py2 = s.y + Math.sin(a) * 12;
                const p2 = this.add
                  .image(px2, py2, "fx-death")
                  .setDepth(s.depth + 1);
                this.tweens.add({
                  targets: p2,
                  x: px2 + Math.cos(a) * 14,
                  y: py2 + Math.sin(a) * 14,
                  alpha: 0,
                  duration: 200,
                  onComplete: () => p2.destroy(),
                });
              }
              s.destroy();
            },
          });
          this.creSpr.delete(cid);
        }
      const aseen = new Set<string>();
      for (const [aid, x, y, type] of m.a || []) {
        aseen.add(aid);
        let s = this.aniSpr.get(aid);
        const p = this.isoE(x, y);
        if (!s) {
          s = this.add
            .sprite(p.x, p.y, type || "deer")
            .setOrigin(0.5, 0.9)
            .setVisible(this.z === 0);
          this.aniSpr.set(aid, s);
        }
        if (p.x < s.x - 0.5) s.setFlipX(true);
        else if (p.x > s.x + 0.5) s.setFlipX(false);
        s.setData("tx", p.x).setData("ty", p.y);
      }
      for (const [aid, s] of this.aniSpr)
        if (!aseen.has(aid)) {
          s.destroy();
          this.aniSpr.delete(aid);
        }
    }
  }

  spawnNode(i: number) {
    const kind = NODE_KEYS[this.world.nodes.get(i)!];
    const p = this.isoE(i % SIZE, (i / SIZE) | 0);
    let tex: string;
    if (kind === "tree") {
      // deterministic variant per tile: tree / pine_tree / autumn_tree
      const variant = (Math.imul(i, 2654435761) >>> 0) % 3;
      tex = ["tree", "pine_tree", "autumn_tree"][variant];
    } else if (kind === "bush" && this.world.tiles[i] === T.MUD) {
      tex = "reed_bundle";
    } else {
      [tex] = NODE_SPR[kind];
    }
    const s = this.add
      .sprite(p.x, p.y + 20, tex)
      .setOrigin(0.5, 0.92)
      .setDepth(p.y + 20)
      .setAlpha(this.z === 2 ? 0.15 : 1)
      .setAngle(0)
      .setVisible(this.z !== 1);
    this.nodeSpr.set(i, s);
  }

  addStruct(i: number, kind: string, hp: number, dir = 0, lvl = 1) {
    const existing = this.structSpr.get(i);
    if (existing && lvl > 1 && existing.kind === kind) {
      // stacked story on top
      existing.lvl = lvl;
      existing.hp = hp;
      const off = (STORY_OFF[kind] || 26) * (lvl - 1);
      const s = this.add
        .sprite(existing.spr.x, existing.spr.y - off, kind)
        .setOrigin(existing.spr.originX, existing.spr.originY)
        .setDepth(existing.spr.depth + lvl - 1)
        .setFlipX(existing.spr.flipX)
        .setAlpha(this.z !== 0 ? 0.15 : 1);
      existing.extra.push(s);
      return;
    }
    if (existing) return;
    const p = this.isoE(i % SIZE, (i / SIZE) | 0);
    const r = (RECIPES as any)[kind];
    const isFlat = r?.flat === true;
    // resolve texture key: some decor kinds map to different asset keys
    const tex = DECOR_TEX[kind] || kind;
    let spr: Phaser.GameObjects.Sprite;
    if (isFlat) {
      // flat decor renders below entities, origin (0.5, 0.5)
      spr = this.add
        .sprite(p.x, p.y, tex)
        .setOrigin(0.5, 0.5)
        .setDepth(p.y - 8);
    } else if (kind === "wall") {
      spr = this.add
        .sprite(p.x, p.y + 16, tex)
        .setOrigin(0.5, 0.55)
        .setDepth(p.y + 20);
    } else {
      spr = this.add
        .sprite(p.x, p.y + 20, tex)
        .setOrigin(0.5, 0.92)
        .setDepth(p.y + 20);
    }
    if ((kind === "wall" || r?.rot) && dir) spr.setFlipX(true);
    if (this.z === 1) spr.setAlpha(0.15);
    const entry: any = { spr, extra: [], kind, hp, lvl };
    if (kind === "campfire") {
      entry.glow = this.add
        .circle(p.x, p.y + 12, 70, 0xffaa44, 0.13)
        .setDepth(p.y + 19)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
    if (kind === "lantern") {
      // small warm additive glow circle, shown at night
      entry.glow = this.add
        .circle(p.x, p.y + 10, 45, 0xffcc88, 0.1)
        .setDepth(p.y + 19)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
    // FEATURE 3: mineshaft exit marker visible from underground
    if (kind === "mineshaft" && !this.exitSpr.has(i)) {
      const ep = this.iso(i % SIZE, (i / SIZE) | 0);
      const es = this.add
        .image(ep.x, ep.y + 16, "ladder")
        .setOrigin(0.5, 0.9)
        .setDepth(ep.y + 18)
        .setVisible(this.z === 1);
      this.exitSpr.set(i, es);
    }
    // structures placed by OTHER players while we're in a shelter/mine must arrive faded
    const sa = this.z !== 0 ? 0.15 : 1;
    entry.spr.setAlpha(sa);
    entry.glow?.setAlpha(this.z !== 0 ? 0.03 : 0.1);
    this.structSpr.set(i, entry);
  }

  addTorch(i: number) {
    if (this.torchSpr.has(i)) return;
    const p = this.iso(i % SIZE, (i / SIZE) | 0);
    const s = this.add
      .image(p.x, p.y + 16, "torch")
      .setOrigin(0.5, 0.95)
      .setDepth(p.y + 17)
      .setVisible(this.z === 1);
    this.torchSpr.set(i, s);
  }

  buildWorld(
    seed: string,
    removed: number[],
    mudArr: number[],
    infectedArr: number[],
    brokenBergArr: number[],
  ) {
    this.world = genWorld(seed);
    const broken = new Set(brokenBergArr || []);
    for (const i of this.world.bergs) {
      if (broken.has(i)) continue;
      const p = this.iso(i % SIZE, (i / SIZE) | 0);
      this.bergSpr.set(
        i,
        this.add
          .image(p.x, p.y + 16, "iceberg")
          .setOrigin(0.5, 0.85)
          .setDepth(p.y + 16),
      );
    }
    for (const [nx, ny, text] of NOTE_DEFS) {
      const [lx, ly] = nearestLand(this.world, nx, ny);
      const p = this.iso(lx, ly);
      this.add
        .image(p.x, p.y + 14, "note")
        .setOrigin(0.5, 0.9)
        .setDepth(p.y + 14);
      this.notes.push({ x: lx, y: ly, text });
    }
    const gone = new Set(removed);
    this.mud = new Set(mudArr);
    for (const i of mudArr) this.mutTiles.set(i, "mud");
    for (const i of infectedArr || []) this.mutTiles.set(i, "blight");
    const W = SIZE * TW,
      H = SIZE * TH + 80;

    for (const i of this.world.nodes.keys())
      if (!gone.has(i)) this.spawnNode(i);
    MONOLITHS.forEach(([mx, my], idx) => {
      const p = this.isoE(mx, my);
      const s = this.add
        .sprite(p.x, p.y + 16, "monolith")
        .setOrigin(0.5, 0.95)
        .setDepth(p.y + 16);
      if (this.mono[idx]) s.setTint(0x6dd6c8);
      this.monoSpr.push(s);
    });

    // TASK 2a: mountains
    if (MOUNTAINS) {
      for (const m of MOUNTAINS) {
        const mp2 = this.isoE(m.x, m.y);
        const ms = this.add
          .image(mp2.x, mp2.y, m.key)
          .setOrigin(0.5, 0.9)
          .setDepth(this.iso(m.x, m.y).y + 40);
        this.mountainSpr.push(ms);
      }
    }

    // TASK 2b: temple pieces
    if (TEMPLE_PIECES) {
      for (const tpc of TEMPLE_PIECES) {
        const tx2 = tpc.i % SIZE,
          ty2 = (tpc.i / SIZE) | 0;
        const tp = this.isoE(tx2, ty2);
        const isDais = tpc.key === "core_activation_dais";
        const ts = isDais
          ? this.add
              .image(tp.x, tp.y + 16, tpc.key)
              .setOrigin(0.5, 0.7)
              .setDepth(this.iso(tx2, ty2).y + 4)
          : this.add
              .image(tp.x, tp.y + 16, tpc.key)
              .setOrigin(0.5, 0.9)
              .setDepth(this.iso(tx2, ty2).y + 20);
        this.templeSpr.push(ts);
      }
    }

    // TASK 2c: decor sprites
    if (this.world.decor) {
      for (const [di, dkey] of this.world.decor) {
        const dx2 = di % SIZE,
          dy2 = (di / SIZE) | 0;
        const dp = this.isoE(dx2, dy2);
        const ds = this.add
          .image(dp.x, dp.y, dkey)
          .setOrigin(0.5, 0.92)
          .setDepth(this.iso(dx2, dy2).y + 18);
        this.decorSpr.set(di, ds);
      }
    }

    const mp = this.isoE(this.px, this.py);
    this.me = new Rig(this, mp.x, mp.y, colorFor(this.myName)); // same hash others use for us
    this.me.setDepth(mp.y);
    this.cameras.main.startFollow(this.me, true, 0.15, 0.15);

    // Task 3c: extended camera bounds by PAD=24 tiles
    const PAD = 24;
    this.cameras.main.setBounds(
      0 - PAD * TW,
      -80 - PAD * TH,
      W + PAD * 2 * TW,
      H + 160 + PAD * 2 * TH,
    );

    this.ensureChunks();
    this.nightRect = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x0a0a2e)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(999990)
      .setAlpha(0);

    // Task 5: create self label after me rig exists
    this.meLabel = this.add
      .text(mp.x, mp.y - 58, this.myName, {
        fontSize: "11px",
        fontFamily: "monospace",
        color: "#cfe8f5",
        stroke: "#0a0f14",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(mp.y + 1);
  }

  tileAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return T.WATER;
    const i = (y | 0) * SIZE + (x | 0);
    if (this.mud.has(i)) return T.MUD;
    return this.world.tiles[i];
  }
  blockedAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return true;
    if (this.z === 1) return !this.digs.has((y | 0) * SIZE + (x | 0)); // underground: only carved tunnels
    if (this.z === 2) {
      // shelter interior: stay in the room
      const ax = this.shelterAnchor % SIZE,
        ay = (this.shelterAnchor / SIZE) | 0;
      // FEATURE 1: room half-width = shelterLvl + 2
      return (
        Math.max(Math.abs((x | 0) - ax), Math.abs((y | 0) - ay)) >
        this.shelterLvl + 2
      );
    }
    // TASK 4b: water is never blocked at z===0 — swimming is always possible
    if (this.tileAt(x, y) === T.WATER) return false;
    const climb = this.jumpT >= 0 ? 2 : 1; // jumping clears higher ledges
    // you can always drop DOWN a cliff (fall damage applies) — only climbing is limited
    if (this.elevAt(x, y) - this.elevAt(this.px, this.py) > climb) return true;
    const st = this.structSpr.get((y | 0) * SIZE + (x | 0));
    // shelters are enterable; non-blocking decor and farmplots are walkable
    if (
      st &&
      st.kind !== "shelter" &&
      !DECOR_NONBLOCKING.has(st.kind) &&
      st.kind !== "farmplot"
    )
      return true;
    // TASK 2d: landmark blocked tiles
    if (LANDMARK_BLOCK && LANDMARK_BLOCK.has((y | 0) * SIZE + (x | 0)))
      return true;
    return false;
  }

  nearMineshaft() {
    for (const [i, s] of this.structSpr)
      if (
        s.kind === "mineshaft" &&
        Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) < 2
      )
        return i;
    return -1;
  }

  interact() {
    if (!this.ready) return;
    const now = Date.now();
    if (now - this.lastGather < 300) return;
    this.lastGather = now;

    if (this.z === 2) {
      // FIX 3: chest check BEFORE shelter-exit — radius raised to 1.8
      for (const [i, s] of this.furnSpr)
        if (
          s.texture.key === "chest" &&
          s.getData("fz") === 2 &&
          Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) < 1.8
        ) {
          this.chestReqI = i;
          this.send({ t: "chest_open", i });
          return;
        }
      // close chest panel if E pressed while not near chest
      if (this.uiApi?.isChestOpen()) {
        this.uiApi.closeChest();
        return;
      }
      if (now - this.zToggleAt > 900) {
        this.zToggleAt = now;
        // always step out at THIS shelter's door — overlapping rooms must not teleport you elsewhere
        this.px = (this.shelterAnchor % SIZE) + 0.5;
        this.py = ((this.shelterAnchor / SIZE) | 0) + 1.5;
        this.setZ(0);
      }
      return;
    }
    if (this.z === 1) {
      // FEATURE 2: chest check in mine before shaft-exit and dig logic
      for (const [i, s] of this.furnSpr)
        if (
          s.texture.key === "chest" &&
          s.getData("fz") === 1 &&
          Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) < 1.8
        ) {
          this.chestReqI = i;
          this.send({ t: "chest_open", i });
          return;
        }
      // exit via the shaft, or dig the rock face you're moving toward
      const shaft = this.nearMineshaft();
      if (shaft >= 0 && now - this.zToggleAt > 900) {
        this.zToggleAt = now;
        this.setZ(0);
        return;
      }
      const cx = this.px | 0,
        cy = this.py | 0;
      let best = -1,
        bs = -2;
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const ni = ny * SIZE + nx;
        if (this.digs.has(ni)) continue;
        const tt = this.world.tiles[ni];
        if (tt !== T.GRASS && tt !== T.SAND && tt !== T.SNOW) continue;
        const score = (nx - cx) * this.faceX + (ny - cy) * this.faceY;
        if (score > bs) {
          bs = score;
          best = ni;
        }
      }
      if (best >= 0) {
        this.audio.chop();
        this.me.act(this.tools.has("spick") ? "spick" : "pick");
        this.send({ t: "anim", a: "pick" });
        this.send({ t: "dig", i: best });
      }
      return;
    }
    // mine entrance? descend (checked first so nearby trees don't steal the keypress)
    const shaft = this.nearMineshaft();
    if (shaft >= 0 && now - this.zToggleAt > 900) {
      if (!this.digs.has(shaft)) {
        showMsg("The shaft is collapsed.");
        return;
      }
      this.zToggleAt = now;
      this.px = (shaft % SIZE) + 0.5;
      this.py = ((shaft / SIZE) | 0) + 0.5;
      this.setZ(1);
      return;
    }
    // a shelter? step inside
    if (now - this.zToggleAt > 900)
      for (const [i, s] of this.structSpr)
        if (
          s.kind === "shelter" &&
          Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) < 1.6
        ) {
          this.zToggleAt = now;
          this.shelterAnchor = i;
          this.shelterLvl = s.lvl || 1;
          this.px = (i % SIZE) + 0.5;
          this.py = ((i / SIZE) | 0) + 0.5;
          this.setZ(2);
          showMsg(
            "🏠 Home. Place a Bed (respawn), Chest and Torches here. E to step outside.",
          );
          return;
        }
    // farmplot? plant or harvest
    for (const [i, s] of this.structSpr) {
      if (s.kind !== "farmplot") continue;
      if (Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) > 1.6)
        continue;
      const hasCrop = this.cropSpr.has(i);
      if (!hasCrop) {
        // plant: pick wheat if fiber≥2, else glowcap if essence≥1
        if ((this.inv.fiber || 0) >= 2) {
          this.send({ t: "plant", i, crop: "wheat" });
        } else if ((this.inv.essence || 0) >= 1) {
          this.send({ t: "plant", i, crop: "glowcap" });
        } else {
          showMsg(
            "Need 2 fiber (wheat) or 1 essence (glowcap) to plant.",
            3000,
          );
        }
      } else {
        // try harvest (server will reject if not stage 2)
        this.send({ t: "harvest", i });
      }
      return;
    }
    // a hidden note?
    for (const n of this.notes)
      if (Math.hypot(n.x - this.px, n.y - this.py) < 1.8) {
        showMsg(n.text, 15000);
        return;
      }
    // nearest live node in reach
    let best = -1,
      bd = 2.4;
    for (const i of this.nodeSpr.keys()) {
      const d = Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      const kind = this.world.nodes.get(best)!;
      const tool =
        kind === 0 && this.tools.has("axe")
          ? "axe"
          : kind === 1 || kind === 4
            ? this.tools.has("spick") || this.tools.has("pick")
              ? "pick"
              : null
            : null;
      this.audio.chop();
      this.me.act(tool);
      this.send({ t: "anim", a: tool });
      this.send({ t: "gather", i: best });
      return;
    }
    // monolith?
    for (let idx = 0; idx < 4; idx++) {
      const [mx, my] = MONOLITHS[idx];
      if (!this.mono[idx] && Math.hypot(mx - this.px, my - this.py) < 3) {
        if (this.inv.core > 0) this.send({ t: "usecore", i: idx });
        else
          showMsg(
            "This Monolith needs a Monolith Core (forge: 8 crystal + 4 essence).",
          );
        return;
      }
    }
    // water's edge? collect water
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (this.tileAt(this.px + dx, this.py + dy) === T.WATER) {
          this.me.act(null);
          this.send({ t: "water" });
          return;
        }
  }

  attack() {
    if (!this.ready) return;
    this.audio.swing();
    this.me.act(this.equipped);
    this.send({ t: "anim", a: this.equipped });
    this.send({ t: "atk" });
  }

  update(t: number, dtMs: number) {
    if (!this.ready) return;
    const dt = Math.min(dtMs / 1000, 0.05);
    const k = this.keys;
    let dx = +(k.D.isDown || k.RIGHT.isDown) - +(k.A.isDown || k.LEFT.isDown);
    let dy = +(k.S.isDown || k.DOWN.isDown) - +(k.W.isDown || k.UP.isDown);
    // suppress input during knockback tween (Guide §2.3)
    if (t < this.knockedUntil) {
      dx = 0;
      dy = 0;
    }
    // decrement slow counter each frame (client-side, not per-tick)
    if (this.slowUntil > 0) this.slowUntil--;
    this.me.moving = !!(dx || dy) && !this.sailing; // no leg-walk while seated in a boat
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const wx = dx / len + dy / len,
        wy = dy / len - dx / len;
      this.me.face(dx || wx);
      this.faceX = Math.abs(wx) > Math.abs(wy) ? Math.sign(wx) : 0;
      this.faceY = this.faceX ? 0 : Math.sign(wy);
      const slowed = this.slowUntil > 0;
      const baseSpeed = this.sailing
        ? 6.2
        : this.swimming ||
            (this.z === 0 && this.tileAt(this.px, this.py) === T.MUD)
          ? 2.2
          : 4.4;
      const speed = baseSpeed * (slowed ? 0.6 : 1) * dt * 0.707;
      const nx = this.px + wx * speed,
        ny = this.py + wy * speed;
      if (!this.blockedAt(nx, this.py))
        this.px = Math.max(0, Math.min(SIZE - 1, nx));
      if (!this.blockedAt(this.px, ny))
        this.py = Math.max(0, Math.min(SIZE - 1, ny));
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
    const p =
      this.z !== 0 ? this.iso(this.px, this.py) : this.isoE(this.px, this.py);
    if (this.z !== 0)
      p.y += 16; // stand on the flat interior/cave floor
    else if (this.swimming) p.y += 12; // swimming: sink to head level
    this.me.setPosition(p.x, p.y - hop).setDepth(p.y);
    this.ensureChunks();

    // Task 5: update self label position
    if (this.meLabel) {
      this.meLabel
        .setPosition(this.me.x, this.me.y - 58)
        .setDepth(this.me.depth + 1);
    }

    // TASK 4c: boarding / disembarking boats or swimming at the water's edge
    if (this.z === 0) {
      const onWater = this.tileAt(this.px, this.py) === T.WATER;
      if (onWater && !this.sailing && !this.swimming) {
        if (this.selectedVehicle && this.inv[this.selectedVehicle] > 0) {
          // sail with selected vehicle
          this.sailing = true;
          this.boatKind = this.selectedVehicle === "sboat" ? 2 : 1;
          this.boatSpr = this.add
            .image(p.x, p.y + 4, "boat")
            .setOrigin(0.5, 0.6);
          if (this.boatKind === 2) this.boatSpr.setTint(0x9ad4e8);
          showMsg(
            this.boatKind === 2
              ? "⛵ Sailing — your reinforced hull fears no ice."
              : "⛵ You set sail. Beware icebergs near the Frozen Spire!",
          );
        } else {
          // TASK 4c: swimming
          this.swimming = true;
          this.warnedWaterTemp = false;
          // TASK 4e: warn once about thermal water
          const wi = (this.py | 0) * SIZE + (this.px | 0);
          const wt = this.world.waterTemp?.[wi] ?? 0;
          if (wt === 1) {
            showMsg(
              "❄ The water is freezing — a Fur Cloak slows the damage. Boats are safe.",
              6000,
            );
            this.warnedWaterTemp = true;
          } else if (wt === 2) {
            showMsg(
              "🔥 Scalding water! The heat is lethal — a Heat Cloak helps, but a boat keeps you safe.",
              6000,
            );
            this.warnedWaterTemp = true;
          } else {
            showMsg(
              "🌊 Swimming — very slow. Craft a boat for safer, faster crossings.",
              4000,
            );
          }
        }
      } else if (!onWater && (this.sailing || this.swimming)) {
        this.sailing = false;
        this.swimming = false;
        this.boatKind = 0;
        this.boatSpr?.destroy();
        this.boatSpr = null;
      }
      if (this.sailing && this.boatSpr)
        this.boatSpr.setPosition(p.x, p.y + 4).setDepth(p.y - 1);
    }
    this.me.setSwim(this.z === 0 && this.swimming);

    // see-through structures: fade anything standing in front of the player
    if (this.z === 0) {
      for (const e of this.structSpr.values()) {
        const occ =
          e.spr.depth > p.y &&
          Math.abs(e.spr.x - p.x) < 64 &&
          e.spr.y - p.y < 90 &&
          e.spr.y - p.y > -10;
        const a = occ ? 0.35 : 1;
        if (e.spr.alpha !== a) {
          e.spr.setAlpha(a);
          e.extra.forEach((s) => s.setAlpha(a));
        }
      }
    }

    // remote players: lerp + walk anim
    for (const o of this.others.values()) {
      const d = Math.hypot(o.tx - o.rig.x, o.ty - o.rig.y);
      o.rig.moving = d > 2 && o.b === 0; // seated in a boat: no walk cycle
      // swim only when the server says they're not boating and they're on water
      o.rig.setSwim(
        o.z === 0 && o.b === 0 && this.tileAt(o.wx, o.wy) === T.WATER,
      );
      if (o.boat)
        o.boat.setPosition(o.rig.x, o.rig.y + 4).setDepth(o.rig.depth - 1);
      if (d > 0.5) {
        o.rig.face(o.tx - o.rig.x);
        o.rig.x += (o.tx - o.rig.x) * 0.18;
        o.rig.y += (o.ty - o.rig.y) * 0.18;
        o.rig.setDepth(o.rig.y);
      }
      o.rig.tick(dt);
      // Task 5: update other player labels
      o.label.setPosition(o.rig.x, o.rig.y - 58).setDepth(o.rig.depth + 1);
    }
    // creatures & animals: lerp
    for (const s of [...this.creSpr.values(), ...this.aniSpr.values()]) {
      const tx = s.getData("tx"),
        ty = s.getData("ty");
      if (tx !== undefined) {
        s.x += (tx - s.x) * 0.15;
        s.y += (ty - s.y) * 0.15;
        s.setDepth(s.y);
      }
    }
    // ghost placement preview
    if (this.ghost) {
      const wp = this.cameras.main.getWorldPoint(
        this.input.activePointer.x,
        this.input.activePointer.y,
      );
      const g = this.unIso(wp.x, wp.y);
      const gp = this.isoE(g.x, g.y);
      const pR = (RECIPES as any)[this.placing!];
      if (pR?.flat) this.ghost.setPosition(gp.x, gp.y).setOrigin(0.5, 0.5);
      else if (this.placing === "wall")
        this.ghost.setPosition(gp.x, gp.y + 16).setOrigin(0.5, 0.55);
      else this.ghost.setPosition(gp.x, gp.y + 20).setOrigin(0.5, 0.92);
      const gi = g.y * SIZE + g.x;
      const target = this.structSpr.get(gi);
      const stackOk =
        !!target &&
        target.kind === this.placing &&
        target.lvl < (MAX_LVL[this.placing!] || 1);
      // FEATURE 2: ghost valid in mine when tile is dug
      const mineOk =
        this.z === 1 && FURNITURE.has(this.placing!) && this.digs.has(gi);
      const ok =
        (stackOk ||
          (!this.blockedAt(g.x, g.y) &&
            (this.z === 2 || mineOk || !this.nodeSpr.has(gi)))) &&
        Math.hypot(g.x - this.px, g.y - this.py) <= 6;
      this.ghost.setTint(ok ? 0x88ff88 : 0xff6666);
    }

    if (t - this.lastSend > 100) {
      this.lastSend = t;
      // TASK 4d: swimmers send b=0; only sailing sends boatKind
      this.send({
        t: "pos",
        x: +this.px.toFixed(2),
        y: +this.py.toFixed(2),
        z: this.z,
        b: this.sailing ? this.boatKind : 0,
      });
    }

    // mine darkness: black veil with light pools around you, torches and the shaft
    if (this.z === 1) {
      const cam = this.cameras.main;
      if (
        this.darkRT.width !== this.scale.width ||
        this.darkRT.height !== this.scale.height
      )
        this.darkRT.setSize(this.scale.width, this.scale.height);
      this.darkRT.setVisible(true).clear();
      this.darkRT.fill(0x02020a, 0.93);
      // FEATURE 1: darkness erase must account for camera zoom
      // sx = (worldX - worldView.x) * zoom; same for y
      const wv = cam.worldView;
      const zoom = cam.zoom;
      const toSx = (wx: number) => (wx - wv.x) * zoom;
      const toSy = (wy: number) => (wy - wv.y) * zoom;
      const psx = toSx(p.x),
        psy = toSy(p.y);
      this.darkRT.erase("glow-s", psx - 110, psy - 110);
      for (const [, s] of this.torchSpr) {
        const sx = toSx(s.x),
          sy = toSy(s.y);
        if (
          sx > -200 &&
          sy > -200 &&
          sx < this.scale.width + 200 &&
          sy < this.scale.height + 200
        )
          this.darkRT.erase("glow-l", sx - 190, sy - 190);
      }
      for (const [, e] of this.structSpr) {
        if (e.kind !== "mineshaft") continue;
        const sx = toSx(e.spr.x),
          sy = toSy(e.spr.y); // daylight spills down the shaft
        if (
          sx > -200 &&
          sy > -200 &&
          sx < this.scale.width + 200 &&
          sy < this.scale.height + 200
        )
          this.darkRT.erase("glow-l", sx - 190, sy - 190);
      }
    } else this.darkRT.setVisible(false);

    // Task 2: use isNightTime and NIGHT_START for dusk formula
    const night = isNightTime(this.wtime);
    const duskThresh = NIGHT_START - 0.1;
    const target = night
      ? 0.55
      : this.wtime > duskThresh
        ? (this.wtime - duskThresh) * 5.5
        : 0;
    this.nightRect.setAlpha(
      Phaser.Math.Linear(this.nightRect.alpha, Math.min(target, 0.55), 0.02),
    );
    this.nightRect.setSize(this.scale.width, this.scale.height);

    // weather visuals depend on which biome the player stands in (none underground)
    const zt = this.tileAt(this.px, this.py);
    const zone = zt === T.SAND ? "sand" : zt === T.SNOW ? "snow" : "rain";
    const under = this.z !== 0;
    const rainOn = !under && this.weather === "rain" && zone === "rain";
    const snowOn = !under && zone === "snow";
    const sandOn = !under && this.weather === "sandstorm" && zone === "sand";
    const blizOn = !under && this.weather === "snowstorm" && zone === "snow";
    if (rainOn !== this.rainFx.emitting)
      rainOn ? this.rainFx.start() : this.rainFx.stop();
    if (snowOn !== this.snowFx.emitting)
      snowOn ? this.snowFx.start() : this.snowFx.stop();
    if (sandOn !== this.sandFx.emitting)
      sandOn ? this.sandFx.start() : this.sandFx.stop();
    if (blizOn !== this.blizFx.emitting)
      blizOn ? this.blizFx.start() : this.blizFx.stop();
    this.sandOverlay.setAlpha(
      Phaser.Math.Linear(this.sandOverlay.alpha, sandOn ? 0.2 : 0, 0.03),
    );
    this.blizOverlay.setAlpha(
      Phaser.Math.Linear(this.blizOverlay.alpha, blizOn ? 0.16 : 0, 0.03),
    );

    // audio: weather beds, generative score, footsteps, monster growls
    this.audio.setWeather(
      rainOn,
      sandOn,
      this.weather === "snowstorm" && zone === "snow",
      zone === "snow",
    );
    this.audio.update(dt, night);
    if (this.me.moving) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = 0.32;
        this.audio.step(under ? "cave" : TILE_KEYS[zt] || "grass");
      }
    } else this.stepTimer = 0;
    this.growlTimer -= dt;
    if (this.growlTimer <= 0) {
      let minD = 1e9;
      const myP = this.isoE(this.px, this.py);
      if (!under)
        for (const s of this.creSpr.values())
          minD = Math.min(minD, Math.hypot(s.x - myP.x, s.y - myP.y) / 36);
      if (minD < 14) {
        this.audio.growl(1 - minD / 14);
        this.growlTimer = 1.2 + (minD / 14) * 3.5;
      } else this.growlTimer = 1.5;
    }

    // Task 6: ambient bird system
    if (this.z === 0) {
      this.maybeSpawnBirds();
      const absSec2 = this.day * 900 + this.wtime * 900;
      for (let bi = this.birds.length - 1; bi >= 0; bi--) {
        const bird = this.birds[bi];
        bird.bobPhase += dt * 2.5;
        bird.spr.x += bird.vx * dt;
        bird.spr.y = bird.baseY + Math.sin(bird.bobPhase) * 6;
        bird.baseY += bird.vy * dt;
        // cull by deterministic flight lifetime (shared across clients)
        if (absSec2 > (bird.spr.getData("cullAt") ?? 0)) {
          bird.spr.destroy();
          this.birds.splice(bi, 1);
        }
      }
    } else {
      // hide birds when underground / in shelter
      for (const bird of this.birds) bird.spr.setVisible(false);
    }

    this.updateUI({
      hp: this.hp,
      hunger: this.hunger,
      thirst: this.thirst,
      inv: this.inv,
      tools: this.tools,
      gear: this.gear,
      equipped: this.equipped,
      wornGear: this.wornGear,
      selectedVehicle: this.selectedVehicle,
      inWater: this.swimming || this.sailing,
      mono: this.mono,
      day: this.day,
      time: this.wtime,
      won: this.won,
      nearWorkbench: this.nearKind("workbench"),
      nearForge: this.nearKind("forge"),
      nearCampfire: this.nearKind("campfire"),
      structCount: (kind) => {
        let n = 0;
        for (const s of this.structSpr.values()) if (s.kind === kind) n++;
        return n;
      },
      waveSecs: this.waveEnd
        ? Math.max(0, Math.ceil((this.waveEnd - Date.now()) / 1000))
        : 0,
      zone: this.z === 0 ? "out" : "in",   // mines count as interior too
    });
  }

  nearKind(kind: string, r = 4) {
    for (const [i, s] of this.structSpr)
      if (
        s.kind === kind &&
        Math.hypot((i % SIZE) - this.px, ((i / SIZE) | 0) - this.py) <= r
      )
        return true;
    return false;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: "#3a7bd5",
  scene: Hearth,
  scale: { mode: Phaser.Scale.RESIZE },
});
