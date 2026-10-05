import Phaser from "phaser";

/* ────────────────────────────────────────────────────────────────────────────
 * Island folk — the camps' villagers, hunter, child and elder.
 *
 * The Go server runs them (gameserver/room/folk.go): camps ride `init` as
 * `camps`, the folk ride every `cre` frame as `f: [id, x, y, kind, act]`, where
 * act is idle / walk / run / talk / sit / collect / build / craft / hide. This
 * view only draws: the hut and fire of each camp, a lerped sprite per folk
 * member with the pack's clips where a kind has them (villager, villager2) and
 * a procedural bob where it does not, and speech bubbles — a greeting when a
 * keeper walks up, a line on E, a shout when they bolt for the hut.
 * ──────────────────────────────────────────────────────────────────────────── */

export type Camp = {
  id: string;
  islandId: string;
  hutSprite: string;
  hutX: number;
  hutY: number;
  fireX: number;
  fireY: number;
};

type FolkRow = [string, number, number, string, string];

/** What FolkView needs from the game scene. */
export interface FolkHost extends Phaser.Scene {
  isoE(x: number, y: number): { x: number; y: number };
  iso(x: number, y: number): { x: number; y: number };
  world: { loadedAt(x: number, y: number): boolean };
  me: Phaser.GameObjects.Container | undefined;
  px: number;
  py: number;
  z: number;
}

const NAMES: Record<string, string> = {
  villager: "Hearthfolk",
  villager2: "Hearthfolk",
  woods_child: "Child",
  ashmark_hunter: "Ashmark hunter",
  elder_yvenne: "Elder Yvenne",
};

// Grounded, short, in-world: what people living on a blighted island would say.
const LINES: Record<string, string[]> = {
  villager: [
    "Keeper. Wood's stacked if the fire needs it.",
    "Crawlers came through the ferns last night. Mind your step.",
    "We patch the walls every morning. Blight eats the old posts.",
    "Light a fire before dark. They don't like the flame.",
    "My father kept the monolith on the north ridge. Before.",
  ],
  villager2: [
    "Mending nets, mostly. Fish don't care about the blight.",
    "If you find fiber, the reeds by the shore are best.",
    "The hut's small, but the door bars. That's what counts.",
    "The wolves hunt in threes. One comes straight, the others go wide.",
    "Rest a while, keeper. You look half-frozen.",
  ],
  woods_child: [
    "I saw a wisp! It was blue and it went right through a tree!",
    "Mum says I can't go past the stones.",
    "Are you a keeper? Do you fight the crawlers?",
    "The deer let me get really close this morning.",
  ],
  ashmark_hunter: [
    "Stalkers circle before they strike. Turn when they turn.",
    "Sand hides tracks fast. Read them early or not at all.",
    "Lancers keep their distance. Close it, or find a wall.",
    "I keep the fire. Somebody has to.",
    "The heat cloak's worth the hides. Trust me.",
  ],
  elder_yvenne: [
    "The marsh remembers what the land forgets, child.",
    "Bog shamblers are slow. Their rot is not.",
    "The old songs say the monoliths sang once. Light them and listen.",
    "Mud on your boots, blight in your blood. Wash both.",
    "Sit. The fire is warm, and the night is long.",
  ],
};

const SHOUTS = ["Blight! Inside, quick!", "They're coming — get in!", "Run!", "To the hut!"];

/** Kinds with full clip sets in HUMAN_CLIPS; the rest are single frames. */
const CLIPPED = new Set(["villager", "villager2"]);

type FolkSpr = Phaser.GameObjects.Sprite;

export class FolkView {
  private camps: Camp[] = [];
  private pending: Camp[] = [];
  private huts: Phaser.GameObjects.Image[] = [];
  private fires: { img: Phaser.GameObjects.Image; glow: Phaser.GameObjects.Arc; seed: number }[] = [];
  private spr = new Map<string, FolkSpr>();
  private bubbles = new Map<string, Phaser.GameObjects.Text>();
  private lineIdx = new Map<string, number>();
  private clock = 0;

  constructor(private s: FolkHost) {}

  /** The camp roster from `init`. Call blockTiles() for the tiles to block. */
  setCamps(camps: Camp[] | undefined) {
    this.camps = Array.isArray(camps) ? camps : [];
    this.pending = this.camps.slice();
    this.placePending();
  }

  /** Hut and fire tiles of every camp, as tile indices on a SIZE-wide world. */
  blockTiles(size: number): number[] {
    return this.camps.flatMap((c) => [c.hutY * size + c.hutX, c.fireY * size + c.fireX]);
  }

