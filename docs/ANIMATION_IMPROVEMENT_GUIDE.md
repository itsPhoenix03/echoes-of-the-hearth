# Animation Improvement Guide

This guide explains how to improve player, creature, tool, combat, gathering, digging, traversal, and world-feedback animations in Echoes of the Hearth. It is based on the current implementation in `src/rig.ts`, `src/main.ts`, `src/audio.ts`, and `server/index.js`.

The current animation system is intentionally lightweight and procedural. Keep that advantage. The goal is not to introduce spritesheets or heavy skeletal middleware; the goal is to make the existing procedural rig behave like a body holding tools with weight, contact, anticipation, follow-through, and world interaction.

## Implementation Contract

The refactor should satisfy these invariants:

1. Gameplay authority stays in `server/index.js`. Animation may predict wind-up locally, but it must never decide range, damage, drops, digging, structure HP, or inventory.
2. One system writes rig-part transforms each frame. Tweens may advance scalar state, but `tick(dt)` should compose locomotion, action, equipment, and additive feedback into the final pose.
3. The network/world root represents authoritative or interpolated position. Jump bob, recoil, squash, and body lean belong on a visual `bodyRoot` child so they cannot fight remote-position lerping.
4. Tools attach to a hand/wrist pivot using per-tool grip metadata. No action should independently rotate the arm and tool around unrelated hardcoded points.
5. Action type and tool are separate values. `mine + spick`, `slash + isword`, and `punch + null` must remain distinguishable locally and remotely.
6. Existing gameplay cooldowns define cadence: client interaction gate about 300ms, server gather/dig gate 250ms, and server attack gate 400ms. Clip impact/cancel windows must allow valid repeated actions without dropping every other input.
7. Local and remote players call the same pose/clip API. Prediction and position interpolation can differ; clip definitions cannot.
8. Every action exits through completion, rejection, interruption, z-layer change, death/teleport, or rig destruction without leaving a rotated limb, hidden tool, or live infinite tween.

The first implementation target is not “more movement.” It is a stable hierarchy, explicit grip points, one pose compositor, and action/result timing that remains correct under latency.

## Current Implementation Summary

### `src/rig.ts`

Current character construction:

- `makePartTextures(scene)` generates textures for body parts and tools at runtime.
- Generated body textures:
  - `p-body`
  - `p-head`
  - `p-arm`
  - `p-leg`
- Generated tool textures:
  - `i-axe`
  - `i-pick`
  - `i-spick`
  - `i-sword`
  - `i-isword`
- `Rig` is a `Phaser.GameObjects.Container` holding separate images for legs, arms, torso, head, and a single `tool` image.
- Walk animation is a sine wave in `Rig.tick(dt)`.
- Action animation is `Rig.act(kind)`, a single 320ms counter tween for every tool and bare-hand interaction.

Current action swing logic:

```ts
const swing = v < 0.4 ? -(v / 0.4) * 2.0 : -2.0 + ((v - 0.4) / 0.6) * 2.0;
this.armR.rotation = swing;
this.tool.rotation = swing;
const tip = Phaser.Math.RotateAround({ x: 8, y: -12 }, 8, -23, swing);
this.tool.setPosition(tip.x, tip.y);
```

What this means visually:

- The arm and tool rotate by the same angle.
- The tool is repositioned around a hardcoded point near the shoulder.
- There is no separate wrist, grip, elbow, off-hand, torso lean, head tracking, or impact hold.
- All tools share the same arc.
- Pickaxe, axe, sword, water collection, and bare-hand interactions all feel like variants of the same movement.

### `src/main.ts`

Animation trigger points:

- Space triggers `jump()` and sends `{ t: 'anim', a: 'j' }`.
- F triggers `attack()`, calls `this.me.act(this.equipped)`, sends `{ t: 'anim', a: this.equipped }`, then sends `{ t: 'atk' }`.
- Holding E calls `interact()` every frame, rate-limited by `lastGather`.
- Underground digging calls `this.me.act(this.tools.has('spick') ? 'spick' : 'pick')`, but sends remote animation as `{ t: 'anim', a: 'pick' }`.
- Surface gathering picks `axe`, `pick`, or `null` based on node type and tools.
- Remote players receive `anim` and call `o.rig.act(m.a || null)`.
- Remote jump is not handled by `Rig`; it directly tweens the remote container y position.
- The update loop also lerps remote rig `x/y` every frame, so the remote jump tween and network interpolation write the same `y` property.
- Wisp creation starts an infinite tween on sprite `y`, while the creature interpolation loop also writes the same sprite `y`; move bobbing to a child or additive visual offset.
- Node and iceberg sprites are world objects; animation effects must preserve their base ground/depth position instead of permanently accumulating tween offsets.

### `server/index.js`

Current animation networking:

```js
else if (m.t === 'anim') bcast({ t: 'anim', id, a: m.a });
```

Important behavior:

- Animation messages are cosmetic relay only.
- Server does not validate animation payload against actual action success.
- Actual gameplay validation is still done in `gather`, `dig`, `atk`, etc.
- This is acceptable as long as animation remains cosmetic.

### `src/audio.ts`

Current action audio:

- `swing()` is a short high bandpass burst.
- `chop()` is a lower burst.
- No weapon-specific attack audio.
- No separated anticipation/contact/recovery audio.

## Main Problems To Fix

### 1. Tool Looks Pasted Onto The Arm

Cause:

- The tool is a separate image that shares the same rotation as the arm.
- The tool position is manually rotated around a rough shoulder point.
- The grip point is not part of the tool texture definition.

Fix:

- Introduce a dedicated hand or wrist pivot container.
- Parent the tool to the hand/wrist pivot.
- Define per-tool grip offsets so the handle sits in the palm.
- Rotate shoulder/forearm/wrist independently or approximate this with nested containers.

### 2. Every Action Uses The Same Arc

Cause:

- `Rig.act(kind)` has one motion curve regardless of tool type.

Fix:

- Replace generic `act(kind)` with action-specific clips:
  - `chop` for axe/tree.
  - `mine` for pick/boulder/crystal/digging.
  - `slash` for sword.
  - `thrust` or `heavySlash` for iron sword.
  - `punch` for bare hand.
  - `collect` for water/resources without a tool.
  - `place` for building/furniture.
  - `cast/activate` for monolith/core interactions.

Also remove the semantic ambiguity in `kind = kind || this.holdKind`. In the current rig, calling `act(null)` for water collection, a bush, or a bare-hand action can silently fall back to the equipped tool. The new API must distinguish “use held tool” from “explicitly no tool”:

```ts
playAction({ name: 'punch', tool: null });       // intentionally empty hand
playAction({ name: 'slash', tool: this.holdKind });
```

Do not use falsy values to mean both cases.

### 3. No Anticipation Or Follow-Through

Cause:

- The swing moves from neutral to peak and back with a simple interpolation.
- There is no visible wind-up before impact.
- There is no contact pause or recoil.

Fix:

- Use a 4-phase animation model:
  - Anticipation: body shifts opposite the action.
  - Strike: fast motion toward target.
  - Impact: short hold, shake, sound, dust/spark.
  - Recovery: return with overshoot damping.

### 4. Character Body Does Not Participate

Cause:

- Only right arm and tool animate during action.
- Torso, head, left arm, and legs stay mostly neutral.

Fix:

- Add torso lean/twist per action.
- Use left arm for balance or two-handed grip.
- Add head look/focus during action.
- Plant feet during heavy actions.
- Add small root offset for forceful attacks.

### 5. Digging Does Not Aim At The Tile Being Dug

Cause:

- `Rig.act()` only knows the tool kind, not the target direction or target tile.
- The client already computes `faceX`/`faceY`, but this is not passed into the action clip.

Fix:

- Pass an action context into the rig:

```ts
this.me.playAction({ type: 'dig', tool: 'pick', dirX: this.faceX, dirY: this.faceY, targetTile: best });
```

- Remote messages can remain simple initially, but the better protocol is:

```json
{ "t": "anim", "a": "dig", "tool": "pick", "dx": 1, "dy": 0 }
```

- If avoiding protocol changes, derive direction from remote movement/facing and action type only.

### 6. Jump Is Outside The Rig

Cause:

- Local jump uses `jumpT` in `main.ts`.
- Remote jump directly tweens `o.rig.y`.
- No leg compression, launch, or landing squash.

Fix:

- Keep gameplay jump timing/collision in `main.ts`, but expose jump phase to `Rig.playJump()` or the rig pose state.
- Add a stable position root and a child `bodyRoot`. Apply the 20px hop and compression/landing pose to `bodyRoot`, not to the remote rig container that `update()` also lerps toward `o.tx/o.ty`.
- Local and remote jump should use the same body-pose curve. Remote network position continues to update the stable root while the visual child performs the hop.

## Recommended Rig Architecture

### Current Simple Rig

```text
Rig Container
├─ legL image
├─ legR image
├─ armL image
├─ torso image
├─ head image
├─ armR image
└─ tool image
```

### Better Procedural Rig

```text
Rig Container
├─ shadow image/ellipse optional
├─ bodyRoot Container
│  ├─ legL image
│  ├─ legR image
│  ├─ torso image
│  ├─ head image
│  ├─ armLUpper Container or image
│  ├─ armLFore Container or image
│  └─ armRShoulder Container
│     └─ armR Image or forearm container
│        └─ handR Container
│           └─ tool image
└─ effectsRoot optional
```

Minimum practical version:

```text
Rig Container
├─ legL image
├─ legR image
├─ armL image
├─ torso image
├─ head image
└─ armRRoot Container at shoulder
   └─ armR image with origin at shoulder
      └─ handR Container near palm
         └─ tool image with per-tool grip offset
```

This minimum version already fixes the pasted-tool problem because the tool follows a hand pivot instead of being separately rotated and manually repositioned.

## Tool Grip Model

Each tool needs metadata. Do not hardcode a single position for every tool.

Recommended metadata:

```ts
type ToolGrip = {
  texture: string;
  rest: { x: number; y: number; rot: number; scale?: number };
  grip: { x: number; y: number };
  bladeTip?: { x: number; y: number };
  twoHanded?: boolean;
  weight: 'light' | 'medium' | 'heavy';
};
```

Example values to tune visually:

```ts
const TOOL_GRIPS: Record<string, ToolGrip> = {
  axe: {
    texture: 'i-axe',
    rest: { x: 1, y: 9, rot: -0.15 },
    grip: { x: 6, y: 13 },
    bladeTip: { x: 10, y: 2 },
    twoHanded: false,
    weight: 'medium'
  },
  pick: {
    texture: 'i-pick',
    rest: { x: 1, y: 10, rot: -0.1 },
    grip: { x: 8, y: 14 },
    bladeTip: { x: 1, y: 4 },
    twoHanded: true,
    weight: 'heavy'
  },
  spick: {
    texture: 'i-spick',
    rest: { x: 1, y: 10, rot: -0.1 },
    grip: { x: 8, y: 14 },
    bladeTip: { x: 1, y: 4 },
    twoHanded: true,
    weight: 'heavy'
  },
  sword: {
    texture: 'i-sword',
    rest: { x: 1, y: 12, rot: -0.35 },
    grip: { x: 4, y: 17 },
    bladeTip: { x: 4, y: 1 },
    twoHanded: false,
    weight: 'light'
  },
  isword: {
    texture: 'i-isword',
    rest: { x: 1, y: 13, rot: -0.35 },
    grip: { x: 4, y: 19 },
    bladeTip: { x: 4, y: 1 },
    twoHanded: true,
    weight: 'medium'
  }
};
```

Important Phaser note:

- If the tool texture origin is set to the grip point, rotation becomes natural.
- Use `setOrigin(grip.x / textureWidth, grip.y / textureHeight)` for each tool.
- Then place the tool at hand position and rotate it relative to wrist.

## Animation Clip System

Replace `act(kind)` with a named action clip system.

