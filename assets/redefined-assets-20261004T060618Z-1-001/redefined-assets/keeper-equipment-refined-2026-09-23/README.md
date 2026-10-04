# Keeper weapons and clothing art batch

Replacement-ready item files: `sprites/fur_cloak.svg` (38×46), `heat_cloak.svg` (38×46), `keeper_hat.svg` (42×28). Same names and dimensions as current items. Original art copies are in `before/`.

Five optional tool SVGs match the procedural rig texture sizes: `i-axe` 14×16, `i-pick`/`i-spick` 16×16, `i-sword` 8×20, `i-isword` 8×22. They are art replacements for code-generated textures, not currently loaded.

Aligned 32×48 keeper overlays: 30 cloak motion overlays (fur/heat, idle/active/sit/swim/shiver, three phases); one worn hat; five held idle weapons; 15 held-action weapons. Six clean keeper action frames and one idle frame are in `poses/` to enable layering without old drawn props. All overlays use the keeper's 32×48 viewBox and can be mirrored with him. Layer order: keeper pose → cloak overlay → held weapon overlay → optional hat.

The running game uses `src/rig.ts` generated part/tool textures and does not currently display worn cloaks on the keeper. Art alone cannot change that behavior. No codebase files were changed.