  /** Place the camps whose tiles have streamed in. */
  placePending() {
    if (!this.pending.length) return;
    const s = this.s;
    const still: Camp[] = [];
    for (const c of this.pending) {
      if (!s.world.loadedAt(c.hutX, c.hutY) || !s.world.loadedAt(c.fireX, c.fireY)) {
        still.push(c);
        continue;
      }
      const hp = s.isoE(c.hutX, c.hutY);
      this.huts.push(
        s.add
          .image(hp.x, hp.y + 16, c.hutSprite)
          .setOrigin(0.5, 0.92)
          .setDepth(s.iso(c.hutX, c.hutY).y + 18)
          .setVisible(s.z === 0),
      );
      const fp = s.isoE(c.fireX, c.fireY);
      const img = s.add
        .image(fp.x, fp.y + 16, "campfire")
        .setOrigin(0.5, 0.85)
        .setDepth(s.iso(c.fireX, c.fireY).y + 18)
        .setVisible(s.z === 0);
      const glow = s.add
        .circle(fp.x, fp.y + 12, 70, 0xffaa44, 0.13)
        .setDepth(s.iso(c.fireX, c.fireY).y + 19)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setVisible(s.z === 0);
      this.fires.push({ img, glow, seed: (c.fireX * 31 + c.fireY * 17) % 100 / 100 });
    }
    this.pending = still;
  }

  /** Apply the `f` list of a `cre` frame. */
  sync(rows: FolkRow[] | undefined) {
    if (!rows) return;
    const s = this.s;
    const seen = new Set<string>();
    for (const [id, x, y, kind, act] of rows) {
      seen.add(id);
      const p = s.isoE(x, y);
      let sp = this.spr.get(id);
      if (!sp) {
        sp = s.add.sprite(p.x, p.y, kind).setOrigin(0.5, 0.92).setVisible(s.z === 0);
        sp.setData({ kind, act: "", gvx: p.x, gvy: p.y, phase: Math.random() * 6, talkAt: -1e9, shoutAt: -1e9 });
        this.spr.set(id, sp);
      }
      sp.setData("tx", p.x).setData("ty", p.y);
      const prev = sp.getData("act");
      if (act !== prev) this.enter(id, sp, kind, act, prev);
    }
    for (const [id, sp] of this.spr)
      if (!seen.has(id)) {
        sp.destroy();
        this.bubbles.get(id)?.destroy();
        this.bubbles.delete(id);
        this.spr.delete(id);
      }
  }

  /** A folk member changed what they are doing. */
  private enter(id: string, sp: FolkSpr, kind: string, act: string, prev: string) {
    const s = this.s;
    sp.setData("act", act);
    sp.anims.stop();
    sp.anims.timeScale = 1;
    if (act === "hide") {
      s.tweens.add({ targets: sp, alpha: 0, duration: 250, onComplete: () => sp.setVisible(false) });
      return;
    }
    if (prev === "hide" || sp.alpha < 1) {
      sp.setVisible(s.z === 0);
      s.tweens.add({ targets: sp, alpha: 1, duration: 300 });
    }
    const clip = (a: string) => (CLIPPED.has(kind) && s.anims.exists(`${kind}_${a}`) ? `${kind}_${a}` : "");
    if (act === "walk" || act === "run") {
      const k = clip("walk");
      if (k) {
        sp.play(k);
        sp.anims.timeScale = act === "run" ? 1.7 : 1;
      }
      if (act === "run" && this.clock - sp.getData("shoutAt") > 6) {
        sp.setData("shoutAt", this.clock);
        this.say(id, SHOUTS[(Math.random() * SHOUTS.length) | 0], 1800);
      }
    } else if (act === "sit") {
      const k = clip("sit");
      if (k) sp.play(k);
    } else if (act === "collect" || act === "build" || act === "craft") {
      this.work(sp, clip(act));
    } else {
      sp.setTexture(kind);
      if (act === "talk" && this.clock - sp.getData("talkAt") > 12 && this.near(sp, 3.2)) {
        sp.setData("talkAt", this.clock);
        this.say(id, this.nextLine(id, kind), 3600);
      }
    }
  }

