# Modular building materials

These SVGs are optional construction assets for player-authored structures. They are split into two groups:

- Raw material icons: `wood_planks`, `stone_blocks`, `clay_bricks`, `reed_thatch`, `iron_beam`, `crystal_lattice`, `starmetal_plate`, `rope_coil`, `cloth_roll`, `glass_pane`.
- Placeable modules: `mod_floor_*`, `mod_wall_*`, `mod_roof_*`, `mod_window`, `mod_door`, `mod_stairs`, `mod_pillar_*`, `mod_railing`, `mod_arch`, `mod_bridge_segment`, `mod_banner_blank`, `mod_lantern_hook`.

Integration idea: treat module placement like existing `build` messages, but store `{i, kind, dir, variant, tint?}` so players can compose floors, walls, roofs, doors, windows, and trim from reusable pieces. Server should still validate inventory cost, distance, collision, and persistence.