Recommended public API:

```ts
type ActionName = 'chop' | 'mine' | 'slash' | 'thrust' | 'punch' | 'collect' | 'place' | 'jump' | 'cast';

type ActionContext = {
  name: ActionName;
  tool?: string | null;
  dirX?: number;
  dirY?: number;
  targetX?: number;
  targetY?: number;
  intensity?: number;
};

class Rig extends Phaser.GameObjects.Container {
  playAction(ctx: ActionContext): void;
  hold(kind: string | null): void;
  tick(dt: number): void;
}
```

Keep backward compatibility temporarily:

```ts
act(kind: string | null) {
  const name = kind === 'axe' ? 'chop'
    : kind === 'pick' || kind === 'spick' ? 'mine'
    : kind === 'sword' || kind === 'isword' ? 'slash'
    : 'punch';
  this.playAction({ name, tool: kind });
}
```

This lets you improve `Rig` without changing every call site immediately.

## Clip Phase Design

Every action should have tuned phases.

### Chop: Axe Against Tree

Purpose:

- Downward diagonal cut with weight.
- Feels like shoulder and torso drive the movement.

Suggested phases:

| Phase | Time | Pose |
|---|---:|---|
| Anticipation | 0-110ms | Axe raises behind shoulder, torso leans back, knees compress slightly. |
| Strike | 110-210ms | Axe accelerates down and forward, torso snaps into cut. |
| Impact | 210-250ms | 40ms hold, small recoil, optional tree shake/dust. |
| Recovery | 250-420ms | Arm returns with overshoot, torso settles. |

Pose notes:

- Right arm rotates from about `-1.2` to `0.9` radians depending on facing.
- Wrist/tool should lag behind arm by 0.1-0.2 radians during anticipation, then catch up at impact.
- Head dips slightly at impact.
- Left arm moves opposite for balance.

### Mine/Dig: Pickaxe Against Rock

Purpose:

- Two-handed overhead or side strike into a rock face.
- Feels heavier than axe.

Suggested phases:

| Phase | Time | Pose |
|---|---:|---|
| Anticipation | 0-150ms | Pick raises high, both arms up, torso leans back. |
| Strike | 150-260ms | Fast downward arc. |
| Impact | 260-330ms | Hold at rock face, camera/tool micro-shake, spark/dust. |
| Recovery | 330-520ms | Slow pullback, body regains balance. |

Pose notes:

- Pickaxe should be two-handed: left arm reaches toward handle during anticipation/strike.
- For underground digging, aim the pick toward `faceX/faceY` target side.
- Digging into north/south/east/west rock should slightly alter the arc.
- Stone pick should feel heavier than wooden pick by longer anticipation/recovery.

### Slash: Sword Attack

Purpose:

- Fast weapon arc, readable in combat.

Suggested phases:

| Phase | Time | Pose |
|---|---:|---|
| Anticipation | 0-60ms | Sword pulls back, torso coils. |
| Strike | 60-150ms | Fast slash across front. |
| Impact Window | 110-170ms | Visual arc and hit spark if server confirms hit. |
| Recovery | 150-300ms | Return to guarded pose. |

Pose notes:

- Sword should not use the same vertical arc as axe/pick.
- Sword arc should be lateral/diagonal across the player front.
- Iron sword can be slightly slower, wider, and brighter.

### Punch/Bare Hand

Purpose:

- Used for hand gathering, water collection, no-tool hits.

Suggested phases:

| Phase | Time | Pose |
|---|---:|---|
| Anticipation | 0-60ms | Arm pulls back. |
| Reach/Strike | 60-140ms | Hand extends forward/down. |
| Contact | 140-170ms | Small hold. |
| Recovery | 170-260ms | Return. |

Pose notes:

- Do not show tool.
- Use small torso lean.
- For water collection, use a crouch/reach rather than punch.

### Place/Build

Purpose:

- Player places a structure or furniture.

Suggested phases:

| Phase | Time | Pose |
|---|---:|---|
| Reach | 0-140ms | Arm reaches forward/down. |
| Set | 140-220ms | Small body crouch, object ghost solidifies. |
| Release | 220-320ms | Hand opens, body rises. |

Pose notes:

- Pair with structure pop-in animation.
- No weapon should be visible during place unless intentionally holding hammer/tool.

### Jump

Purpose:

- Make jumping feel grounded.

Suggested phases:

| Phase | Time | Pose |
|---|---:|---|
| Squash | 0-80ms | Legs bend, torso lowers. |
| Launch | 80-170ms | Legs extend, arms lift. |
| Air | 170-350ms | Legs tuck slightly. |
| Land | 350-450ms | Squash on contact, dust. |

Implementation note:

- Keep jump timing and movement permission in `main.ts` so gameplay remains unchanged.
- Apply visual hop and `Rig.playJumpPose()` to `bodyRoot`; keep the network/interpolation root stable.

## Swimming And Boat Locomotion

### Locomotion State API

Walking, swimming, and boating should not be inferred from whether a boat item exists. Pass explicit traversal mode into the rig:

```ts
type LocomotionMode = 'land' | 'swim' | 'boat';

type LocomotionContext = {
  mode: LocomotionMode;
  moving: boolean;
  speed: number;
  waterTemp?: 'temperate' | 'freezing' | 'hot';
  boatKind?: 'boat' | 'sboat' | null;
};

rig.setLocomotion(ctx);
```

The server/network state identifies remote traversal mode. Do not decide remote boating from local inventory and do not show a boat merely because a player is standing over a water tile.

### Swim Clip

Swimming needs a continuous locomotion loop rather than a one-shot action:

| Phase | Normalized Time | Pose |
|---|---:|---|
| Reach | 0.00-0.25 | Lead arm extends forward, opposite shoulder rotates back. |
| Pull | 0.25-0.50 | Lead arm sweeps down/back, torso rolls slightly. |
| Recover | 0.50-0.75 | Opposite arm rises, head bobs above waterline. |
| Opposite pull | 0.75-1.00 | Mirrored stroke completes the cycle. |

