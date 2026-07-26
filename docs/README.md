# Echoes of the Hearth Implementation Guide Set

This directory holds implementation documentation plus staged source art awaiting integration.
Runtime assets live in the game repository under `assets/` (configured as Vite's `publicDir`), with
source code under `src/`, `shared/`, and `server/`. Do not configure Vite or Phaser to load files
from `../assets`; the `sprites/` folder here (currently `medic.svg`, `medic_snow.svg`, and
`medicine.svg` for guide 05) is a staging area whose files must be copied into the repository's
`assets/sprites/` when their feature phase is implemented.

These guides describe the next implementation work after review of commit `5e792c7`. The current
feature work is phased: an item described here is not necessarily absent, and an existing first
pass is not necessarily complete. Before changing code, compare the documented current state with
the branch being edited.

## Documents

1. `01_TRAVERSAL_AND_THERMAL_AUTHORITY.md`
   - Manual boat selection and authoritative launch state.
   - Swimming, remote traversal rendering, reconnect state, iceberg handling, and water damage.
   - Message contracts and server/client implementation examples.
2. `02_WORLD_LANDMARK_AND_GENERATION_FIXES.md`
   - Mountain and temple footprints.
   - Minor-island resource restrictions.
   - Core lava vents, regional birds, coordinate validation, and save compatibility.
   - Decor texture manifest coverage and regression checks for the restored `ice_crystal_cluster` entry.
3. `03_ANIMATION_IMPLEMENTATION_GUIDE.md`
   - A detailed replacement for the current arm/tool swing.
   - Rig hierarchy, grip points, action clips, locomotion, swimming, boats, impacts, and networking.
4. `04_TESTING_AND_PHASED_ROLLOUT.md`
   - Automated tests, deterministic world checks, browser test matrix, metrics, and rollout gates.
5. `05_MEDICINE_AND_MEDIC_HEALING_GUIDE.md`
   - Three-HP medicine consumables and full-health medic treatment.
   - Two deterministic medics (lowlands and Frozen Spire) and island-valid randomized bargains.
   - Assets, protocol, server authority, UI, persistence, balancing, tests, and rollout phases.
6. `06_DAMAGE_DEATH_AND_RESPAWN_FIX_GUIDE.md`
   - Hardens the now-fixed immortal one-HP thermal-water path against regressions.
   - Central damage/healing APIs and explicit death/respawn protocol.
   - Every damage source, client feedback, medicine interaction, regression tests, and rollout phases.
7. `07_REMAINING_IMPLEMENTATION_ROADMAP.md`
   - Commit-pinned audit of what is implemented, partial, and still missing across guides 01-06.
   - Current dependency order, code-level remaining work, and release gates.
   - Use this as the first document for future implementation agents.
8. `08_CODE_IMPLEMENTATION_SNIPPETS.md`
   - Implementation-ready scaffolds matched to the current server, shared world, Phaser client, and tests.
   - Covers traversal, health, landmarks, saves, generation, medicine, medics, animation, and protocol wiring.
   - Read after guide 07 and adapt each snippet alongside the detailed feature guide.

## Priority Order

Implement in this order because later visual work depends on correct authoritative state:

1. Validate coordinates and add server-owned traversal state.
2. Centralize damage/death/respawn and fix lethal thermal water.
3. Broadcast traversal state and repair remote rendering.
4. Correct thermal exposure cadence and boat hazards.
5. Make landmark footprints authoritative and correct world generation.
6. Add medicine as an explicit recovery path, then add static medics and bargaining.
7. Add tests and deterministic metrics before tuning map content.
8. Replace player action and locomotion animation incrementally.
9. Add polish such as wakes, splashes, bird glides, medic treatment, and environmental particles.

## Definition Of Done

A phase is complete only when all of the following are true:

- The server validates gameplay-affecting state instead of trusting a client visual flag.
- Local and remote clients render the same accepted state.
- Reconnect/init snapshots contain enough state to reconstruct the current mode.
- Deterministic world generation gives identical results for the same seed.
- Automated tests cover rejection paths, not only successful behavior.
- `npm run build` and the server integration test pass from a clean checkout.
- Manual checks are recorded for animation and visual behavior that cannot be asserted reliably.

## Explicit Non-Goals

The multiplayer room/Postgres/Redis architecture, start screen, global chat, and four-player world
session system remain separate architecture work. Do not silently introduce those systems while
fixing traversal, healing, or animation. Keep protocol changes forward-compatible, but avoid
coupling this fix set to an unfinished room service.
