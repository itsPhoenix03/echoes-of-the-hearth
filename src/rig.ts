import Phaser from 'phaser';

// Procedural animated character: body parts as generated textures, code-driven
// walk cycle and action swings (no spritesheets needed).

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

export class Rig extends Phaser.GameObjects.Container {
  legL: Phaser.GameObjects.Image; legR: Phaser.GameObjects.Image;
  armL: Phaser.GameObjects.Image; armR: Phaser.GameObjects.Image;
  torso: Phaser.GameObjects.Image; head: Phaser.GameObjects.Image;
  tool: Phaser.GameObjects.Image;
  phase = 0; moving = false; acting = 0; holdKind: string | null = null; swim = false;

  shirt: number;
  constructor(scene: Phaser.Scene, x: number, y: number, shirtColor: number) {
    super(scene, x, y);
    this.shirt = shirtColor;
    const mk = (key: string, px: number, py: number, oy = 0) =>
      scene.add.image(px, py, key).setOrigin(0.5, oy);
    this.legL = mk('p-leg', -3, -11);
    this.legR = mk('p-leg', 3, -11);
    this.armL = mk('p-arm', -8, -24, 0.08);
    this.torso = mk('p-body', 0, -26, 0).setTint(shirtColor);
    this.armR = mk('p-arm', 8, -24, 0.08);
    this.head = mk('p-head', 0, -30, 0.9);
    this.tool = mk('i-axe', 8, -14, 0.9).setVisible(false);
    this.add([this.legL, this.legR, this.armL, this.torso, this.head, this.armR, this.tool]);
    scene.add.existing(this);
  }

  face(dx: number) { if (dx) this.setScale(dx < 0 ? -1 : 1, 1); }

  // persistently show a tool/weapon in hand
  hold(kind: string | null) {
    this.holdKind = kind;
    if (!this.acting) this.restTool();
  }
  private restTool() {
    this.tool.rotation = 0;
    this.tool.setPosition(8, -14);
    if (this.holdKind && !this.swim) this.tool.setTexture('i-' + this.holdKind).setVisible(true);
    else this.tool.setVisible(false);
  }

  // swimming: body submerged — only the head shows (the striking arm surfaces during actions)
  setSwim(on: boolean) {
    if (this.swim === on) return;
    this.swim = on;
    const vis = !on;
    this.legL.setVisible(vis); this.legR.setVisible(vis);
    this.torso.setVisible(vis); this.armL.setVisible(vis);
    if (!this.acting) this.armR.setVisible(vis);
    this.restTool();
  }

  // kind: 'axe' | 'pick' | 'sword' | null (bare-hand swing / falls back to held item)
  act(kind: string | null) {
    if (this.acting) return;
    this.acting = 1;
    if (this.swim) this.armR.setVisible(true);   // arm breaks the surface to strike
    kind = kind || this.holdKind;
    if (kind) this.tool.setTexture('i-' + kind).setVisible(true);
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: 320, ease: 'Sine.inOut',
      onUpdate: (tw) => {
        const v = tw.getValue();
        const swing = v < 0.4 ? -(v / 0.4) * 2.0 : -2.0 + ((v - 0.4) / 0.6) * 2.0;
        this.armR.rotation = swing;
        this.tool.rotation = swing;
        const tip = Phaser.Math.RotateAround({ x: 8, y: -12 }, 8, -23, swing);
        this.tool.setPosition(tip.x, tip.y);
      },
      onComplete: () => { this.acting = 0; this.armR.rotation = 0; if (this.swim) this.armR.setVisible(false); this.restTool(); }
    });
  }

  // hurt pose: torso/head rotate away from hit, tint 80 ms (Guide §2.4)
  hurt(ang: number) {
    const dir = Math.cos(ang) < 0 ? 1 : -1;
    const parts = [this.torso, this.head, this.armL, this.armR, this.legL, this.legR];
    parts.forEach((p) => p.setTintFill(0xff6666));
    // clearTint would wipe the torso's shirt-color tint (body texture is white) — restore it
    setTimeout(() => { parts.forEach((p) => p.clearTint()); this.torso.setTint(this.shirt); }, 80);
    const origTR = this.torso.rotation, origHR = this.head.rotation;
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: 200, ease: 'Sine.out',
      onUpdate: (tw) => {
        const v = tw.getValue();
        const lean = -0.35 * dir * (1 - v);
        this.torso.rotation = origTR + lean;
        this.head.rotation = origHR + lean;
      },
      onComplete: () => { this.torso.rotation = origTR; this.head.rotation = origHR; }
    });
  }

  tick(dt: number) {
    if (this.moving) {
      this.phase += dt * 11;
      const s = Math.sin(this.phase);
      this.legL.rotation = s * 0.55; this.legR.rotation = -s * 0.55;
      this.armL.rotation = -s * 0.4;
      if (!this.acting) this.armR.rotation = s * 0.4;
      this.torso.y = -26 + Math.abs(Math.cos(this.phase)) * -1.5;
      this.head.y = -30 + Math.abs(Math.cos(this.phase)) * -1.5;
    } else {
      this.legL.rotation *= 0.8; this.legR.rotation *= 0.8; this.armL.rotation *= 0.8;
      if (!this.acting) this.armR.rotation *= 0.8;
      this.torso.y = -26; this.head.y = -30;
    }
  }
}
