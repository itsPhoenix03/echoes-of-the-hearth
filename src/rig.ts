import Phaser from 'phaser';

/* ────────────────────────────────────────────────────────────────────────────
 * POSE MODEL — read this before touching anything below.
 *
 * Hierarchy
 *   Rig (Container)          main.ts owns x / y / depth / setScale(±1) facing.
 *                            The rig itself NEVER writes its own x/y.
 *   └ bodyRoot (Container)   rig-owned visual root, pivot at the feet (0,0).
 *                            Jump hop, hurt recoil and action lean/push/crouch
 *                            all live here so they cannot fight world lerping.
 *      ├ legL, legR
 *      ├ armLRoot → armL
 *      ├ torso, head
 *      └ armRRoot → armR
 *                 └ handR → tool     (tool origin = per-tool grip point)
 *
 * ONE WRITER RULE
 *   tick(dt) is the only thing that writes part transforms. There are no tweens
 *   and no setTimeouts in this file. Every animation is a scalar timer advanced
 *   by dt and sampled into locals, then applied exactly once in applyPose().
 *   Consequence: no flag can stick, no tween can outlive its guard, and an
 *   interrupted anything still converges back to rest on the next tick.
 *
 * COMPOSITION ORDER (all additive, from authored rest values)
 *   rest → locomotion (walk | idle breathe | swim | seated)
 *        → action clip (anticipation → strike → impact → recovery)
 *        → hurt recoil (bodyRoot only)
 *
 * ROTATION CONVENTIONS (Phaser: +rotation = clockwise; local +x = facing)
 *   Limb origins sit at the shoulder/hip, so NEGATIVE rot swings a limb FORWARD
 *   and positive rot swings it back/up.
 *   bodyRoot pivots at the feet, so POSITIVE rot leans the whole body FORWARD.
 *   torso.rotation is deliberately never written. The torso is a *sibling* of
 *   the head/arms/legs, so rotating it shears the character apart — that was the
 *   original "deformed body" bug. Whole-body lean belongs on bodyRoot.
 * ──────────────────────────────────────────────────────────────────────────── */

export function makePartTextures(scene: Phaser.Scene) {
  if (scene.textures.exists('p-body')) return;
  const g = scene.add.graphics();
  const tex = (key: string, w: number, h: number, draw: () => void) => {
    g.clear(); draw(); g.generateTexture(key, w, h);
  };
  tex('p-body', 14, 16, () => { g.fillStyle(0xffffff); g.fillRoundedRect(0, 0, 14, 16, 4); });
  tex('p-head', 14, 14, () => {
    g.fillStyle(0xe8b88a); g.fillCircle(7, 7, 7);
    g.fillStyle(0x5c4a3a); g.fillEllipse(7, 3.5, 14, 7);
    g.fillStyle(0x222222); g.fillCircle(4, 8, 1.3); g.fillCircle(10, 8, 1.3);
  });
  tex('p-arm', 5, 13, () => { g.fillStyle(0xe8b88a); g.fillRoundedRect(0, 0, 5, 13, 2); });
  tex('p-leg', 5, 11, () => { g.fillStyle(0x2b3a4a); g.fillRoundedRect(0, 0, 5, 11, 2); });
  tex('i-axe', 14, 16, () => {
    g.fillStyle(0x8a6238); g.fillRect(5, 2, 3, 14);
    g.fillStyle(0xb8bec8); g.fillRoundedRect(4, 0, 10, 7, 2);
  });
  tex('i-pick', 16, 16, () => {
    g.fillStyle(0x8a6238); g.fillRect(6, 2, 3, 14);
    g.fillStyle(0xb8bec8); g.fillTriangle(0, 4, 16, 4, 8, 0);
  });
  tex('i-spick', 16, 16, () => {
    g.fillStyle(0x8a6238); g.fillRect(6, 2, 3, 14);
    g.fillStyle(0x6a6f78); g.fillTriangle(0, 4, 16, 4, 8, 0);
  });
  tex('i-sword', 8, 20, () => {
    g.fillStyle(0xd8dee8); g.fillTriangle(4, 0, 1, 14, 7, 14);
    g.fillStyle(0x8a6238); g.fillRect(3, 14, 2, 6); g.fillRect(0, 14, 8, 2);
  });
  tex('i-isword', 8, 22, () => {
    g.fillStyle(0x9ad4e8); g.fillTriangle(4, 0, 1, 16, 7, 16);
    g.fillStyle(0x4a5568); g.fillRect(3, 16, 2, 6); g.fillRect(0, 16, 8, 2);
  });
  g.destroy();
}

