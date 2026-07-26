# Player And World Animation Implementation Guide

> **Implementation audit: commit `5e792c7` (2026-07-21).** Basic hurt pose/vignette, remote boat
> hull rendering, animal facing, deterministic shared bird flaps, and client `dt` clamping are now
> implemented. The rig hierarchy, grips, pose compositor, distinct action clips, accepted action
> protocol, impact timing, real swim/boat locomotion, cloak rendering/sync, animal gait, bird glide,
> animation lab, and performance tests remain pending. Intentional `act(null)` is still incorrectly
> replaced by the held tool through `kind || holdKind`.

## 1. Current Animation Baseline

`src/rig.ts` currently contains one container with separate leg, arm, torso, head, and tool images.
Actions rotate the right arm and tool together through one 320ms counter tween. The tool position is
recalculated around a hardcoded point. This creates the reported pasted-on-arm and down/up motion.

Swimming is currently a visibility state: legs, torso, and left arm are hidden, leaving the head
visible. It is not a swim or tread-water animation. Keep this as a temporary fallback only.

Do not rewrite all animation at once. Introduce a pose system behind the existing `Rig` API, then
migrate actions one by one.

## 2. Required Rig Hierarchy

Create pivots matching real joints:

```text
Rig root
  bodyRoot
    shadow
    legRootL -> legL
    legRootR -> legR
    torso
    headRoot -> head
    shoulderL -> armL
    shoulderR -> armR
      handR
        toolRoot -> tool
    cloakRoot -> cloak
  waterline/wake visual
```

The shoulder pivot should be near the top of the arm. The hand pivot should be near the arm end.
The tool root rotates around its grip, not around the texture center. Body motion belongs on
`bodyRoot`; do not move the entire network/interpolation root for recoil or bob.

## 3. Tool Grip Metadata

Each texture needs a grip and resting orientation:

```ts
type ToolGrip = {
  texture: string;
  handX: number;
  handY: number;
  rotation: number;
  scale?: number;
  impactX?: number;
  impactY?: number;
};

const TOOL_GRIPS: Record<string, ToolGrip> = {
  axe:   { texture: 'i-axe',   handX: 0, handY: 9, rotation: -0.18 },
  pick:  { texture: 'i-pick',  handX: 0, handY: 10, rotation: -0.10 },
  spick: { texture: 'i-spick', handX: 0, handY: 10, rotation: -0.10 },
  sword: { texture: 'i-sword', handX: 0, handY: 8, rotation: 0.20 },
  isword:{ texture: 'i-isword',handX: 0, handY: 8, rotation: 0.20 },
};
```

Tune values in an animation lab scene. Do not scatter grip constants through action code.

## 4. Pose Representation

Use reusable numeric pose objects. Avoid allocating new objects every frame.

```ts
type RigPose = {
  bodyX: number; bodyY: number; bodyRot: number;
  headX: number; headY: number; headRot: number;
  armLRot: number; armRRot: number;
  handRRot: number; toolRot: number;
  legLRot: number; legRRot: number;
};
```

Compose in this order:

1. Base locomotion pose: land idle/walk, swim, boat.
2. Direction/facing adjustments.
3. Action pose: chop, mine, slash, gather, interact.
4. Reaction pose: recoil, hurt, impact.
5. Cosmetic pose: cloak lag, thermal shiver, breathing.

Higher layers should override only the channels they own. For example, a slash controls right arm,
hand, tool, and torso twist but should not reset the walking legs.

## 5. Clip State Machine

Replace overlapping action tweens with one deterministic action state:

```ts
type ActionKind = 'chop' | 'mine' | 'slash' | 'gather' | 'interact';

type ActiveAction = {
  kind: ActionKind;
  tool: string | null;
  elapsed: number;
  duration: number;
  impactAt: number;
  impactSent: boolean;
};
```

`tick(dt)` advances the action and samples keyframes. Clamp `dt` and normalized time. Every sampled
value must remain finite.

Keyframe interpolation can start with smoothstep:

```ts
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * smooth(t);
```

Use anticipation, strike, and recovery rather than one symmetric swing.

## 6. Tool-Specific Actions

### Axe Chop

- Duration: 420-500ms.
- Anticipation: torso turns away, right elbow raises, tool moves behind head.
- Strike: fast diagonal shoulder/elbow rotation with small forward body shift.
- Impact: approximately 58-65% through clip.
- Recovery: overshoot slightly, then settle to held pose.
- Target feedback: tree shake begins at impact, not action start.

### Pickaxe Mine

- Duration: 520-620ms.
- Anticipation: tool raised overhead with both shoulders implied if no second-hand joint exists.
- Strike: vertical/diagonal downward arc; knees and torso compress.
- Impact: approximately 62-70%.
- Recovery: slower lift from the ground than axe recovery.
- Feedback: rock shake, dust, and hit sound at impact.

### Sword Slash

- Duration: 300-380ms.
- Anticipation: short draw-back.
- Strike: fast lateral arc with torso twist and one forward foot.
- Impact: approximately 42-52%.
- Recovery: guarded pose rather than dropping the sword straight down.
- Feedback: creature flash/recoil and optional short arc effect.

### Bare-Hand Gather/Interact

- Duration: 260-340ms.
- No fallback to the currently held tool unless the action explicitly requests it.
- Use reach/pull motion rather than the weapon swing.