Implementation requirements:

- Lower `bodyRoot` relative to the water surface so only head/shoulders/arms remain clearly above water.
- Add a small oval/ripple sprite or particle wake at the waterline. Do not permanently change the rig's world root/depth.
- Reduce or hide the normal walk-leg swing; use a subtle alternating kick below the waterline if visible.
- Cycle around 1.0-1.25 seconds while moving and use a slower 1.8-second tread-water loop while idle.
- Use additive torso roll of roughly 0.08-0.14 radians, not full-body flipping each stroke.
- Keep the held tool hidden while swimming unless a later design explicitly supports one-handed tools in water.
- Blend into swim over 120-180ms and back to land pose over 100-150ms to avoid a one-frame body-height pop at shore.
- Freezing water adds shiver amplitude and tighter strokes; hot water adds fatigue/head recoil. These are visual modifiers only; damage remains server-owned.

Do not use a Phaser geometry mask per swimmer unless profiling shows it is cheap enough for four players. A waterline overlay/ripple in front of the lowered body is simpler and consistent with the current procedural style.

### Boat Selection And Mount Transition

Boat animation begins only when `activeVehicle` is server-accepted. `selectedVehicle` changes UI intent but must not create a boat sprite or change locomotion by itself.

Mount sequence:

1. Client selects an owned boat in UI.
2. At a valid shore transition, client may predict a short 150ms step/launch anticipation.
3. Server confirms active boat; create/reveal boat sprite and blend the body into seated/braced pose.
4. On rejection, remove prediction and continue walking/swimming.

Boat pose:

- Legs stop walking and remain seated/braced.
- Torso leans 0.04-0.1 radians with steering direction.
- Boat bobs through a child visual offset, never by changing authoritative player position.
- Wake intensity depends on actual movement speed.
- Wooden and reinforced boats use the same base motion with different weight: reinforced boat has slower, smaller bob and a stronger impact recoil.
- Dock transition reverses the mount blend. Boat destruction uses a sharp recoil/splash, then transitions to swim or wash-ashore state from server response.

### Thermal Water Feedback

Visual/audio feedback must precede and support server damage without pretending to be authoritative:

- Freezing: pale ripple, small ice flecks, blue breath/shiver, tighter tread-water loop.
- Hot: steam wisps, orange ripple highlights, periodic recoil/fatigue pose.
- Play one zone-entry cue, then rate-limit loop sounds and warning animation.
- Damage flinch occurs on the server `hp` result, not every local exposure timer guess.
- Correct cloak can reduce shiver/fatigue intensity but should not remove the swim loop or server damage entirely.

## Easing Recommendations

Avoid one `Sine.inOut` for all action types.

Use per-phase easing:

- Anticipation: `Sine.out` or `Quad.out`.
- Strike: `Cubic.in` or `Expo.in` for acceleration.
- Impact: short hold, no easing.
- Recovery: `Back.out`, `Elastic.out` with low amplitude, or manual damping.

Manual curve example:

```ts
function easeOutBack(t: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
```

For deterministic visual animation, a manual state machine in `tick(dt)` is often easier to control than many overlapping Phaser tweens.

## Prefer Pose Blending Over Many Tweens

Current code uses a tween counter that directly writes arm/tool transforms. This works, but it becomes hard to blend walking, acting, jumping, and idles.

Better approach:

1. Reset a pose object from immutable authored rest values every frame.
2. Add locomotion offsets with a weight that drops for planted heavy actions.
3. Add the sampled action clip pose.
4. Add jump/recoil/damage offsets last.
5. Apply every part's x/y/rotation/scale exactly once.

Concept:

```ts
const finalPose = addPoses(
  restPose,
  scalePose(walkPose, walkWeight),
  scalePose(actionPose, actionWeight),
  scalePose(jumpPose, jumpWeight)
);
applyPose(finalPose);
```

Minimum practical version:

- Keep walk sine logic.
- During action, reduce walk arm swing but keep leg movement if the player is moving.
- Add body/torso/head offsets from action clip.
- Reset all transformed parts in one `applyPose()` method.

Do not repeatedly add offsets to the current display-object transform; that creates frame-rate-dependent drift. Store authored rest transforms separately and compose from those values. Normalize rotations to radians everywhere inside the rig. Define clip values as offsets unless a field is explicitly documented as an absolute pose.

## Proposed `Rig` Internals

### New Fields

```ts
private action: ActionState | null = null;
private actionTime = 0;
private facing = 1;
private movePhase = 0;
private basePose: Pose;
private currentPose: Pose;
```

### Pose Shape

```ts
type PartPose = {
  x?: number;
  y?: number;
  rot?: number;
  sx?: number;
  sy?: number;
  alpha?: number;
};

type Pose = {
  torso?: PartPose;
  head?: PartPose;
  armL?: PartPose;
  armR?: PartPose;
  handR?: PartPose;
  legL?: PartPose;
  legR?: PartPose;
  tool?: PartPose;
};
```

### Action State

```ts
type ActionState = {
  seq?: number;
  name: ActionName;
  tool: string | null;
  duration: number;
  t: number;
  impactAt: number;
  impactFired: boolean;
  accepted: boolean;
  dirX: number;
  dirY: number;
};
```

### Runtime Flow

```ts
playAction(ctx: ActionContext) {
  if (this.action && this.action.t < this.action.duration * 0.55) return;
  this.action = makeActionState(ctx);
  this.attachTool(ctx.tool); // null is an explicit empty hand
}

tick(dt: number) {
  this.updateWalk(dt);
  this.updateAction(dt);
  const pose = this.composePose();
  this.applyPose(pose);
}
```

Important:

- Allow a new action to cancel only after impact or after 55-65% of the previous animation. This prevents input spam from popping the arm back to neutral.
- Under the minimum cosmetic protocol, a rejected action may still display a full local swing. Under the preferred validated protocol, predict anticipation only and blend to recovery on `actReject`.
- Keep at most one buffered action. Holding E should not accumulate an unbounded queue when the server/client cooldown is shorter than a clip.
- Clear action/buffer state on z-layer change, death/teleport, disconnect, and `destroy()`.