  /** Loop a one-shot work clip with a short breather between passes. */
  private work(sp: FolkSpr, key: string) {
    if (!key) return;
    const act = sp.getData("act");
    sp.play(key);
    sp.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      if (!sp.active || sp.getData("act") !== act) return;
      sp.setTexture(sp.getData("kind"));
      this.s.time.delayedCall(350 + Math.random() * 500, () => {
        if (sp.active && sp.getData("act") === act) this.work(sp, key);
      });
    });
  }

  private near(sp: FolkSpr, tiles: number) {
    const me = this.s.me;
    return !!me && Math.hypot(sp.x - me.x, sp.y - me.y) < tiles * 32;
  }

  private nextLine(id: string, kind: string) {
    const lines = LINES[kind] || LINES.villager;
    const n = this.lineIdx.get(id) ?? (id.length * 7) % lines.length;
    this.lineIdx.set(id, (n + 1) % lines.length);
    return lines[n];
  }

  /** A speech bubble over a folk member's head. */
  private say(id: string, text: string, ms: number) {
    const sp = this.spr.get(id);
    if (!sp || !sp.visible) return;
    this.bubbles.get(id)?.destroy();
    const who = NAMES[sp.getData("kind")] || "";
    const b = this.s.add
      .text(sp.x, sp.y - sp.displayHeight - 4, who ? `${who}\n${text}` : text, {
        fontFamily: "Georgia, serif",
        fontSize: "11px",
        color: "#2b2118",
        backgroundColor: "#f1e6cbee",
        padding: { x: 6, y: 4 },
        align: "center",
        wordWrap: { width: 170 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e6);
    this.bubbles.set(id, b);
    this.s.time.delayedCall(ms, () => {
      if (this.bubbles.get(id) === b) {
        this.s.tweens.add({ targets: b, alpha: 0, duration: 250, onComplete: () => b.destroy() });
        this.bubbles.delete(id);
      }
    });
  }

  /** E near a folk member: they say their next line. True if anyone answered. */
  talk(): boolean {
    let best: [string, FolkSpr] | null = null;
    let bd = 2.4 * 32;
    const me = this.s.me;
    if (!me) return false;
    for (const e of this.spr) {
      const sp = e[1];
      if (!sp.visible || sp.getData("act") === "run") continue;
      const d = Math.hypot(sp.x - me.x, sp.y - me.y);
      if (d < bd) [bd, best] = [d, e];
    }
    if (!best) return false;
    const [id, sp] = best;
    sp.setData("talkAt", this.clock);
    this.say(id, this.nextLine(id, sp.getData("kind")), 4200);
    return true;
  }

  setVisible(z: number) {
    for (const h of this.huts) h.setVisible(z === 0);
    for (const f of this.fires) {
      f.img.setVisible(z === 0);
      f.glow.setVisible(z === 0);
    }
    for (const sp of this.spr.values()) sp.setVisible(z === 0 && sp.getData("act") !== "hide");
    for (const b of this.bubbles.values()) b.setVisible(z === 0);
  }

  /** Per frame: lerp, face, procedural motion, fire flicker, bubbles follow. */
  tick(dt: number) {
    this.clock += dt;
    for (const f of this.fires) {
      const n = Math.sin(this.clock * (5 + f.seed * 4) + f.seed * 30) * 0.6 + Math.sin(this.clock * (11 + f.seed * 6)) * 0.4;
      f.glow.setAlpha(0.13 * (1 + n * 0.22)).setScale(1 + n * 0.05);
      f.img.setScale(1 + n * 0.02, 1 - n * 0.02);
    }
    const me = this.s.me;
    for (const [id, sp] of this.spr) {
      const tx = sp.getData("tx"), ty = sp.getData("ty");
      let vx = sp.getData("gvx"), vy = sp.getData("gvy");
      const nx = vx + (tx - vx) * 0.15, ny = vy + (ty - vy) * 0.15;
      const mx = nx - vx;
      vx = nx;
      vy = ny;
      sp.setData("gvx", vx).setData("gvy", vy);
      const act: string = sp.getData("act");
      // facing: along the walk, or toward the keeper they are talking to
      if (act === "talk" && me) sp.setFlipX(me.x < vx);
      else if (mx < -0.15) sp.setFlipX(true);
      else if (mx > 0.15) sp.setFlipX(false);
      // procedural motion for single-frame kinds (and a run's urgency for all)
      const kind: string = sp.getData("kind");
      const ph = sp.getData("phase") + dt * (act === "run" ? 16 : 9);
      sp.setData("phase", ph);
      let lift = 0, rot = 0, sy = 1;
      const moving = act === "walk" || act === "run";
      if (!CLIPPED.has(kind)) {
        if (moving) {
          lift = Math.abs(Math.sin(ph)) * (act === "run" ? 3 : 1.6);
          rot = Math.sin(ph) * (act === "run" ? 0.09 : 0.05);
        } else if (act === "sit") {
          sy = 0.82;
        } else if (act === "collect" || act === "build" || act === "craft") {
          sy = 0.94 + Math.sin(ph * 0.5) * 0.04;
          rot = Math.sin(ph * 0.5) * 0.04;
        } else {
          sy = 1 + Math.sin(ph * 0.25) * 0.012; // breathing
        }
      } else if (act === "run") {
        lift = Math.abs(Math.sin(ph)) * 1.5;
      }
      sp.setPosition(vx, vy - lift).setRotation(rot).setScale(1, sy).setDepth(vy);
      const b = this.bubbles.get(id);
      if (b) b.setPosition(sp.x, sp.y - sp.displayHeight - 4);
    }
  }
}