/* ── tool grip metadata ───────────────────────────────────────────────────────
 * ox/oy are normalised origins placed on the handle grip point, so the tool
 * rotates in the palm instead of orbiting a hardcoded shoulder point.
 * `rest` is the resting rotation inside the hand, `heft` stretches the slow
 * phases of a clip (a stone pick winds up and recovers slower than a sword). */
type Grip = {
  key: string; ox: number; oy: number;
  rest: number; hx: number; hy: number;
  two: boolean; heft: number;
};

export const TOOL_GRIPS: Record<string, Grip> = {
  axe:    { key: 'i-axe',    ox: 6 / 14, oy: 13 / 16, rest: -0.25, hx: 0, hy: 0,  two: false, heft: 1.05 },
  pick:   { key: 'i-pick',   ox: 8 / 16, oy: 14 / 16, rest: -0.15, hx: 0, hy: 0,  two: true,  heft: 1.00 },
  spick:  { key: 'i-spick',  ox: 8 / 16, oy: 14 / 16, rest: -0.15, hx: 0, hy: 0,  two: true,  heft: 1.12 },
  sword:  { key: 'i-sword',  ox: 4 / 8,  oy: 17 / 20, rest: -0.45, hx: 0, hy: -1, two: false, heft: 0.90 },
  isword: { key: 'i-isword', ox: 4 / 8,  oy: 19 / 22, rest: -0.50, hx: 0, hy: -1, two: true,  heft: 1.00 },
};

/* ── action clips ────────────────────────────────────────────────────────────
 * ant/str/imp/rec are the four phase durations in seconds.
 * A single driver `w` runs −1 (full wind-up) → +1 (impact) → 0 (rest); every
 * amplitude below is the value reached at those extremes. */
type Clip = {
  ant: number; str: number; imp: number; rec: number;
  armBack: number; armFwd: number;      // right shoulder
  wristBack: number; wristFwd: number;  // hand/tool lag then catch-up
  leanBack: number; leanFwd: number;    // bodyRoot lean (whole body)
  headBack: number; headFwd: number;    // head follow
  offArm: number;                       // left-arm counter-balance factor
  crouch: number; push: number;         // bodyRoot y / x at impact
  legs: number;                         // foot plant spread
  shake: number;                        // impact micro-shake amplitude
  jump?: boolean;
};

