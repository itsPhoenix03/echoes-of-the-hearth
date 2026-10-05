import Phaser from 'phaser';
import { HUMAN_CLIPS, humanFrame } from './assets.ts';
import { SHIRT_HEX, ensureSkin, skinId, skinKey, type Cloak } from './keeperSkins.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * POSE MODEL — read this before touching anything below.
 *
 * The keeper is hand-drawn frame art (human-grounded-natural-synced pack):
 * one base pose `keeper` plus `keeper_<clip>_01..NN` clips with the held prop
 * already drawn into the hand (walk and the per-tool swings are derived by
 * tools/art/keeper-frames.mjs). Shirt colour and worn cloak are skins baked by
 * keeperSkins.ts; every frame name below is resolved through the active skin.
 *
 * Hierarchy
 *   Rig (Container)          main.ts owns x / y / depth / setScale(±1) facing.
 *                            The rig itself NEVER writes its own x/y.
 *   ├ hull (Image)           boat, only while boating (setBoat) — behind the keeper
 *   ├ shadow (Ellipse)       ground shadow shown only mid-jump: the jump frames
 *   │                        have no drawn shadow, and this one stays on the
 *   │                        ground while bodyRoot rises.
 *   ├ bodyRoot (Container)   rig-owned visual root, pivot at the feet (0,0).
 *   │  └ spr (Image)         current frame; origin on the drawn ground shadow.
 *   │                        Hop, hurt recoil, impact push and walk bob all live
 *   │                        on bodyRoot so they cannot fight world lerping.
 *   └ hullFront (Image)      the boat's near gunwale, over the keeper's lap, so
 *                            they sit IN the boat. Hull, front and keeper share
 *                            one bob/roll clock, so they can never drift apart.
 *
 * ONE WRITER RULE
 *   tick(dt) is the only thing that writes transforms or textures. No tweens,
 *   no timers, no Phaser anims in this file. Every clip is a scalar timer
 *   advanced by dt and sampled into a frame index, applied once per tick.
 *   An interrupted anything converges back to rest on the next tick.
 *
 * TEXTURE PRIORITY (first match wins)
 *   action clip → swim loop → boat (row loop / resting) → walk loop → status loop (cold/hot/injured) → base
 * ──────────────────────────────────────────────────────────────────────────── */

/** Kept for the create() call site; the keeper is SVG art now, nothing to generate. */
export function makePartTextures(_scene: Phaser.Scene) {}

const KEEPER_FRAMES: Record<string, string[]> = {};
const ALL_FRAMES = ['keeper'];
for (const [c, a, n] of HUMAN_CLIPS) {
  if (c !== 'keeper') continue;
  KEEPER_FRAMES[a] = Array.from({ length: n }, (_, i) => humanFrame(c, a, i + 1));
  ALL_FRAMES.push(...KEEPER_FRAMES[a]);
}

/** Heavier tools wind up and recover slower (stretches the whole clip). */
const TOOL_HEFT: Record<string, number> = { axe: 1.05, pick: 1.0, spick: 1.12, sword: 0.9, isword: 1.0 };

/* ── action clips ────────────────────────────────────────────────────────────
 * dur     total seconds (× tool heft); frames are spread evenly across it.
 * cancel  re-entry gate: a new action can only interrupt after this point, so
 *         mashing cannot restart the swing mid wind-up (≤300ms → no dropped input).
 * push/crouch/shake  bodyRoot impact accents on top of the drawn motion. */
type Clip = { anim: string; tools?: Record<string, string>; dur: number; cancel: number; push: number; crouch: number; shake: number; jump?: boolean };

const CLIPS: Record<string, Clip> = {
  chop:    { anim: 'chop', dur: .50, cancel: .24, push: .8, crouch: .4, shake: .6 },
  mine:    { anim: 'mine', tools: { spick: 'spick' }, dur: .60, cancel: .28, push: .5, crouch: .6, shake: 1.0 },
  slash:   { anim: 'slash', tools: { isword: 'islash' }, dur: .42, cancel: .16, push: 2.2, crouch: .4, shake: .45 },
  punch:   { anim: 'punch', dur: .32, cancel: .14, push: 1.6, crouch: .2, shake: .25 },
  collect: { anim: 'pickup', dur: .55, cancel: .24, push: 0, crouch: 0, shake: 0 },
  place: { anim: 'build',   dur: .46, cancel: .22, push: .6,  crouch: 1.4, shake: 0 },
  torch:   { anim: 'torch', dur: .80, cancel: .80, push: 0, crouch: 0, shake: 0 },
  meds:  { anim: 'meds',    dur: .80, cancel: .80, push: 0,   crouch: 0,   shake: 0 },
  jump:  { anim: 'jump',    dur: .45, cancel: .17, push: 0,   crouch: 0,   shake: 0, jump: true },
};