Make action context explicit. Do not use `kind || holdKind`, because `null` can mean intentionally
unarmed rather than missing information.

## 7. Gameplay And Visual Timing

The server remains authoritative for damage and gathering. The client sends an action request with
context; local animation starts predictively. The server broadcasts an accepted animation event
with action kind and optional target.

```json
{ "t": "action", "kind": "mine", "tool": "pick", "target": 822114, "seq": 42 }
```

Remote event:

```json
{ "t": "action", "id": "p1", "kind": "mine", "tool": "pick", "target": 822114, "seq": 42 }
```

Use `seq` to ignore duplicates. Do not synchronize every pose frame. Clients deterministically play
the clip from the accepted event. If server validation rejects the action, blend the predicted clip
back to locomotion without applying target feedback.

## 8. Locomotion

### Land Idle And Walk

- Idle: subtle breathing and weight shift, not frozen limbs.
- Walk: opposing arms/legs, limited torso bob, planted-feet approximation.
- Stop blend: 100-150ms to avoid snapping rotations to zero.
- Facing changes should preserve pose and mirror cleanly.

### Swimming

Support two states:

- Tread water when velocity is near zero.
- Forward swim when moving.

Tread-water loop:

- Head and shoulders visible.
- Alternating low arm sweeps.
- Small vertical bob and water ripple.
- Legs may remain hidden below the waterline.

Forward swim loop:

- Body leans toward travel direction.
- Alternating arm reach/pull cycle.
- Smaller/faster head bob than tread water.
- Wake/ripple follows movement, not animation frame count.

Blend land to swim over 120-180ms and swim to land over 100-150ms. Hide held tools during swimming
unless an explicit water action supports them. Thermal shiver or fatigue is an additive layer and
must not replace the swim cycle.

### Boats

Boat pose starts only after server-confirmed `mode: boat`:

- Seated/braced body with legs hidden by hull.
- Low-amplitude hull bob.
- Player and hull share a visual root, while network position remains unchanged.
- Reinforced hull has heavier, slower bob.
- Add wake only while moving.
- On destruction: recoil/splash, destroy hull, blend to swim.

Remote boats must use broadcast traversal state, never water-tile inference.

## 9. Cloaks

Only the server-selected `wornGear` is visible. Add a cloak sprite/container behind torso and ahead
of rear arm as appropriate. Heat and fur cloaks use separate textures or tints. Switching cloaks
replaces the previous one; selecting the worn cloak again removes it.

Apply subtle delayed rotation based on body motion. Clamp lag so it does not detach during action
clips. Hide or reshape the cloak while swimming if the full asset creates obvious clipping.

## 10. Impact Feedback

At action impact, combine a few restrained effects:

- Target recoil/shake.
- One small dust, chip, leaf, spark, or slash effect appropriate to target.
- Correct hit sound.
- Optional 25-50ms attacker hold or slight recoil.
- Damage flash for creatures, never for harmless gather nodes.

Do not add camera shake to every action. Reserve it for heavy impacts, critical events, or large
enemy attacks. Pool particles and short-lived sprites.

## 11. Animals And Birds

Current animals interpolate as static sprites. Add lightweight walk/flee treatment:

- Horizontal facing from velocity.
- Small gait bob only while moving.
- Faster cadence while fleeing.
- Hit recoil and death fade triggered by server events.

Birds already use three-frame Phaser animations. Add occasional glide sections by pausing on a
middle frame or using a second shared animation. Seed flock phase offsets so birds do not flap in
perfect synchronization. Keep the camera-local cap and cleanup requirements from the world guide.

## 12. Performance Rules

- Do not allocate poses in the render loop.
- Reuse shared animation definitions.
- Use one state update per rig, not many permanent tweens.
- Pool particles and waterline effects.
- Keep cosmetic birds client-only while non-interactive.
- Profile four players, creatures, animals, weather, and birds simultaneously.

## 13. Phased Delivery

### Phase A: Rig Foundation

- Add `bodyRoot`, shoulder, hand, and tool grip hierarchy.
- Preserve existing `hold`, `face`, `act`, and `tick` calls through adapters.
- Build an animation lab with each tool and facing direction.

### Phase B: Action Clips

- Implement axe, pickaxe, sword, and gather clips.
- Add explicit action context.
- Align visual impact with target feedback.

### Phase C: Traversal

- Consume server-owned `land`/`swim`/`boat` state.
- Add tread water, moving swim, boat pose, transitions, wakes, and destruction transition.

### Phase D: Reactions And Cosmetics

- Hurt/recoil, cloak rendering, thermal shiver, animal gait, bird glide.

### Phase E: Tuning

- Record clips at normal and reduced frame rate.
- Verify no snapping, detached tools, hidden-arm leaks, or remote divergence.
- Measure allocations and frame time.

## 14. Acceptance Criteria

- Tool rotates around a visible hand grip through the entire clip.
- Axe, pickaxe, sword, and gather motions are visibly distinct.
- Impact feedback occurs at the clip impact frame.
- Walking continues naturally beneath upper-body actions.
- Idle and moving swimming have real loops, not head-only visibility.
- Boat pose appears only after server confirmation and is correct remotely.
- Entering/leaving water does not pop body height or reveal hidden tools.
- Cloak visuals match exactly one `wornGear` value or none.
- Four players can animate with ambient entities without sustained frame degradation.
