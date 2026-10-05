import Phaser from "phaser";
import { enemyFrame } from "./assets.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Creature gait — walking and sprinting for every enemy type.
 *
 * Each enemy has a three-frame motion set from the enemies pack (crawl, prowl,
 * lunge, swim, charge, pulse), played as a 1-2-3-2 stride. On top of the frames,
 * a procedural body layer gives each family its own way of moving:
 *
 *   crawl  (crawler, bog shambler)  low scuttle; at a sprint the body drops,
 *                                   leans in and kicks up dust
 *   gallop (stalker, husk wolf)     slinking prowl at a walk; a bounding gallop
 *                                   at a sprint — stretch in the air, gather on
 *                                   landing, nose up and down, dust at touchdown
 *   stomp  (brute)                  heavy footfalls with dust, swaying; leans
 *                                   into a charge
 *   swim   (drowned)                waddle on land, bob and glide in water
 *   sway   (blight lancer)          slow ponderous sway with its charge glow
 *   hover  (wisp, frost wraith)     floats, tilts into its travel, leaves a
 *                                   fading trail when it darts
 *
 * Walk vs sprint comes from the creature's real ground speed, measured from
 * the server's `cre` updates (spd, tiles/s) against the type's full hunting
 * speed. Idle amble (creature_ai.go: 40%) reads as a walk; a hunt at full speed,
 * a stalker's dart, an enraged charge read as a sprint, with a smooth blend.
 * Facing follows the travel, or turns to the keeper when close and still.
 * Purely cosmetic and client-local, like the leap layer that runs after it.
 * ──────────────────────────────────────────────────────────────────────────── */

type Style = "crawl" | "gallop" | "stomp" | "swim" | "sway" | "hover";

type Gait = {
  tex: string;      // base texture (and motion set) key
  style: Style;
  walkFps: number;  // stride frame rate at a walk
  sprintFps: number;// ... and at a full sprint
  tps: number;      // full hunting speed, tiles/s (server speed × 5 ticks/s)
};

export const CRE_GAIT: Record<string, Gait> = {
  crawler:       { tex: "creature",      style: "crawl",  walkFps: 8,   sprintFps: 18,  tps: 2.2 },
  bog_shambler:  { tex: "bog_shambler",  style: "crawl",  walkFps: 4,   sprintFps: 7,   tps: 1.1 },
  stalker:       { tex: "stalker",       style: "gallop", walkFps: 6,   sprintFps: 15,  tps: 3.4 },
  husk_wolf:     { tex: "husk_wolf",     style: "gallop", walkFps: 6.5, sprintFps: 14,  tps: 3.1 },
  brute:         { tex: "brute",         style: "stomp",  walkFps: 3.6, sprintFps: 6.5, tps: 1.5 },
  drowned:       { tex: "drowned",       style: "swim",   walkFps: 6,   sprintFps: 12,  tps: 2.0 },
  blight_lancer: { tex: "blight_lancer", style: "sway",   walkFps: 3,   sprintFps: 4.5, tps: 0.65 },
  wisp:          { tex: "wisp",          style: "hover",  walkFps: 5,   sprintFps: 9,   tps: 1.0 },
  frost_wraith:  { tex: "frost_wraith",  style: "hover",  walkFps: 5,   sprintFps: 10,  tps: 2.5 },
};

const PING = [1, 2, 3, 2];
const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** What the gait needs from the scene. */
export interface GaitHost {
  spawnDust(x: number, y: number): void;
  add: Phaser.GameObjects.GameObjectFactory;
  tweens: Phaser.Tweens.TweenManager;
}

/**
 * Record one server position update: smoothed ground speed and the facing it
 * implies. Call from the `cre` handler BEFORE the sprite's cx/cy are replaced.
 */
export function sampleCreature(s: Phaser.GameObjects.Sprite, x: number, y: number, now: number) {
  const lt: number | undefined = s.getData("sT");
  const px: number | undefined = s.getData("cx"), py: number | undefined = s.getData("cy");
  if (lt !== undefined && px !== undefined && py !== undefined) {
    const dts = (now - lt) / 1000;
    if (dts > 0.03) {
      const dx = x - px, dy = y - py;
      const inst = Math.hypot(dx, dy) / dts;
      // a jump of many tiles is a respawn / knockback, not running
      if (inst < 15) s.setData("spd", (s.getData("spd") ?? 0) * 0.4 + inst * 0.6);
      // screen-space horizontal travel is (dx - dy) in the iso projection
      const sdx = dx - dy;
      if (Math.abs(sdx) > 0.03) s.setData("gFace", sdx < 0 ? -1 : 1);
    }
  }
  s.setData("sT", now);
}