## Direction And Facing

Current `face(dx)` flips the whole container horizontally. This is cheap and should be retained.

However, action direction needs more nuance:

- `faceX` and `faceY` in `src/main.ts` already represent tile-facing direction for dig targeting.
- Use these values to vary action pose:
  - Facing east/west: side swings are readable.
  - Facing north/south in isometric projection: use vertical offset and body lean because the sprite is still horizontally flipped only.

Recommended action context from `main.ts`:

```ts
this.me.playAction({
  name: 'mine',
  tool: this.tools.has('spick') ? 'spick' : 'pick',
  dirX: this.faceX,
  dirY: this.faceY,
  targetX: best % SIZE,
  targetY: (best / SIZE) | 0
});
```

For surface gather:

```ts
const action = tool === 'axe' ? 'chop'
  : tool === 'pick' ? 'mine'
  : 'punch';
this.me.playAction({ name: action, tool, dirX: this.faceX, dirY: this.faceY });
```

For attacks:

```ts
const action = this.equipped === 'sword' || this.equipped === 'isword' ? 'slash'
  : this.equipped === 'axe' ? 'chop'
  : this.equipped === 'pick' || this.equipped === 'spick' ? 'mine'
  : 'punch';
this.me.playAction({ name: action, tool: this.equipped, dirX: this.faceX, dirY: this.faceY });
```

## Animation Network Protocol

Current protocol is:

```json
{ "t": "anim", "a": "axe" }
```

Server broadcasts:

```json
{ "t": "anim", "id": "...", "a": "axe" }
```

This is enough for basic improvements if `Rig.act(kind)` maps tool to action type.

Minimum compatible protocol for richer remote animation:

Client -> Server:

```json
{ "t": "anim", "a": "mine", "tool": "pick", "dx": 1, "dy": 0 }
```

Server -> Client:

```json
{ "t": "anim", "id": "...", "a": "mine", "tool": "pick", "dx": 1, "dy": 0 }
```

Validation recommendation:

- Keep animation cosmetic. Do not block gameplay on animation messages.
- Sanitize values to known strings before broadcast to avoid unbounded arbitrary payloads.
- Better server code:

```js
else if (m.t === 'anim') {
  const allowedA = new Set(['chop', 'mine', 'slash', 'thrust', 'punch', 'collect', 'place', 'cast', 'j', null]);
  const allowedTool = new Set(['axe', 'pick', 'spick', 'sword', 'isword', null]);
  const a = allowedA.has(m.a) ? m.a : null;
  const tool = allowedTool.has(m.tool) ? m.tool : null;
  const dx = Math.max(-1, Math.min(1, Number(m.dx) || 0));
  const dy = Math.max(-1, Math.min(1, Number(m.dy) || 0));
  bcast({ t: 'anim', id, a, tool, dx, dy });
}
```

If changing the protocol, update `test.mjs` only if tests inspect animation payloads. Gameplay tests likely do not need changes because animation remains cosmetic.

### Preferred Validated Action Protocol

The minimum protocol still has a visible correctness problem: the client sends `anim` before `gather`, `dig`, or `atk`, so remote players can see an action the server later rejects. Existing result messages also cannot correlate an impact with the actor:

- `node {i,hp}` has no `by` or action sequence.
- `dig {tiles[]}` has no `by` or action sequence.
- `chit {id}` identifies the target, not the attacker.
- `anim` can report `pick` while the local player actually uses `spick`.

For the robust implementation, generate a monotonically increasing client action sequence and attach it to the gameplay request. Play only anticipation locally before confirmation:

```json
{ "t": "gather", "seq": 41, "i": 8123, "dx": 1, "dy": 0 }
{ "t": "dig",    "seq": 42, "i": 9123, "dx": 0, "dy": -1 }
{ "t": "atk",    "seq": 43, "dx": -1, "dy": 0 }
```

After validation, the server derives action and tool from authoritative state and broadcasts one action-start event:

```json
{ "t": "act", "id": "p1", "seq": 41, "a": "chop", "tool": "axe", "dx": 1, "dy": 0, "targetI": 8123 }
```

Outcome messages carry the same correlation fields:

```json
{ "t": "node", "i": 8123, "hp": 2, "by": "p1", "seq": 41 }
{ "t": "dig", "tiles": [9123], "by": "p1", "seq": 42 }
{ "t": "chit", "id": "creature7", "by": "p1", "seq": 43, "x": 123.4, "y": 98.2 }
{ "t": "actReject", "seq": 44, "reason": "out_of_range" }
```

Protocol rules:

- Validate `seq` as a bounded integer and direction as normalized cardinal/isometric intent. Do not trust client-supplied action names, tools, target positions, damage, or impact type.
- For gather, derive `chop`, `mine`, or `punch` from the authoritative node kind and owned tool.
- For attack, derive the clip from `p.equip`; broadcast `act` for a valid attack even when it misses, then omit `chit`.
- For dig, derive `pick` versus `spick` from the tool actually accepted by validation.
- Broadcast `act` only after the same rate-limit, z-layer, distance, ownership, and target checks that accept gameplay.
- The local predicted clip reconciles by `(localPlayerId, seq)`: accepted actions continue into strike; rejected actions blend to recovery without impact effects.
- Keep `anim` only for truly cosmetic actions such as emotes during migration. Jump can remain cosmetic if gameplay does not depend on it, but sanitize it.
- Sequence IDs are for correlation and deduplication, not security. Server state remains authoritative.

This protocol is optional for the first grip-only refactor, but it is required before claiming server-confirmed, actor-specific impact synchronization.

## World Interaction Feedback

Animation should not stop at the player rig. The world should respond at contact time.

### Gathering Nodes

Current node feedback:

- Server sends `node { i, hp }`.
- Client can shake/fade/deplete node based on hp in `onMsg`.

Recommended improvements:

- On local action start: play wind-up only.
- On server `node` damage response: play impact feedback.
- Tree hit:
  - quick node shake toward strike direction.
  - leaf particles.
  - wood-chip particles near trunk.
- Boulder/crystal hit:
  - small spark or shard particles.
  - sharper screen-space flash.
- Bush/hand gather:
  - soft leaf puff.

Avoid:

- Playing full impact effects before server confirms the action. It can feel wrong if the server rejects distance/tool validation.

### Digging

Server sends `dig { tiles[] }` when a tunnel is carved.

Recommended:

- On local action start: wind-up pickaxe.
- On `dig` response: rock chunk particles, dust cloud, short screen shake if near player.
- Newly exposed ore should glint after the dust clears.

### Combat

Current hit feedback:

- Server sends `chit { id }` for creature/animal hit flash.
- Client plays hit effects around creature/animal.

Recommended:

- Local attack animation plays immediately.
- Hit spark/blood/dust only on `chit` from server.
- Creature recoil direction should be away from attacker if known. If attacker id is not sent, use a simple yoyo/flash.
- Consider extending `chit` with attacker id or hit position later:

```json
{ "t": "chit", "id": "creatureId", "by": "playerId", "x": 123.4, "y": 98.2 }
```

## Creature And Animal Animation Improvements

Current creature/animal movement:

- Sprites lerp toward server positions.
- Some creatures have simple tween loops.
- Animals flip based on movement direction.

Recommended per-category improvements:

### Crawlers

- Low body bob during movement.
- Slight squash/stretch as they crawl.
- Faster bob when close to player.

### Stalkers

- Smoother, lower-amplitude movement.
- Short anticipation crouch before contact damage.
- Eye glow pulse at night.

### Brutes

- Heavy stomp cadence.
- Slower scale squash on each step.
- Dust/stones under feet.
- Wind-up before structure hit.

### Wisps

- Keep existing hover tween.
- Add small orbital particles.
- Use alpha/scale pulse when infecting a tile.

### Wildlife

- Deer/stag: head bob, leg flicks, quick flee animation.
- Boar: lower body bob, charge pose when fleeing/attacking if implemented.
- Fox/hare/lizard: fast small hops instead of smooth sliding.
- Seal: slide/flop near coast, not standard walking.
- Existing owl/raven/moth can use simple hover/wing deformation if kept as single textures.
- New gull, snow tern, ember kite, and marsh heron assets use real three-frame wing cycles.

### Flying Bird Frame Animation

Assets are stored under `sprites/birds` as `*_fly_1.svg`, `*_fly_2.svg`, and `*_fly_3.svg`. Phaser rasterizes each SVG to a static texture, so preload all three frames and cycle:

```text
1 (wings up) -> 2 (level) -> 3 (wings down) -> 2 (level) -> repeat
```

Recommended timing:

| Species | Moving flap | Glide behavior | Region |
|---|---:|---|---|
| Gull | 110-140ms/frame | Hold frame 2 for 500-900ms | Temperate ocean/coasts |
| Snow tern | 80-110ms/frame | Short 250-450ms glide | Freezing water/Spire |
| Ember kite | 130-170ms/frame | Long 700-1200ms glide | Hot water/Core |
| Marsh heron | 170-220ms/frame | Hold frame 2 for 400-700ms | Marsh/reedbanks |

Implementation rules:

- Use a Phaser animation per species or a lightweight shared frame timer; do not create one repeating tween per bird.
- Give each flock one seeded phase offset so every bird does not flap in sync.
- Move a stable flight root along the path and apply bob/bank to a visual child or sprite offset.
- Flip horizontally from velocity direction. Bank by at most 5-10 degrees so silhouettes remain readable.
- Depth is based on projected ground y plus a fixed flight layer/altitude offset. Avoid crossing behind terrain that should be visually below the bird.
- Birds are ambient and camera-local by default. Pause/despawn animation outside the streaming margin.
- For gliding, keep frame 2 and reduce bob rather than stopping midway on an up/down frame.
- If birds become huntable, server simulation controls position/death; the same client frame animation can remain cosmetic.

Implementation:

- Add a small animation update function for creature sprites in `main.ts` after lerp.
- Store previous position in sprite data to estimate speed.
- Use `type` to choose idle/move loop.

Example:

```ts
function animateAnimalSprite(s: Phaser.GameObjects.Sprite, type: string, dt: number) {
  const speed = Math.hypot(s.x - (s.getData('px') ?? s.x), s.y - (s.getData('py') ?? s.y));
  const phase = (s.getData('phase') ?? 0) + dt * (speed > 0.5 ? 10 : 3);
  s.setData('phase', phase);
  s.setData('px', s.x);
  s.setData('py', s.y);
  if (type === 'hare') s.scaleY = 1 + Math.sin(phase) * 0.08;
}
```

## Environmental Animation Improvements

These are not player rig changes, but they make the whole world feel more coherent.

### Trees And Vegetation

- Add idle wind sway based on weather.
- Trees should sway more in rain/storm; cactus should barely sway.
- Use tiny rotation around base origin.
- Avoid per-frame tweens on every sprite; update only visible nearby vegetation or use a shared shader-like phase in `update()`.

### Water And Boats

- Boat appears only after active vehicle confirmation; selection/ownership alone must not render it.
- Player uses the swim locomotion loop whenever on water without an active boat.
- Boat should bob while sailing.
- Boat should lean slightly based on movement direction.
- Add wake particles behind boat.
- Wooden boat near icebergs should shudder before break if server sends `boat`.
- Freezing/hot water should add ice-fleck or steam particles near visible swimmers without spawning full-map emitters.

### Structures

- New structures should pop in with scale/alpha over 120-180ms.
- Damaged structures should shake in place on `sd`.
- Campfires should flicker scale/alpha and glow radius.
- Torches should flicker similarly underground.

### Weather

Current weather particles are good for atmosphere. Improvements:

- Player cloak/torso can lean slightly into sandstorm/blizzard wind.
- Rain can make footstep cadence sound wetter on mud/grass.
- Snowstorm can reduce animation speed slightly if not protected, but do not change gameplay movement unless server rules also change.