// public action vocabulary; aliases fold onto the clips above
export type ActionName =
  'chop' | 'mine' | 'slash' | 'thrust' | 'punch' | 'collect' | 'place' | 'jump' | 'cast' | 'meds' | 'torch';

const CLIP_ALIAS: Record<string, string> = {
  thrust: 'slash', cast: 'place',
};

export type ActionCtx = {
  name: ActionName;
  tool?: string | null;    // omitted = use the held tool; explicit null = empty hand
  dirX?: number;
  dirY?: number;
  intensity?: number;
};

/** Ambient condition loops, chosen by main.ts from biome / gear / hp. */
export type RigStatus = 'cold' | 'hot' | 'injured' | null;

// seconds per frame for the looping clips
const LOOP_SPF: Record<string, number> = { shiver: .07, sweat: .10, injured: .12, walk: .095 };
const SWIM_SPF_MOVE = .075, SWIM_SPF_IDLE = .11;
const STATUS_CLIP: Record<string, string> = { cold: 'shiver', hot: 'sweat', injured: 'injured' };

// Boat: hull origin (.5,.6) sits 4px below the rig origin (as main.ts always placed it);
// the seated keeper drops so the frame's hip line (y 34) meets the boat floor.
const BOAT_Y = 4, BOAT_SEAT = 16.5, BOAT_BOB = 3, ROW_SPF = .1;
const FEET_OY = 45.5 / 48;              // drawn ground shadow centre in the 32×48 canvas
// In water, everything below the waist shows through the surface at the same
// strength the swim clip's baked mask uses (#6e6e6e ≈ .43). The swim frames
// carry it themselves; any other clip played while swimming (an attack, a
// gather) gets it here, by drawing the frame twice: top crisp, bottom faded.
const WAIST_Y = 34;                      // waterline row in the 48px-tall frames
const UNDERWATER_A = 0.43;
// Jump shapes: frame start times (fraction of the clip), the airborne window and
// peak height. Standing: a real crouch before, a tall hop. Running: the stride
// carries straight into a lower, longer leap with no wind-up.
type JumpShape = { at: number[]; up: number; down: number; height: number };
const JUMPS: Record<string, JumpShape> = {
  jump: { at: [0, .16, .28, .44, .6, .76, .9], up: .16, down: .76, height: 20 },
  leap: { at: [0, .08, .22, .4, .58, .78, .9], up: .06, down: .8, height: 15 },
};
const HURT_DUR = 0.22, FLASH_DUR = 0.09;
const TAU = Math.PI * 2;

const easeOutSine = (t: number) => Math.sin(t * Math.PI * 0.5);
const easeInCubic = (t: number) => t * t * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

export class Rig extends Phaser.GameObjects.Container {
  bodyRoot: Phaser.GameObjects.Container;
  spr: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Ellipse;
  private sprLow: Phaser.GameObjects.Image;      // the faded below-water half (wet only)
  private waterline: Phaser.GameObjects.Graphics;
  private wet = false;

  // ── public contract fields (main.ts reads/writes these) ──
  phase = 0; moving = false; acting = 0; holdKind: string | null = null; swim = false;
  hurting = false;
  shirt: number;

  // ── locomotion / ambient state ──
  private idlePhase = 0;
  private walkW = 0;          // 0..1 blend between idle breathe and walk bob
  private loopT = 0;          // free-running clock for looping clips
  private seated = false;
  private boatKind = 0;
  private boatT = Math.random() * 10;          // per-rig phase so a fleet doesn't bob in lockstep
  private hull: Phaser.GameObjects.Image | null = null;
  private hullFront: Phaser.GameObjects.Image | null = null;
  private facing = 1;
  private status: RigStatus = null;
  private tex = '';
  private shirtIdx: number;
  private cloak: Cloak = null;
  private armor = false;
  private skin = '0';           // active skin id once its textures exist
  private actAnim = '';