/**
 * Per frame. Sets texture, scale, rotation, facing and the lift/hover offset
 * (as `gHoverY`, which the caller adds to the sprite's y).
 */
export function tickCreatureGait(
  host: GaitHost,
  s: Phaser.GameObjects.Sprite,
  type: string,
  dt: number,
  near: boolean,
  meX: number,
  inWater: boolean,
) {
  const g = CRE_GAIT[type] ?? CRE_GAIT.crawler;
  const base: number = s.getData("gBase") ?? 1;
  const spd: number = s.getData("spd") ?? 0;

  // walk weight M (moving at all) and sprint weight S, eased so gaits blend
  const mT = clamp01((spd - 0.12) / (g.tps * 0.2));
  const sT = clamp01((spd / g.tps - 0.62) / 0.3);
  let M: number = s.getData("gM") ?? 0, S: number = s.getData("gS") ?? 0;
  M += (mT - M) * Math.min(1, dt * 8);
  S += (sT - S) * Math.min(1, dt * 5);
  s.setData("gM", M).setData("gS", S);

  // facing: travel direction; when close and holding still, the keeper
  let face: number = s.getData("gFace") ?? 1;
  if (near && M < 0.3 && Math.abs(meX - s.x) > 6) face = meX < s.x ? -1 : 1;
  s.setData("gFace", face);
  s.setFlipX(face < 0);
  const dir = face;

  // stride clock: frames advance with speed; one cycle = 4 frames = 2 footfalls
  let phase: number = s.getData("gPhase") ?? 0;
  const fps = g.style === "hover"
    ? g.walkFps + (g.sprintFps - g.walkFps) * S
    : (g.walkFps + (g.sprintFps - g.walkFps) * S) * M;
  phase += dt * fps;
  if (phase > 4000) phase -= 4000;
  s.setData("gPhase", phase);
  const a = (phase / 4) * TAU;

  // texture: the base art at rest, the motion set when moving
  const moving = g.style === "hover" || M > 0.06;
  const key = moving ? enemyFrame(g.tex, PING[Math.floor(phase) % 4]) : g.tex;
  if (s.texture.key !== key && s.scene.textures.exists(key)) s.setTexture(key);

  let sx = 1, sy = 1, rot = 0, lift = 0, hover = 0;
  const idle = 1 - M;
  const clock: number = (s.getData("gClock") ?? Math.random() * 10) + dt;
  s.setData("gClock", clock);
  const breathe = Math.sin(clock * 2.2) * 0.015 * idle;

  // footfall detector: fires once each time `beat` dips through ~0
  const footfall = (beat: number, fx: number, fy: number) => {
    const down = beat < 0.15 ? 1 : 0;
    if (down && !s.getData("gFoot")) host.spawnDust(fx, fy);
    s.setData("gFoot", down);
  };

  switch (g.style) {
    case "crawl": {
      const step = Math.sin(2 * a);
      sx = 1 + M * (0.025 + 0.04 * S) * step;
      sy = 1 - M * (0.04 + 0.05 * S) * step - S * 0.06 + breathe;
      rot = dir * S * 0.08 + M * (1 - S) * 0.035 * Math.sin(a);
      lift = M * (0.4 + 1.4 * S) * Math.abs(step);
      if (S > 0.4) footfall(Math.abs(Math.sin(a)), s.x - dir * 7, s.y);
      break;
    }
    case "gallop": {
      const b = Math.sin(a);
      const W = M * (1 - S);
      // prowl: smooth, low, slinking
      sx = 1 + W * 0.02 * b;
      sy = 1 - W * 0.035 * Math.abs(b) + breathe;
      lift = W * 0.6 * Math.abs(b);
      rot = W * 0.02 * Math.sin(2 * a) * dir;
      // gallop: airborne half stretched, gather half bunched, pitching
      sx += S * 0.1 * b;
      sy -= S * 0.08 * b;
      lift += S * 3.2 * Math.max(0, b);
      rot += -dir * S * 0.11 * Math.cos(a);
      if (near && S < 0.5) sy *= 0.9; // stalking crouch
      if (S > 0.4) {
        // touchdown: the bound's airborne half ends
        const air = b > 0 ? 1 : 0;
        if (!air && s.getData("gAir")) host.spawnDust(s.x - dir * 8, s.y);
        s.setData("gAir", air);
      }
      break;
    }
    case "stomp": {
      const beat = Math.abs(Math.sin(a));
      sx = 1 + (1 - beat) * (0.04 + 0.04 * S) * M;
      sy = 1 - (1 - beat) * (0.08 + 0.06 * S) * M + breathe;
      lift = M * beat * (1 + 1.8 * S);
      rot = M * 0.045 * Math.sin(a) + dir * S * 0.09;
      if (M > 0.3) {
        footfall(beat, s.x + Math.sin(a) * 8, s.y + 2);
        if (S > 0.5 && beat < 0.15 && !s.getData("gFoot2")) host.spawnDust(s.x - dir * 10, s.y + 1);
        s.setData("gFoot2", beat < 0.15 ? 1 : 0);
      }
      break;
    }
    case "swim": {
      if (inWater) {
        hover = Math.sin(clock * 2.4) * 1.5;
        sx = 1 + 0.05 * M * Math.sin(a) + 0.04 * S;
        sy = 1 - 0.04 * M * Math.sin(a) - 0.04 * S;
        rot = dir * (0.05 * M + 0.06 * S);
      } else {
        rot = M * 0.07 * Math.sin(a) + dir * S * 0.06;
        lift = M * (0.6 + S) * Math.abs(Math.sin(a));
        sy = 1 - M * 0.04 * Math.abs(Math.cos(a)) + breathe;
        sx = 1 + M * 0.03 * Math.abs(Math.cos(a));
      }
      break;
    }
    case "sway": {
      rot = Math.sin(clock * 1.1) * 0.035 * idle + M * 0.05 * Math.sin(a) + dir * S * 0.05;
      lift = M * 0.8 * Math.abs(Math.sin(a));
      // charge glow: no server telegraph exists for the lancer, so this is the
      // cosmetic tell (the hit flash still overrides it)
      const pulse = (Math.sin(clock * 1.6) + 1) / 2, charge = pulse * pulse * pulse;
      sx = sy = 1 + charge * 0.06;
      if (!s.getData("flashing")) {
        if (charge > 0.05) {
          const c = Phaser.Display.Color.Interpolate.ColorWithColor(
            Phaser.Display.Color.IntegerToColor(0xffffff),
            Phaser.Display.Color.IntegerToColor(0xffb3ff),
            100,
            Math.min(100, charge * 100),
          );
          s.setTint(Phaser.Display.Color.GetColor(c.r, c.g, c.b));
        } else s.clearTint();
      }
      break;
    }
    case "hover": {
      hover = Math.sin(clock * 1.4) * 6;
      const pulse = (Math.sin(clock * 0.84) + 1) / 2;
      s.setAlpha((type === "frost_wraith" ? 0.72 : 0.78) + pulse * 0.16);
      sx = sy = 1 + pulse * 0.05;
      rot = dir * clamp01(spd / g.tps) * 0.16;
      // a darting wraith or wisp leaves a fading afterimage
      if (S > 0.5) {
        const t = (s.getData("gTrail") ?? 0) - dt;
        if (t <= 0 && s.visible) {
          const ghost = host.add
            .image(s.x, s.y, s.texture.key)
            .setOrigin(s.originX, s.originY)
            .setFlipX(s.flipX)
            .setScale(s.scaleX, s.scaleY)
            .setRotation(s.rotation)
            .setAlpha(0.28)
            .setTint(s.tintTopLeft)
            .setDepth(s.depth - 1);
          host.tweens.add({ targets: ghost, alpha: 0, duration: 260, onComplete: () => ghost.destroy() });
          s.setData("gTrail", 0.09);
        } else s.setData("gTrail", t);
      }
      break;
    }
  }

  s.setScale(base * sx, base * sy);
  s.setRotation(rot);
  s.setData("gHoverY", hover - lift);
}