## Audio Synchronization

Animation feels smoother when audio lines up with contact.

Current problem:

- `audio.swing()` or `audio.chop()` often plays at action start.
- Impact visually happens later, so sound can feel detached.

Recommended:

- Split action sounds:
  - `whoosh` during strike.
  - `impactWood`, `impactStone`, `impactFlesh` on server-confirmed contact.
  - `impactAir` at the local clip's miss/contact time after a valid attack produces no target result.
  - `recover` optional light cloth/gear sound.

Minimum practical implementation:

- Keep `audio.swing()` at action start for attacks.
- Move loud `audio.chop()` for gather/dig to `node`/`dig` confirmation. Generic nearby impact audio can use existing messages; local/attacker-specific audio requires `by`/`seq` correlation.
- If immediate feedback is needed, play a quiet wind-up at start and louder impact on confirmation.

## Concrete Refactor Plan

### Phase 0: Capture Baseline And Add Animation Lab

Files:

- `src/main.ts` or a small development-only scene/helper

Tasks:

1. Record current action duration, interaction/attack cadence, grip screenshots, and two-client behavior.
2. Add controls to trigger every tool/action/direction at normal, half, and quarter speed.
3. Add optional debug markers for shoulder, hand, grip, tool contact point, target tile, and body root.

### Phase 1: Fix Tool Attachment Without Protocol Changes

Files:

- `src/rig.ts`

Tasks:

1. Add stable rig root, `bodyRoot`, shoulder/hand hierarchy, and tool child.
2. Add `TOOL_GRIPS` metadata.
3. Change `restTool()` to attach the tool at hand position with grip origin.
4. Replace hardcoded `RotateAround({ x: 8, y: -12 }, 8, -23, swing)` with hand-root transforms.
5. Move jump/bob visual offsets to `bodyRoot` so world-position interpolation owns only the rig root.
6. Keep `act(kind)` as a temporary compatibility wrapper, but do not let `null` silently fall back to held equipment.

Expected improvement:

- Tool sits in the hand naturally.
- Rotation pivots around the grip, not the texture center or rough shoulder point.

Risk:

- Phaser generated textures have known dimensions, but if texture size changes, grip values need retuning.

### Phase 2: Add Tool-Specific Clips

Files:

- `src/rig.ts`
- Optional minor edits in `src/main.ts`

Tasks:

1. Add `playAction(ctx)`.
2. Map old `act(kind)` to `playAction`.
3. Implement separate curves for axe, pick, sword, bare hand.
4. Add torso/head/left-arm offsets.
5. Add action cancel window after impact.
6. Compose from authored rest transforms and apply each part once per frame.
7. Add one-entry input buffering aligned with the 300ms gather and 400ms attack cadence.

Expected improvement:

- Mining feels heavy and two-handed.
- Sword feels quick and lateral.
- Axe feels like chopping, not generic waving.

### Phase 3: Pass Action Context From Main

Files:

- `src/main.ts`
- `server/index.js` only if extending network payload.

Tasks:

1. Use explicit action names in local calls.
2. Pass `dirX`/`dirY` to rig for digging and attacks.
3. First use the richer sanitized `anim` payload if protocol scope must remain cosmetic.
4. Prefer migrating gameplay actions to the validated `seq`/`act` protocol described above.
5. Remote players use `playAction({ name, tool, dx, dy, seq })`.
6. Derive action/tool on the server for accepted gameplay actions rather than trusting the cosmetic payload.

Expected improvement:

- Digging and attacking orient better toward target direction.
- Remote players look closer to local player movement.

### Phase 4: Add Impact Feedback

Files:

- `src/main.ts`
- `src/audio.ts`
- `server/index.js` and `test.mjs` when actor-specific correlation is implemented

Tasks:

1. Add particle textures for dust, chips, sparks, leaves.
2. Trigger generic world effects from existing server-confirmed messages.
3. Add tool-specific impact sounds.
4. Add tiny camera shake only for local nearby impacts.
5. Add `by`/`seq` to result messages before triggering local-only or attacker-specific impact effects.

Expected improvement:

- Animation feels connected to the world instead of isolated on the character.

### Phase 5: Improve Creatures, Wildlife, And Environmental Motion

Files:

- `src/main.ts`
- Optional new helper file `src/anim.ts`

Tasks:

1. Add shared sprite animation helpers for animals/creatures.
2. Add nearby vegetation sway.
3. Add boat bob/wake.
4. Add structure pop-in and damage shake.
5. Add torch/campfire flicker improvements.
6. Remove the wisp `y` tween/interpolation writer conflict by bobbing a child or storing an additive visual offset.

Expected improvement:

- The whole world feels animated, not just the player.

## Suggested `src/rig.ts` Implementation Skeleton

This is intentionally a sketch, not drop-in code.

```ts
const TOOL_GRIPS = {
  axe: { key: 'i-axe', w: 14, h: 16, ox: 6 / 14, oy: 13 / 16, restRot: -0.25 },
  pick: { key: 'i-pick', w: 16, h: 16, ox: 8 / 16, oy: 14 / 16, restRot: -0.15 },
  spick: { key: 'i-spick', w: 16, h: 16, ox: 8 / 16, oy: 14 / 16, restRot: -0.15 },
  sword: { key: 'i-sword', w: 8, h: 20, ox: 4 / 8, oy: 17 / 20, restRot: -0.45 },
  isword: { key: 'i-isword', w: 8, h: 22, ox: 4 / 8, oy: 19 / 22, restRot: -0.45 }
};

class Rig extends Phaser.GameObjects.Container {
  handR: Phaser.GameObjects.Container;
  action: ActionState | null = null;

  constructor(...) {
    this.armR = mk('p-arm', 0, 0, 0.08);
    this.handR = scene.add.container(8, -13);
    this.tool = scene.add.image(0, 0, 'i-axe').setVisible(false);
    this.handR.add(this.tool);
    this.add([...parts, this.handR]);
  }

  private attachTool(kind: string | null) {
    if (!kind) { this.tool.setVisible(false); return; }
    const g = TOOL_GRIPS[kind];
    this.tool.setTexture(g.key).setOrigin(g.ox, g.oy).setVisible(true);
    this.tool.setPosition(0, 0).setRotation(g.restRot);
  }
}
```

