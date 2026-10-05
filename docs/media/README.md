# README media

The stills, clips and videos in the top-level [README](../../README.md) are real
gameplay, recorded by [`tools/media/capture.mjs`](../../tools/media/capture.mjs). It
drives a session in headless Chrome over the DevTools protocol: it joins the world as
a dev player, then plays scripted scenes (teleports, time of day, weather, spawned
enemies, held movement keys) while recording.

| File | What it is |
| --- | --- |
| `*.webp` (stills) | full-screen screenshots, HUD included |
| `*.webp` (clips) | animated WebP, 640×360 at ~10 fps, the keeper-centred middle of the game canvas. Plays inline on GitHub. |
| `*.mp4` | H.264 recording of the whole game canvas (960×540, 30 fps) |

## Regenerating

Record against a **throwaway stack**: the script builds, spawns enemies and changes the
weather in whatever world it joins. Run it on its own ports with a copy of a save.

```bash
# 1. a scratch copy of the world, marked won so no wild creatures wander into shots
#    (dev-spawned ones still appear)
cp gameserver/world.default.save.json /tmp/media.save.json   # then set "won": true in it

# 2. the stack, on spare ports (three terminals)
CONTROL_PORT=8190 HEARTH_DEV_ALL=1 HEARTH_GAME_WS=ws://localhost:8182 node control/index.js
cd gameserver && HEARTH_GAME_PORT=8182 HEARTH_PUBKEY_URL=http://localhost:8190/api/pubkey \
  HEARTH_SAVE_PATH=/tmp/media.save.json HEARTH_EAGER_WORLDS=1 HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd
VITE_CONTROL_URL=http://localhost:8190 npx vite --port 5273 --strictPort

# 3. record (all scenes, or a few)
node tools/media/capture.mjs
node tools/media/capture.mjs --only camp,bridge
node tools/media/capture.mjs --list
```

`HEARTH_DEV_ALL=1` gives loopback clients the dev claim the scenes need (`devcmd` for
teleport, time, weather and spawning). The script uses `window.__hearth`, a hook that
exists only on the Vite dev server, so it can't run against a production build.
Scene coordinates are for the default seed `hearth-1`. Notes:

- The client only snaps to a server position correction of 3 tiles or more, so
  `goTo` hops away first when the target is close.
- The dev teleport refuses water tiles, bridged or not.
- The movement keys are screen directions: `S`+`A` together walks +y on the map.

Set `CHROME=` if Chrome isn't at the default Windows path.