  // ── action state (single mutable record; no per-frame allocation) ──
  private actOn = false;
  private actT = 0;
  private actDur = 0;
  private cancelAt = 0;
  private actInt = 1;
  private dirPush = 1;
  private clip: Clip | null = null;

  // ── damage state (pure countdowns — these cannot stick) ──
  private hurtT = 0; private hurtDir = 1;
  private flashT = 0; private flashOn = false;

  /** `shirt` is a keeperSkins.SHIRTS palette index (see shirtFor). */
  constructor(scene: Phaser.Scene, x: number, y: number, shirt: number) {
    super(scene, x, y);
    this.shirtIdx = shirt;
    this.shirt = SHIRT_HEX[shirt] ?? SHIRT_HEX[0];
    this.shadow = scene.add.ellipse(0, -2.5, 20, 4, 0x16151a, 0.25).setVisible(false);
    this.spr = scene.add.image(0, 0, 'keeper').setOrigin(0.5, FEET_OY);
    this.tex = 'keeper';
    this.sprLow = scene.add.image(0, 0, 'keeper').setOrigin(0.5, FEET_OY).setAlpha(UNDERWATER_A).setVisible(false);
    // the swim art's waterline (M5 34.2 Q… T27 34.2), in sprite-local space
    const wl = scene.add.graphics().setVisible(false);
    wl.lineStyle(0.7, 0xe3f6ff, 0.75).beginPath();
    for (let i = 0; i <= 22; i++) {
      const x = -11 + i, y = WAIST_Y + 0.2 - 45.5 - Math.sin((i / 11) * Math.PI) * 0.65;
      if (i === 0) wl.moveTo(x, y); else wl.lineTo(x, y);
    }
    wl.strokePath();
    this.waterline = wl;
    this.bodyRoot = scene.add.container(0, 0, [this.spr, this.sprLow, wl]);
    this.add([this.shadow, this.bodyRoot]);
    scene.add.existing(this);
  }

  // ── facing: cheap whole-container flip (unchanged contract) ──
  face(dx: number) {
    if (!dx) return;
    this.facing = dx < 0 ? -1 : 1;
    this.setScale(this.facing, 1);
  }

  // ── equipment: the clips draw their own prop; the held kind only sets heft ──
  hold(kind: string | null) {
    this.holdKind = kind && TOOL_HEFT[kind] ? kind : null;
  }

  // ── locomotion modes ─────────────────────────────────────────────────────
  setSwim(on: boolean) { this.swim = !!on; }

  /** Boating: 0 = none, 1 = wooden, 2 = reinforced (ice-blue). The rig draws the hull itself. */
  setBoat(kind: number) {
    kind = kind | 0;
    if (kind === this.boatKind) return;
    this.boatKind = kind;
    this.seated = kind > 0;
    if (!kind) {
      this.hull?.destroy(); this.hullFront?.destroy();
      this.hull = this.hullFront = null;
      return;
    }
    if (!this.hull) {
      this.hull = this.scene.add.image(0, BOAT_Y, 'boat').setOrigin(0.5, 0.6);
      this.hullFront = this.scene.add.image(0, BOAT_Y, 'boat_front').setOrigin(0.5, 0.6);
      this.addAt(this.hull, 0);
      this.add(this.hullFront);
    }
    for (const h of [this.hull, this.hullFront!]) {
      if (kind === 2) h.setTint(0x9ad4e8); else h.clearTint();
    }
  }

  /** Ambient condition loop shown when standing (not over actions/swim/boat/walk). */
  setStatus(s: RigStatus) { this.status = s; }

  /** Worn cloak drape; anything but the two cloaks means none. */
  setCloak(k: string | null | undefined) {
    this.cloak = k === 'furcloak' || k === 'heatcloak' ? k : null;
  }

  /** Starmetal Armor breastplate, worn under any cloak. */
  setArmor(on: boolean | undefined) { this.armor = !!on; }

  // ── actions ──────────────────────────────────────────────────────────────
  /** Legacy entry point. kind==null means an explicitly empty hand (guide §2). */
  act(kind: string | null) {
    const name = kind === 'axe' ? 'chop'
      : (kind === 'pick' || kind === 'spick') ? 'mine'
        : (kind === 'sword' || kind === 'isword') ? 'slash'
          : 'punch';
    this.startAction(name, kind ?? null, 0, 1);
  }