const CLIPS: Record<string, Clip> = {
  // 110 / 100 / 40 / 170
  chop:  { ant: .110, str: .100, imp: .040, rec: .170,
           armBack: 2.10, armFwd: -0.95, wristBack: -0.35, wristFwd: 0.30,
           leanBack: -0.12, leanFwd: 0.17, headBack: -0.10, headFwd: 0.16,
           offArm: 0.50, crouch: 1.6, push: 1.6, legs: 0.18, shake: 0.7 },
  // 150 / 110 / 70 / 190  — heaviest, two-handed overhead
  mine:  { ant: .150, str: .110, imp: .070, rec: .190,
           armBack: 2.45, armFwd: -1.15, wristBack: -0.30, wristFwd: 0.36,
           leanBack: -0.16, leanFwd: 0.21, headBack: -0.12, headFwd: 0.20,
           offArm: 0.35, crouch: 2.6, push: 1.2, legs: 0.26, shake: 1.1 },
  // 60 / 90 / 60 / 150 — fast lateral arc across the front
  slash: { ant: .060, str: .090, imp: .060, rec: .150,
           armBack: 1.15, armFwd: -1.35, wristBack: -0.55, wristFwd: 0.45,
           leanBack: -0.09, leanFwd: 0.13, headBack: -0.06, headFwd: 0.11,
           offArm: 0.60, crouch: 0.5, push: 2.7, legs: 0.13, shake: 0.45 },
  // 60 / 80 / 30 / 90
  punch: { ant: .060, str: .080, imp: .030, rec: .090,
           armBack: 0.75, armFwd: -1.45, wristBack: -0.20, wristFwd: 0.10,
           leanBack: -0.06, leanFwd: 0.11, headBack: -0.05, headFwd: 0.09,
           offArm: 0.55, crouch: 0.5, push: 2.2, legs: 0.10, shake: 0.25 },
  // 140 / 80 / — / 100  (reach → set → release)
  place: { ant: .140, str: .080, imp: .000, rec: .100,
           armBack: 0.15, armFwd: -1.00, wristBack: -0.10, wristFwd: 0.35,
           leanBack: -0.03, leanFwd: 0.16, headBack: -0.02, headFwd: 0.14,
           offArm: 0.30, crouch: 3.0, push: 1.0, legs: 0.20, shake: 0 },
  // 80 / 90 / 180 / 100  (squash → launch → air → land)
  jump:  { ant: .080, str: .090, imp: .180, rec: .100,
           armBack: 0.50, armFwd: -0.90, wristBack: 0, wristFwd: 0,
           leanBack: 0, leanFwd: 0, headBack: 0, headFwd: 0,
           offArm: 0, crouch: 0, push: 0, legs: 0, shake: 0, jump: true },
};

// public action vocabulary; aliases fold onto the clips above
export type ActionName =
  'chop' | 'mine' | 'slash' | 'thrust' | 'punch' | 'collect' | 'place' | 'jump' | 'cast';

const CLIP_ALIAS: Record<string, string> = {
  thrust: 'slash', collect: 'punch', cast: 'place',
};

export type ActionCtx = {
  name: ActionName;
  tool?: string | null;    // omitted = use the held tool; explicit null = empty hand
  dirX?: number;
  dirY?: number;
  intensity?: number;
};

/* ── authored rest transforms (never mutated) ─────────────────────────────── */
const R_LEG_Y = -11, R_LEG_X = 3;
const R_ARM_Y = -24, R_ARM_X = 8;
const R_TORSO_Y = -26, R_HEAD_Y = -30;
const HAND_Y = 11;                       // hand pivot along the 13px upper arm

const HURT_DUR = 0.22, FLASH_DUR = 0.09;
const TAU = Math.PI * 2;