## Common Pitfalls

### Do Not Spawn Tweens Every Frame

Only create tweens when an action starts. Do not create tweens inside `tick(dt)` or per-frame update loops for every object.

### Do Not Let Action Tweens Fight Walk Animation

If a tween writes `armR.rotation` while `tick(dt)` also writes `armR.rotation`, the pose can jitter. Prefer one of these:

- Action tween only writes action state values, then `tick()` applies final transforms.
- Or action tween owns the arm and `tick()` does not touch that arm while acting.

Current code uses the second approach. The more scalable approach is the first.

### Do Not Reset The Tool To Neutral Too Early

If `onComplete` immediately calls `restTool()`, a second action can pop visually. Use action cancel windows and smooth recovery.

### Do Not Make Server Gameplay Depend On Client Animation

Animation is cosmetic. Server should still validate distance, tools, inventory, rate limits, z-layer restrictions, and damage.

### Do Not Add Spritesheet Dependencies Unless Necessary

The project design explicitly favors zero-budget procedural assets. Better procedural rigging is consistent with that design.

### Do Not Use One Origin For All Tools

Each tool needs a grip origin. A sword grip, pickaxe center, and axe handle are not the same point.

### Do Not Animate Remote Players Differently From Local Players

Remote player animation should call the same `Rig` methods. The only difference should be that remote position is lerped.

## Testing Checklist

Add a temporary animation-lab scene or debug mode that places the rig on a neutral background and can trigger every clip, direction, tool, movement combination, and playback speed. Tuning only in the live world makes grip errors and transform drift harder to isolate.

Pose invariants to verify programmatically or with debug assertions:

- Every sampled pose contains finite numbers; no `NaN` rotation/position can reach Phaser.
- Sampling a completed clip returns exactly the authored rest/hold pose within a small epsilon.
- Repeating the same clip 100 times does not change the final rest transform.
- `tool: null` stays empty-handed even when `holdKind` is set.
- The tool grip remains at the hand pivot through anticipation, impact, and recovery.
- Action cancellation, z-layer change, teleport/death, and rig destruction clear timers/tweens and restore visibility.
- Remote root interpolation never changes the `bodyRoot` hop offset, and hop never changes authoritative/interpolated root coordinates.

Manual checks:

1. Equip/unequip each hotbar tool: axe, pick, spick, sword, isword.
2. Walk while holding each tool. Tool should stay in hand without jitter.
3. Chop tree with and without axe.
4. Mine boulder/crystal with pick/spick.
5. Dig underground in all four tile-facing directions.
6. Attack with sword, iron sword, axe, pick, and bare hand.
7. Jump while idle and while moving.
8. Verify remote player sees the same action in a second browser tab.
9. Verify animation does not continue after switching z-layer or entering shelter/mine.
10. Verify no green missing-texture boxes appear.
11. Own a boat but leave it unselected; enter water and verify swim/tread-water animation with no boat sprite.
12. Select wooden boat while also owning reinforced boat; verify the selected wooden boat is the one rendered after server-confirmed launch.
13. Verify mount, dock, boat break, and wash-ashore/swim transitions do not pop the rig root or leave tools visible.
14. Compare idle tread-water and moving swim loops in all four travel directions.
15. Verify freezing/hot water visual modifiers begin on zone entry and damage flinch occurs only on server HP messages.
16. Observe each bird set through several flap/glide cycles and verify off-camera cleanup.

Build/test checks:

- Run `npm run build` after TypeScript changes.
- Start a fresh server and run `node test.mjs` after any server/shared protocol changes.
- If the preferred `seq`/`act` protocol is implemented, extend `test.mjs` to prove invalid actions emit no `act`, accepted actions preserve `seq`, the server derives tool/action rather than trusting client values, misses emit `act` without `chit`, and successful impacts carry matching `by`/`seq`.
- If only `src/rig.ts` cosmetic code changes, build is still required; protocol tests are optional but two-browser visual verification is required.

Performance checks:

- Watch FPS while many animals/creatures are visible.
- Avoid long-lived per-sprite tweens for hundreds of objects.
- Prefer simple math in `update()` for idle loops.
- Keep particle counts small and camera-local.
- Do not allocate pose objects, particles, or animation definitions every frame while swimming.
- Use shared bird animation definitions and camera-local flock streaming; avoid one independent timer/tween per bird.

Definition of done:

- Axe, pick/spick, sword/isword, bare-hand, collect, place, and jump have distinct readable silhouettes.
- No tool slides in the palm or rotates around the shoulder independently of the hand.
- Valid repeated gather and attack inputs animate at server-supported cadence without visible dropped cycles or unbounded buffering.
- Impact sound/world FX occur once, at contact, and actor-specific effects use correlated server results when that protocol is enabled.
- Local and remote clips match under a throttled/high-latency network, including direction and actual tool tier.
- No transform writer conflicts remain for remote jump or wisp bobbing.
- Unselected water entry uses swimming, selected/confirmed boat entry uses boat pose, and remote players show the same mode.
- Thermal swim and all four bird species animate without global emitters or off-camera update growth.
- `npm run build` passes, and `node test.mjs` passes when protocol/server behavior changed.

## Priority Recommendation

If time is limited, do this order:

1. Add tool grip metadata and pivot the tool around the hand.
2. Add separate axe/pick/sword/bare-hand clips.
3. Add torso/head/left-arm participation.
4. Add generic confirmed world impacts, then add `by`/`seq` before making them attacker-specific.
5. Add creature/animal/environment loops.

The first two steps will fix the specific complaint: tools currently feel pasted above the arm and move in an unnatural down/up arc. The later steps make the whole world feel more physically connected.