  playAction(ctx: ActionCtx) {
    const tool = 'tool' in ctx ? (ctx.tool ?? null) : this.holdKind;
    this.startAction(ctx.name, tool, ctx.dirX ?? 0, ctx.intensity ?? 1);
  }

  /** Jump clip: drawn crouch/launch/tuck/land frames plus the hop itself (on bodyRoot). */
  playJump(intensity = 1) { this.startAction('jump', this.holdKind, 0, intensity); }

  private startAction(name: string, tool: string | null, dirX: number, intensity: number) {
    // a jump always wins: main.ts already committed to it (ledge climbing keys off it)
    if (this.actOn && this.actT < this.cancelAt && name !== 'jump') return;
    const clip = CLIPS[CLIP_ALIAS[name] ?? name] ?? CLIPS.punch;
    const heft = (tool && TOOL_HEFT[tool]) || 1;
    this.clip = clip;
    this.actAnim = clip.jump
      ? (this.moving && !this.swim && !this.seated ? 'leap' : 'jump')   // running vs standing jump
      : (tool && clip.tools?.[tool]) || clip.anim;
    this.actDur = clip.dur * heft;
    this.cancelAt = clip.cancel * heft;
    this.actT = 0;
    this.actOn = true;
    this.acting = 1;
    this.actInt = intensity > 0 ? intensity : 1;
    this.dirPush = dirX ? 1.25 : 1;
  }

  private endAction() {
    this.actOn = false; this.acting = 0; this.actT = 0; this.clip = null;
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
    if (on) { this.spr.setTintFill(0xff6666); this.sprLow.setTintFill(0xff6666); }
    else { this.spr.clearTint(); this.sprLow.clearTint(); }
  }

  /** Hard reset to rest — safe to call on z-change, teleport, respawn. */
  resetPose() {
    this.endAction();
    this.hurtT = 0; this.hurting = false;
    this.flashT = 0; if (this.flashOn) this.setFlash(false);
    this.walkW = 0; this.phase = 0; this.idlePhase = 0; this.loopT = 0;
    this.tick(0);
  }

  /** Current hull bob (px) — main.ts places the boat wake from it. */
  get boatBob() { return this.hull ? this.hull.y - BOAT_Y : 0; }

  destroy(fromScene?: boolean) {
    this.actOn = false; this.hurtT = 0; this.flashT = 0; this.clip = null;
    super.destroy(fromScene);
  }

  private loopFrame(clip: string, spf: number) {
    const f = KEEPER_FRAMES[clip];
    return f[Math.floor(this.loopT / spf) % f.length];
  }

  // ── per-frame composer ───────────────────────────────────────────────────
  tick(dt: number) {
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;

    // 1. advance every timer — all countdowns or free-running phases.
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.setFlash(false); }
    if (this.hurtT > 0) { this.hurtT -= dt; if (this.hurtT < 0) this.hurtT = 0; }
    this.hurting = this.hurtT > 0;
    if (this.actOn) { this.actT += dt; if (this.actT >= this.actDur) this.endAction(); }
    this.acting = this.actOn ? 1 : 0;
    this.loopT += dt; if (this.loopT > 3600) this.loopT = 0;
    // skin: switch only once the whole frame set is baked, so clips never mix skins
    const want = skinId(this.shirtIdx, this.cloak, this.armor);
    if (want !== this.skin && ensureSkin(this.scene, ALL_FRAMES, this.shirtIdx, this.cloak, this.armor)) this.skin = want;

    // 2. sample into plain-number locals (zero allocation).
    let bx = 0, by = 0, brot = 0, sy = 1, lift = 0;
    let tex = 'keeper';

