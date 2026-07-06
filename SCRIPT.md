# Echoes of the Hearth — Game Script

Narrative script for the full game. Text in `"quotes"` is player-facing copy, ready to wire
into `showMsg`, cutscene cards, or NPC dialogue (see `shared/dialogue.js` for the line banks).

---

## Cold Open (first join, before control is given)

> *Black screen. A slow heartbeat. Text fades in, line by line:*
>
> "The world was called The Hearth, because it kept everyone warm."
> "Then something cold arrived from between the stars, and began to eat."
> "The old ones built a cure — four singing stones and an engine at the heart of the sea —"
> "— and died before they could turn the key."
> "You are a Keeper. You are the hands they never had."
>
> *Fade up on the Whispering Woods shore. HUD appears.*
> **"Survive. Search. Sing the world awake."**

## Act I — The Whispering Woods (Era 1, Easy)

**Goal beats:** shelter → workbench → tools → campfire → survive first Blight Storm → find Note #1.

- On first tree chopped: "The forest gives. Remember to give back — bare ground turns to mire."
- On first night: "The light goes purple. This is not dusk. This is *attention*."
- On first ecosystem collapse (mud spread): "You took too much, too fast. The soil sours beneath you. The Hearth keeps score."
- On finding Note #1 (trader's journal): *(see NOTE_DEFS in src/main.ts — points east to the Dunes, whispers of starmetal)*
- Meeting the survivors (villager camp, future NPC feature): Elder Yvenne gives the SHAMAN_HINTS chain, one per conversation.
- Act I closes when the player launches their first boat: "The sea is a door. The notes are the key. Sail east, Keeper."

## Act II — The Sinking Dunes (Era 2, Medium)

**Goal beats:** survive the heat (Heat Cloak) → boulders/stone economy → sandstorms → Note #2 → first starmetal.

- First landfall: "Golden dunes to the horizon. The heat here has teeth — cover yourself, or dig your grave in gold."
- First sandstorm: "The desert stands up and walks. Put a wall between you and its breath."
- First starmetal sighted: "Something glitters in the rock — metal that fell burning from the sky. The frozen isle's toll."
- Note #2 found: points due south to the Marsh.

## Act III — The Blighted Marsh (Era 2.5)

**Goal beats:** mud movement, toads, marsh crystal, wisps thicken, Note #3.

- First landfall: "The earth breathes here. What you smell is the Blight, digesting."
- First wisp seen up close: "A pale light drifts over the bog, and where it passes, the ground forgets what it was."
- Note #3 found: points west — the Spire, its ice teeth, and the fallen-star hull.

## Act IV — The Frozen Spire (Era 3, Hard)

**Goal beats:** reinforced boat gauntlet → cold (Fur Cloak) → blizzards → crystal mining → Aether Forge → Note #4.

- Iceberg field approach (wooden boat destroyed): "Matchwood. The sea keeps your boat as a lesson. Bind the next hull in fallen stars."
- Reinforced boat smashing a berg: "The star-bound hull sings and the ice yields. The Spire watches you come."
- First landfall: "White silence. Even the Blight whispers here."
- First crystal mined: "The ice holds light the way the world used to. This is what the Cores are made of."
- Forge built: "The Aether Forge breathes its first teal breath. Crystal and essence, married into song."
- Note #4 found: reveals the Core — "a wound in the heart of the sea, equally far from every shore."

## Act V — The Choir (Era 3.5)

**Goal beats:** hunt for essence, forge 4 Monolith Cores, awaken all Monoliths. Difficulty scales with each.

- Monolith 1 awakened: *(EVENT_LINES.firstMonolith)* — "One song returns. The ground listens. So does IT."
- Monoliths 2–3: "Another voice joins the choir. Far away, something turns in its sleep." / "Three songs. The nights grow claws — siege-beasts walk."
- Monolith 4: *(EVENT_LINES.allMonoliths)* — "The choir is whole. Now the wound. Now the Engine. Now the end, one way or the other."

## Act VI — The Core Void (Era 4, Extreme)

**The Final Ritual.**

- First landfall on the Core island: "Calcified ground. No wind. This is the inside of its mouth."
- World Engine placed: "The Engine drinks the four songs and begins to turn — and every eye the Blight owns opens at once."
- Wave defense (240s), timed barks at 180/120/60/10s:
  - "Three minutes. They come in waves. So do you — rally, rebuild, hold."
  - "Two minutes. The choir is louder than the screaming. Keep it that way."
  - "One minute. Everything it has left. Everything you have left."
  - "TEN SECONDS. HOLD. HOLD. HOLD—"
- **If the Engine falls:** "Silence. The songs scatter... but the Monoliths still stand, and so do you. Rebuild the Engine. Finish it."
- **Victory:** *(fade to white, heartbeat slows and steadies)*
  - "The scream ends. The sky exhales."
  - "Across four islands, four stones sing morning back into the world."
  - "The Hearth is warm again. It remembers who lit it."
  - **"THE BLIGHT IS PURGED — the Keepers win."**
  - *Epilogue card:* "Green returns to the mud. The wisps dissolve like bad dreams. Somewhere beneath the waves, something colder than the space between stars closes its one remaining eye — and waits. (Thank you for playing.)"

---

## Implementation notes for agents

- Line banks live in `shared/dialogue.js` (`BARKS`, `EVENT_LINES`, `SHAMAN_HINTS`, `NPCS`).
- NPC sprites ready in `assets/sprites/`: `villager.svg`, `villager2.svg` (forager), `tribal.svg`
  (Ashmark hunter with spear), `shaman.svg` (Elder Yvenne, masked, glowing staff).
- Suggested wiring: spawn a small survivor camp near the Woods spawn (villagers + Yvenne),
  an Ashmark tribal camp on the Marsh island (hunters patrol, trade meat/essence). E to talk:
  villagers/hunters → random `BARKS`; Yvenne → next `SHAMAN_HINTS` entry (track per player profile).
  Event lines hook into existing broadcasts: `wx`, `mono`, `wave`, `win`, night transitions.
- The cold open fits the existing `showMsg` toast at reduced pace, or a simple DOM overlay
  dismissed on keypress (add to `index.html` + `ui.ts`).