const easeOutSine = (t: number) => Math.sin(t * Math.PI * 0.5);
const easeInCubic = (t: number) => t * t * t;
const easeOutBack = (t: number) => { const u = t - 1; return 1 + 2.70158 * u * u * u + 1.70158 * u * u; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const setVis = (o: Phaser.GameObjects.Components.Visible, v: boolean) => { if (o.visible !== v) o.setVisible(v); };

export class Rig extends Phaser.GameObjects.Container {
  bodyRoot: Phaser.GameObjects.Container;
  armLRoot: Phaser.GameObjects.Container;
  armRRoot: Phaser.GameObjects.Container;
  handR: Phaser.GameObjects.Container;
  legL: Phaser.GameObjects.Image; legR: Phaser.GameObjects.Image;
  armL: Phaser.GameObjects.Image; armR: Phaser.GameObjects.Image;
  torso: Phaser.GameObjects.Image; head: Phaser.GameObjects.Image;
  tool: Phaser.GameObjects.Image;

  // ── public contract fields (main.ts reads/writes these) ──
  phase = 0; moving = false; acting = 0; holdKind: string | null = null; swim = false;
  hurting = false;
  shirt: number;

  // ── locomotion state ──
  private idlePhase = 0;
  private swimPhase = 0;
  private walkW = 0;          // 0..1 blend between idle breathe and walk cycle
  private seated = false;
  private facing = 1;

  // ── action state (single mutable record; no per-frame allocation) ──
  private actOn = false;
  private actT = 0;
  private actDur = 0;
  private antD = 0; private strD = 0; private impD = 0; private recD = 0;
  private cancelAt = 0;
  private actInt = 1;
  private dirTilt = 0;
  private dirPush = 1;
  private clip: Clip | null = null;
  private actTool: string | null = null;

  // ── damage state (pure countdowns — these cannot stick) ──
  private hurtT = 0; private hurtDir = 1;
  private flashT = 0; private flashOn = false;

  // ── equipment state ──
  private toolKind: string | null = null;
  private twoHanded = false;
  private tintParts: Phaser.GameObjects.Image[];

  constructor(scene: Phaser.Scene, x: number, y: number, shirtColor: number) {
    super(scene, x, y);
    this.shirt = shirtColor;
    const mk = (key: string, px: number, py: number, oy = 0) =>
      scene.add.image(px, py, key).setOrigin(0.5, oy);

    this.bodyRoot = scene.add.container(0, 0);
    this.legL = mk('p-leg', -R_LEG_X, R_LEG_Y);
    this.legR = mk('p-leg', R_LEG_X, R_LEG_Y);
    this.armL = mk('p-arm', 0, 0, 0.08);
    this.armR = mk('p-arm', 0, 0, 0.08);
    this.torso = mk('p-body', 0, R_TORSO_Y, 0).setTint(shirtColor);
    this.head = mk('p-head', 0, R_HEAD_Y, 0.9);
    this.tool = mk('i-axe', 0, 0, 0.9).setVisible(false);

    this.armLRoot = scene.add.container(-R_ARM_X, R_ARM_Y, [this.armL]);
    this.handR = scene.add.container(0, HAND_Y, [this.tool]);
    this.armRRoot = scene.add.container(R_ARM_X, R_ARM_Y, [this.armR, this.handR]);

    // draw order: legs, off-arm, torso, head, striking arm (+ tool) on top
    this.bodyRoot.add([this.legL, this.legR, this.armLRoot, this.torso, this.head, this.armRRoot]);
    this.add(this.bodyRoot);
    this.torso.rotation = 0;   // invariant: never written again (see header)
    this.tintParts = [this.torso, this.head, this.armL, this.armR, this.legL, this.legR];
    scene.add.existing(this);
  }

  // ── facing: cheap whole-container flip (unchanged contract) ──
  face(dx: number) {
    if (!dx) return;
    this.facing = dx < 0 ? -1 : 1;
    this.setScale(this.facing, 1);
  }

  // ── equipment ────────────────────────────────────────────────────────────
  hold(kind: string | null) {
    this.holdKind = kind && TOOL_GRIPS[kind] ? kind : null;
    if (!this.actOn) this.attachTool(this.holdKind);
  }

  /** Seats the tool in the hand pivot using its grip metadata. Cheap no-op if unchanged. */
  private attachTool(kind: string | null) {
    if (this.toolKind === kind) return;
    this.toolKind = kind;
    const g = kind ? TOOL_GRIPS[kind] : undefined;
    if (!g) { this.twoHanded = false; this.tool.setVisible(false); return; }
    this.tool.setTexture(g.key).setOrigin(g.ox, g.oy).setPosition(g.hx, g.hy);
    this.tool.rotation = g.rest;
    this.twoHanded = g.two;
  }

  // ── locomotion modes ─────────────────────────────────────────────────────
  setSwim(on: boolean) { this.swim = !!on; }

  /** Seated-in-a-boat pose: legs braced, slight lean, no walk cycle. Unused by default. */
  setSeated(on: boolean) { this.seated = !!on; }

  // ── actions ──────────────────────────────────────────────────────────────
  /** Legacy entry point. kind==null means an explicitly empty hand (guide §2). */
  act(kind: string | null) {
    const name = kind === 'axe' ? 'chop'
      : (kind === 'pick' || kind === 'spick') ? 'mine'
        : (kind === 'sword' || kind === 'isword') ? 'slash'
          : 'punch';
    this.startAction(name, kind ?? null, 0, 0, 1);
  }

  playAction(ctx: ActionCtx) {
    const tool = 'tool' in ctx ? (ctx.tool ?? null) : this.holdKind;
    this.startAction(ctx.name, tool, ctx.dirX ?? 0, ctx.dirY ?? 0, ctx.intensity ?? 1);
  }

  /** Convenience wrapper so main.ts can drive the jump pose from the rig later. */
  playJump(intensity = 1) { this.startAction('jump', this.holdKind, 0, 0, intensity); }

  private startAction(name: string, tool: string | null, dirX: number, dirY: number, intensity: number) {
    // re-entry: only cancel once the strike has landed, so mashing cannot pop
    // the arm back to neutral mid-wind-up (guide §"Runtime Flow").
    if (this.actOn && this.actT < this.cancelAt) return;
    const clip = CLIPS[CLIP_ALIAS[name] ?? name] ?? CLIPS.punch;
    const grip = tool ? TOOL_GRIPS[tool] : undefined;
    const heft = grip ? grip.heft : 1;
    this.clip = clip;
    this.actTool = grip ? tool : null;
    this.antD = clip.ant * heft;
    this.strD = clip.str;
    this.impD = clip.imp;
    this.recD = clip.rec * heft;
    this.actDur = this.antD + this.strD + this.impD + this.recD;
    this.cancelAt = this.antD + this.strD;      // ≤300ms for every clip → no dropped inputs
    this.actT = 0;
    this.actOn = true;
    this.acting = 1;
    this.actInt = intensity > 0 ? intensity : 1;
    // aim the clip: N/S targets tilt the arc, E/W targets widen the lunge
    this.dirTilt = (dirY || 0) * 0.12;
    this.dirPush = dirX ? 1.25 : 1;
    this.attachTool(this.actTool);
  }

  private endAction() {
    this.actOn = false; this.acting = 0; this.actT = 0; this.clip = null;
    this.attachTool(this.holdKind);
  }

  // ── damage ───────────────────────────────────────────────────────────────
  /** Recoil + flash. Pure timers: re-entrant, self-healing, cannot leave a stuck pose. */
  hurt(ang: number) {
    this.flashT = FLASH_DUR;
    if (!this.flashOn) this.setFlash(true);
    // refractory: let the previous flinch recover at least halfway so a 10 hits/s
    // stream reads as repeated flinching instead of a pose pinned at max amplitude.
    if (this.hurtT > HURT_DUR * 0.5) return;
    this.hurtDir = (Math.cos(ang) < 0 ? 1 : -1) * this.facing;
    this.hurtT = HURT_DUR;
    this.hurting = true;
  }

  private setFlash(on: boolean) {
    this.flashOn = on;
    const p = this.tintParts;
    for (let i = 0; i < p.length; i++) {
      if (on) p[i].setTintFill(0xff6666); else p[i].clearTint();
    }
    // p-body is white: clearTint would wipe the shirt colour, so restore it
    if (!on) this.torso.setTint(this.shirt);
  }

  /** Hard reset to rest — safe to call on z-change, teleport, respawn. */
  resetPose() {
    this.actOn = false; this.acting = 0; this.actT = 0; this.clip = null;
    this.hurtT = 0; this.hurting = false;
    this.flashT = 0; if (this.flashOn) this.setFlash(false);
    this.walkW = 0; this.phase = 0; this.idlePhase = 0; this.swimPhase = 0;
    this.attachTool(this.holdKind);
    this.tick(0);
  }

  destroy(fromScene?: boolean) {
    this.actOn = false; this.hurtT = 0; this.flashT = 0; this.clip = null;
    super.destroy(fromScene);
  }

  // ── per-frame pose composer ──────────────────────────────────────────────
  tick(dt: number) {
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;

    // 1. advance every timer. All are countdowns or free-running phases, so no
    //    state can persist once its driver runs out — nothing here can stick.
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.setFlash(false); }
    if (this.hurtT > 0) { this.hurtT -= dt; if (this.hurtT < 0) this.hurtT = 0; }
    this.hurting = this.hurtT > 0;
    if (this.actOn) { this.actT += dt; if (this.actT >= this.actDur) this.endAction(); }
    this.acting = this.actOn ? 1 : 0;

    // 2. sample into plain-number locals (zero allocation).
    let bx = 0, by = 0, brot = 0;
    let lL = 0, lR = 0, aL = 0, aR = 0;
    let armY = 0, torsoY = 0, headY = 0, headX = 0, headRot = 0;
    let wrist = 0, torsoSX = 1, torsoSY = 1;
    let bodyVis = true, armRVis = true;

    // ── locomotion ──
    if (this.swim) {
      this.swimPhase += dt * (this.moving ? 5.71 : 3.49);   // 1.1 s stroke / 1.8 s tread
      if (this.swimPhase > TAU) this.swimPhase -= TAU;
      const sp = this.swimPhase, sc = sp / TAU;
      bodyVis = false;                       // submerged: only the head breaks the surface
      by += 1.4 + Math.sin(sp * 2) * 0.5;
      headY += Math.sin(sp) * 1.3;
      headRot += Math.sin(sp) * 0.10;
      brot += Math.sin(sp) * 0.11;           // torso roll
      if (this.moving) {
        if (sc < 0.25) aR = lerp(0.35, -1.25, sc / 0.25);            // reach
        else if (sc < 0.5) aR = lerp(-1.25, 0.55, (sc - 0.25) / 0.25); // pull
        else aR = lerp(0.55, 0.35, (sc - 0.5) / 0.5);                 // recover
        armRVis = sc < 0.52;                 // the stroking arm surfaces, then dips
        lL = Math.sin(sp * 2) * 0.3; lR = -lL;
      } else {
        aR = Math.sin(sp) * 0.25;            // idle tread-water scull
        armRVis = false;
      }
      this.walkW = 0;
    } else if (this.seated) {
      this.idlePhase += dt * 1.7;
      if (this.idlePhase > TAU) this.idlePhase -= TAU;
      const br = Math.sin(this.idlePhase);
      by += 3 + br * 0.5;
      brot += 0.05 + br * 0.012;
      lL = -1.05 + br * 0.03; lR = -0.85 - br * 0.03;   // knees up, feet braced forward
      aL = -0.25; aR = -0.20;
      headY += br * 0.3;
      this.walkW = 0;
    } else {
      const target = this.moving ? 1 : 0;
      this.walkW += (target - this.walkW) * Math.min(1, dt / 0.10);
      if (this.walkW > 0.001) {
        this.phase += dt * 11;
        if (this.phase > TAU) this.phase -= TAU;
        const s = Math.sin(this.phase), w = this.walkW;
        lL = s * 0.55 * w; lR = -s * 0.55 * w;
        aL = -s * 0.4 * w; aR = s * 0.4 * w;
        const bob = -Math.abs(Math.cos(this.phase)) * 1.5 * w;
        torsoY += bob; headY += bob; armY += bob;
        brot += 0.02 * w;
      }
      const iw = 1 - this.walkW;
      if (iw > 0.001) {
        this.idlePhase += dt * 2.1;
        if (this.idlePhase > TAU) this.idlePhase -= TAU;
        const br = Math.sin(this.idlePhase) * iw;
        torsoY += br * 0.35; headY += br * 0.55; armY += br * 0.35;
        aL += br * 0.035; aR -= br * 0.035;
        torsoSY = 1 - br * 0.012;
        if (this.twoHanded) aL -= 0.85 * iw;   // off hand rests on a two-handed haft
      }
    }

    // ── action clip ──
    if (this.actOn && this.clip) {
      const c = this.clip, k = this.actInt, t = this.actT;
      const a = this.antD, s = this.strD, i = this.impD, r = this.recD;
      let w: number, ph: number;
      if (t < a) { w = -easeOutSine(a > 0 ? t / a : 1); ph = 0; }
      else if (t < a + s) { w = -1 + 2 * easeInCubic(s > 0 ? (t - a) / s : 1); ph = 1; }
      else if (t < a + s + i) { w = 1; ph = 2; }
      else { w = 1 - easeOutBack(r > 0 ? clamp01((t - a - s - i) / r) : 1); ph = 3; }

      if (c.jump) {
        const hop = 18 * k;
        if (ph === 0) {                                   // squash
          const q = a > 0 ? t / a : 1;
          by += 3.5 * q; lL = -0.10 * q; lR = 0.10 * q; aL = 0.5 * q; aR = 0.5 * q;
          torsoSY = 1 - 0.10 * q;
        } else if (ph === 1) {                            // launch
          const q = s > 0 ? (t - a) / s : 1;
          by += 3.5 * (1 - q) - hop * easeOutSine(q);
          lL = 0; lR = 0; aL = -0.9 * q; aR = -0.9 * q; torsoSY = 1 + 0.05 * q;
        } else if (ph === 2) {                            // air
          const q = i > 0 ? (t - a - s) / i : 1;
          by -= hop * (0.92 + 0.08 * Math.cos(q * Math.PI));
          lL = -0.35; lR = -0.50; aL = -0.7; aR = -0.7;
        } else {                                          // land
          const q = r > 0 ? clamp01((t - a - s - i) / r) : 1;
          const fall = easeInCubic(q);
          by += -hop * (1 - fall) + 4 * Math.sin(Math.PI * q) * fall;
          lL = 0.12 * (1 - q); lR = -0.12 * (1 - q);
          aL = 0.3 * (1 - q); aR = 0.3 * (1 - q);
          torsoSY = 1 - 0.08 * (1 - q);
        }
        armRVis = true;
      } else {
        const fw = w > 0 ? w : 0, bw = w < 0 ? -w : 0, amp = fw + bw;
        aR = (bw * c.armBack + fw * c.armFwd) * k;
        wrist = (bw * c.wristBack + fw * c.wristFwd) * k;
        brot += (bw * c.leanBack + fw * c.leanFwd) * k + this.dirTilt * fw;
        headRot += (bw * c.headBack + fw * c.headFwd) * k;
        headX += fw * 0.8 * k;
        by += fw * c.crouch * k;
        bx += fw * c.push * k * this.dirPush;
        // feet plant: locomotion keeps some influence so walking still reads
        lL = lL * (1 - 0.6 * amp) - c.legs * amp * k;
        lR = lR * (1 - 0.6 * amp) + c.legs * 0.6 * amp * k;
        // off arm: two-handed grip follows the haft, one-handed counter-balances
        aL = this.twoHanded ? (aR * 0.78 - 0.22 * amp * k) : (-aR * c.offArm);
        torsoSX = 1 - 0.06 * fw * k;
        torsoSY = 1 + 0.05 * fw * k;
        if (ph === 2 && c.shake) bx += Math.sin(t * 260) * c.shake * k;
        armRVis = true;
      }
    }

    // ── hurt recoil: whole body, applied to bodyRoot only ──
    if (this.hurtT > 0) {
      const e = this.hurtT / HURT_DUR, e2 = e * e;
      const d = this.hurtDir;
      brot += -0.17 * d * e2;
      bx += -2.6 * d * e2;
      by += 1.1 * e2;
      headRot += -0.16 * d * e2;
      aL += 0.30 * d * e2; aR += 0.30 * d * e2;
    }

    // 3. apply every transform exactly once.
    if (this.actOn) armRVis = true;
    setVis(this.legL, bodyVis); setVis(this.legR, bodyVis);
    setVis(this.armLRoot, bodyVis); setVis(this.torso, bodyVis);
    setVis(this.armRRoot, armRVis);
    setVis(this.tool, this.toolKind !== null && armRVis && (!this.swim || this.actOn));

    this.bodyRoot.x = bx; this.bodyRoot.y = by; this.bodyRoot.rotation = brot;
    this.legL.rotation = lL; this.legR.rotation = lR;
    this.armLRoot.rotation = aL; this.armLRoot.y = R_ARM_Y + armY;
    this.armRRoot.rotation = aR; this.armRRoot.y = R_ARM_Y + armY;
    this.handR.rotation = wrist;
    this.torso.y = R_TORSO_Y + torsoY; this.torso.scaleX = torsoSX; this.torso.scaleY = torsoSY;
    this.head.x = headX; this.head.y = R_HEAD_Y + headY; this.head.rotation = headRot;
  }
}