    // ── ambient texture: swim > seated > status > base ──
    if (this.swim) {
      tex = this.loopFrame('swim', this.moving ? SWIM_SPF_MOVE : SWIM_SPF_IDLE);
      this.walkW = 0;
    } else if (this.seated) {
      // row while moving; otherwise rest with the paddle lifted out, breathing
      const row = KEEPER_FRAMES.row;
      tex = this.moving ? this.loopFrame('row', ROW_SPF) : row[4];
      if (!this.moving) {
        this.idlePhase += dt * 1.7;
        if (this.idlePhase > TAU) this.idlePhase -= TAU;
        sy = 1 - Math.sin(this.idlePhase) * 0.012;
      }
      this.walkW = 0;
    } else {
      const st = this.status && STATUS_CLIP[this.status];
      if (this.moving) tex = this.loopFrame('walk', LOOP_SPF.walk);
      else if (st) tex = this.loopFrame(st, LOOP_SPF[st]);
      // the walk clip carries the stride; add only a light step lift on top
      const target = this.moving ? 1 : 0;
      this.walkW += (target - this.walkW) * Math.min(1, dt / 0.10);
      if (this.walkW > 0.001) {
        this.phase += dt * 11;
        if (this.phase > TAU) this.phase -= TAU;
        by -= Math.abs(Math.sin(this.phase)) * 0.8 * this.walkW;
      }
      const iw = 1 - this.walkW;
      if (iw > 0.001) {
        this.idlePhase += dt * 2.1;
        if (this.idlePhase > TAU) this.idlePhase -= TAU;
        sy = 1 - Math.sin(this.idlePhase) * 0.012 * iw;
      }
    }

    // ── action clip ──
    if (this.actOn && this.clip) {
      const c = this.clip, k = this.actInt, p = clamp01(this.actDur > 0 ? this.actT / this.actDur : 1);
      if (c.jump) {
        const J = JUMPS[this.actAnim] ?? JUMPS.jump;
        const f = KEEPER_FRAMES[this.actAnim] ?? KEEPER_FRAMES.jump;
        let i = 0;
        while (i < f.length - 1 && p >= J.at[i + 1]) i++;
        tex = f[i];
        // airborne between launch and land: fast rise, hang, then a heavier fall
        if (p > J.up && p < J.down) {
          const q = (p - J.up) / (J.down - J.up);
          lift = J.height * k * (q < .45 ? easeOutSine(q / .45) : 1 - easeInCubic((q - .45) / .55));
          by -= lift;
        }
      } else {
        const f = KEEPER_FRAMES[this.actAnim];
        tex = f[Math.min(f.length - 1, Math.floor(p * f.length))];
        // impact accent peaks mid-clip, where the drawn strike lands
        const env = Math.sin(Math.PI * p);
        bx += env * c.push * k * this.dirPush;
        by += env * c.crouch * k;
        if (c.shake && p > .45 && p < .6) bx += Math.sin(this.actT * 260) * c.shake * k;
      }
    }

    // ── hurt recoil: whole body, bodyRoot only ──
    if (this.hurtT > 0) {
      const e = this.hurtT / HURT_DUR, e2 = e * e, d = this.hurtDir;
      brot += -0.17 * d * e2;
      bx += -2.6 * d * e2;
      by += 1.1 * e2;
    }

    // 3. apply exactly once.
    // in water, any frame but the swim loop's own gets the underwater split
    const wet = this.swim && !tex.startsWith('keeper_swim');
    tex = skinKey(tex, this.skin);
    if (tex !== this.tex || wet !== this.wet) {
      if (tex !== this.tex) this.spr.setTexture(tex);
      if (wet) {
        const f = this.spr.frame, w = f.realWidth, h = f.realHeight, cut = Math.round((h * WAIST_Y) / 48);
        this.spr.setCrop(0, 0, w, cut);
        this.sprLow.setTexture(tex).setCrop(0, cut, w, h - cut);
      } else if (this.wet) this.spr.setCrop();
      this.sprLow.setVisible(wet);
      this.waterline.setVisible(wet);
      this.tex = tex;
      this.wet = wet;
    }
    const jumping = this.actOn && !!this.clip?.jump;
    if (this.shadow.visible !== jumping) this.shadow.setVisible(jumping);
    if (jumping) this.shadow.setScale(1 - lift / 40).setAlpha(1 - lift / 30);
    if (this.hull) {
      // hull bob + gentle roll; the keeper rides the same values
      this.boatT += dt;
      const bob = Math.sin(this.boatT * 3.2) * BOAT_BOB, roll = Math.sin(this.boatT * 2.1) * 0.025;
      this.hull.y = this.hullFront!.y = BOAT_Y + bob;
      this.hull.rotation = this.hullFront!.rotation = roll;
      by += BOAT_SEAT + bob;
      brot += roll;
    }
    this.bodyRoot.x = bx; this.bodyRoot.y = by; this.bodyRoot.rotation = brot;
    this.spr.scaleY = sy;
    if (this.wet) this.sprLow.scaleY = sy;
  }
}
