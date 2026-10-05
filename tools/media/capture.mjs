// README media capture — stills, animated WebP clips and MP4 videos of the game.
//
//   node tools/media/capture.mjs [--url http://localhost:5273] [--only name,name] [--list]
//
// Drives a real game session in headless Chrome over the DevTools protocol:
// joins the world as a dev player (the stack must run with HEARTH_DEV_ALL=1 so
// loopback clients get the dev claim), then plays scripted scenes — teleports,
// time of day, weather, spawned enemies, held movement keys — while it records.
//
// Each clip produces two files in docs/media/:
//   <name>.webp  animated WebP of the whole screen (HUD included), assembled here
//                from Chrome's own WebP screenshots — plays inline in a README
//   <name>.mp4   the game canvas recorded by the page's MediaRecorder (WebM when
//                the browser cannot encode MP4)
// Stills are single WebP screenshots.
//
// Point it at a THROWAWAY stack — it plays in the world it joins. The dev hook it
// uses (window.__hearth) only exists on the Vite dev server. See docs/media/README.md.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'docs/media');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_BASE = arg('--url', 'http://localhost:5273');
const ONLY = arg('--only', '') ? new Set(arg('--only').split(',')) : null;
const W = 960, H = 540;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── animated WebP from still WebP frames ────────────────────────────────────
// A still from Chrome is RIFF/WEBP holding either a bare 'VP8 ' / 'VP8L' chunk or
// 'VP8X' + optional 'ALPH' + bitstream. An animation is RIFF/WEBP + VP8X (animation
// flag) + ANIM + one ANMF per frame wrapping that frame's ALPH/VP8/VP8L chunks.
function chunks(buf) {
  const out = [];
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
    out.push({ id, data: buf.subarray(o + 8, o + 8 + size), raw: buf.subarray(o, o + 8 + size + (size & 1)) });
    o += 8 + size + (size & 1);
  }
  return out;
}
const u24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
function chunk(id, data) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function animatedWebp(frames, w, h) {
  let alpha = false;
  const anmf = frames.map(({ buf, ms }) => {
    const body = chunks(buf).filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
    if (body.some((c) => c.id === 'ALPH' || c.id === 'VP8L')) alpha = true;
    const head = Buffer.concat([u24(0), u24(0), u24(w - 1), u24(h - 1), u24(Math.max(20, Math.round(ms))), Buffer.from([0])]);
    return chunk('ANMF', Buffer.concat([head, ...body.map((c) => c.raw)]));
  });
  const vp8x = Buffer.concat([Buffer.from([0x02 | (alpha ? 0x10 : 0), 0, 0, 0]), u24(w - 1), u24(h - 1)]);
  const anim = Buffer.from([0, 0, 0, 0, 0, 0]); // background, loop forever
  const payload = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmf]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}

// ── a minimal CDP client ────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.wait.has(m.id)) {
        const { ok, err } = this.wait.get(m.id);
        this.wait.delete(m.id);
        m.error ? err(new Error(m.error.message)) : ok(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, err) => this.wait.set(id, { ok, err }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// ── the game session ────────────────────────────────────────────────────────
const KEYS = { w: 87, a: 65, s: 83, d: 68, e: 69, f: 70, t: 84, z: 90, ' ': 32, 1: 49, 2: 50, 3: 51, 4: 52, 5: 53 };
class Session {
  constructor(cdp) { this.cdp = cdp; }
  ev(js) { return this.cdp.eval(js); }
  dev(cmd) { return this.ev(`__hearth.send(${JSON.stringify({ t: 'devcmd', ...cmd })})`); }
  tp(x, y) { return this.dev({ cmd: 'tp', x, y }); }
  time(v) { return this.dev({ cmd: 'time', v }); }
  weather(kind) { return this.dev({ cmd: 'wx', kind }); }
  spawnCre(type, n = 1) { return Promise.all(Array.from({ length: n }, () => this.dev({ cmd: 'spawn', type }))); }
  clearCre() { return this.dev({ cmd: 'clearcre' }); }
  async key(k, type) {
    const code = KEYS[k];
    const key = k === ' ' ? ' ' : k;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type, key, code: k === ' ' ? 'Space' : /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
  }
  /** Hold one key, or several together ('sa' = screen down-left, i.e. +y on the map). */
  async hold(k, ms) {
    const ks = k.length > 1 && !/\d/.test(k) ? [...k] : [k];
    for (const c of ks) await this.key(c, 'keyDown');
    await sleep(ms);
    for (const c of ks) await this.key(c, 'keyUp');
  }
  async tap(k) { await this.hold(k, 60); }
  /** Walk a path of [key, ms] legs. */
  async walk(legs) { for (const [k, ms] of legs) await this.hold(k, ms); }
  kit() { return this.ev(`__hearth.send({ t: 'dev' })`); }
  buildMod(x, y, kind, slot) { return this.ev(`__hearth.send({ t: 'buildmod', i: ${y * 1280 + x}, kind: '${kind}', slot: '${slot}', dir: 0, seq: Date.now() % 1e6 })`); }
  build(x, y, kind) { return this.ev(`__hearth.send({ t: 'build', i: ${y * 1280 + x}, kind: '${kind}', dir: 0 })`); }
  shot() { return this.cdp.send('Page.captureScreenshot', { format: 'webp', quality: 70 }).then((r) => Buffer.from(r.data, 'base64')); }
}

async function launch() {
  const profile = resolve(tmpdir(), `hearth-capture-${Date.now()}`);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('chrome did not come up');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((ok, err) => { ws.once('open', ok); ws.once('error', err); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  return { cdp, close: () => { try { ws.close(); } catch {} chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500); } };
}

async function join(s, name) {
  await s.cdp.send('Page.navigate', { url: `${URL_BASE}/?name=${encodeURIComponent(name)}` });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await s.ev(`!!document.getElementById('menu-join-solo')`).catch(() => false)) break;
  }
  // the menu asks for a profile name first; give it one, then pick the default
  // world — re-clicking until the scene exists (the menu wires its buttons late)
  await s.ev(`localStorage.setItem('hearth-name', ${JSON.stringify(name)}); localStorage.removeItem('hearth-room')`);
  for (let i = 0; i < 150; i++) {
    if (i % 15 === 0 && !(await s.ev(`!!window.__hearth`).catch(() => false)))
      await s.ev(`document.getElementById('menu-join-solo')?.click()`).catch(() => {});
    await sleep(200);
    if (await s.ev(`!!(window.__hearth && __hearth.ready && __hearth.me)`).catch(() => false)) {
      await s.ev(HELPERS);
      return;
    }
  }
  writeFileSync(resolve(OUT, '_debug.webp'), await s.shot());
  const state = await s.ev(`JSON.stringify({ hook: !!window.__hearth, ready: window.__hearth?.ready, me: !!window.__hearth?.me, body: document.body.innerText.slice(0, 300) })`).catch((e) => String(e));
  throw new Error(`never entered the world (is the stack running with HEARTH_DEV_ALL=1?) ${state}`);
}

// Page-side helpers the scenes lean on: tile and node lookups against the
// client's own streamed world.
const HELPERS = `document.head.insertAdjacentHTML('beforeend', '<style>#msg{visibility:hidden!important}</style>');
window.__cap = {
  S: 1280,
  tile(x, y) { return __hearth.world.tiles[y * 1280 + x]; },
  /** nearest live node of a kind byte (0 tree, 1 bush, 2 stone ...) to (x, y) */
  nearestNode(x, y, kind) {
    let best = -1, bd = 1e9;
    for (const i of __hearth.nodeSpr.keys()) {
      if (__hearth.world.nodes.get(i) !== kind) continue;
      const d = Math.hypot(i % 1280 - x, ((i / 1280) | 0) - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? null : [best % 1280, (best / 1280) | 0];
  },
  map(x0, y0, x1, y1) {
    const rows = [];
    for (let y = y0; y <= y1; y++) {
      let r = String(y).padStart(5) + ' ';
      for (let x = x0; x <= x1; x++) {
        const i = y * 1280 + x, t = __hearth.world.tiles[i];
        r += __hearth.bridgeAt(i) ? '=' : __hearth.structSpr.has(i) ? '#' : __hearth.medicBlock.has(i) ? 'M'
          : t === 255 ? '?' : t === 4 ? '~' : __hearth.nodeSpr.has(i) ? 'T' : '.';
      }
      rows.push(r);
    }
    return rows.join('\\n');
  },
};`;

// ── recording ───────────────────────────────────────────────────────────────
// Both recorders live in the page and read the game canvas itself (no HUD):
//  - frames for the animated WebP are grabbed on Phaser's postrender, while the
//    WebGL drawing buffer is still valid, downscaled and WebP-encoded by Chrome;
//  - the video is the canvas stream through MediaRecorder.
const CW = 640, CH = 360, CLIP_FPS = 10;

async function startRecording(s, video) {
  return s.ev(`(() => {
    const game = __hearth.game, src = game.canvas;
    const pad = document.createElement('canvas');
    pad.width = ${CW}; pad.height = ${CH};
    const ctx = pad.getContext('2d');
    const r = { frames: [], last: 0, video: null };
    r.grab = () => {
      const now = performance.now();
      if (now - r.last < ${1000 / CLIP_FPS} - 4) return;
      if (r.frames.length) r.frames[r.frames.length - 1].ms = now - r.last;
      r.last = now;
      ctx.drawImage(src, 160, 90, 640, 360, 0, 0, ${CW}, ${CH}); // the keeper-centred middle, 1:1
      r.frames.push({ url: pad.toDataURL('image/webp', 0.55), ms: ${1000 / CLIP_FPS} });
    };
    game.events.on('postrender', r.grab);
    if (${video}) {
      const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
      const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(src.captureStream(30), { mimeType: mime, videoBitsPerSecond: 1_600_000 });
      const parts = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.start(250);
      r.video = { rec, parts, mime };
    }
    window.__rec = r;
    return true;
  })()`);
}

async function stopRecording(s) {
  return s.ev(`new Promise((done) => {
    const r = window.__rec;
    __hearth.game.events.off('postrender', r.grab);
    const frames = r.frames.map((f) => ({ b64: f.url.slice(f.url.indexOf(',') + 1), ms: f.ms }));
    if (!r.video) return done({ frames });
    const { rec, parts, mime } = r.video;
    rec.onstop = async () => {
      const buf = new Uint8Array(await new Blob(parts, { type: mime }).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      done({ frames, mime, b64: btoa(bin) });
    };
    rec.stop();
  })`);
}

/** Record `ms` of play as an animated WebP (+ a video) while `act` runs. */
async function clip(s, name, ms, act, { video = true } = {}) {
  await startRecording(s, video);
  const t0 = Date.now();
  await act();
  const left = ms - (Date.now() - t0);
  if (left > 0) await sleep(left);
  const r = await stopRecording(s);
  const frames = r.frames.map((f) => ({ buf: Buffer.from(f.b64, 'base64'), ms: f.ms }));
  const webp = animatedWebp(frames, CW, CH);
  writeFileSync(resolve(OUT, `${name}.webp`), webp);
  let vid = '';
  if (r.b64) {
    const ext = r.mime.includes('mp4') ? 'mp4' : 'webm';
    const buf = Buffer.from(r.b64, 'base64');
    writeFileSync(resolve(OUT, `${name}.${ext}`), buf);
    vid = ` + ${name}.${ext} ${(buf.length / 1e6).toFixed(1)} MB`;
  }
  console.log(`  ${name}.webp  ${frames.length} frames, ${(webp.length / 1e6).toFixed(2)} MB${vid}`);
}

async function still(s, name) {
  const buf = await s.shot();
  writeFileSync(resolve(OUT, `${name}.webp`), buf);
  console.log(`  ${name}.webp  still, ${(buf.length / 1e3).toFixed(0)} kB`);
}

/** Teleport, then give the chunks and sprites a moment to stream in. */
async function goTo(s, x, y, settle = 2200) {
  // the client only snaps to a server correction of 3+ tiles: hop away first
  const at0 = await s.ev(`[__hearth.px, __hearth.py]`);
  if (Math.hypot(at0[0] - x, at0[1] - y) < 4) { await s.tp(x + 12, y); await sleep(400); }
  for (let attempt = 0; attempt < 4; attempt++) {
    await s.tp(x, y);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const at = await s.ev(`[__hearth.px, __hearth.py]`);
      if (Math.hypot(at[0] - x, at[1] - y) < 2) { await sleep(settle); return; }
    }
  }
  const at = await s.ev(`JSON.stringify({ px: __hearth.px, py: __hearth.py, z: __hearth.z, hp: __hearth.hp, sail: __hearth.sailing, swim: __hearth.swimming })`);
  throw new Error(`teleport to ${x},${y} never landed: ${at}`);
}

// ── the scenes ──────────────────────────────────────────────────────────────
// Coordinates are for seed hearth-1 (the default world).
const SCENES = {
  // ── stills: the hero shot and the four islands ───────────────────────────
  async hero(s) {
    await s.time(0.42);
    await goTo(s, 176, 187, 3000);
    await still(s, 'hero');
  },
  async biomes(s) {
    await s.time(0.45);
    for (const [name, x, y] of [['biome-woods', 186, 160], ['biome-dunes', 1100, 172], ['biome-spire', 176, 1092], ['biome-marsh', 1104, 1095]]) {
      await goTo(s, x, y, 3200);
      await still(s, name);
    }
  },
  async medic(s) {
    await s.time(0.45);
    await goTo(s, 191, 173, 3000);
    await still(s, 'medic');
  },

  // ── clips ────────────────────────────────────────────────────────────────
  async explore(s) {
    await s.time(0.4);
    await goTo(s, 182, 168, 3000);
    await clip(s, 'explore', 7000, () => s.walk([['s', 1600], ['d', 1400], ['s', 1200], ['a', 1300], ['w', 900]]));
  },
  async gather(s) {
    await s.time(0.42);
    await goTo(s, 186, 160, 2500);
    const t = await s.ev(`__cap.nearestNode(186, 160, 0)`);
    await goTo(s, t[0] - 1, t[1], 2500);
    await s.tap('1'); // the axe
    await clip(s, 'gather', 6500, async () => {
      for (let k = 0; k < 7; k++) { await s.tap('e'); await sleep(620); }
      await s.walk([['d', 700]]);
    });
  },
  async build(s) {
    await s.time(0.44);
    await goTo(s, 180, 148, 2500);
    await clip(s, 'build', 8000, async () => {
      for (let y = 145; y <= 147; y++) for (let x = 181; x <= 183; x++) { await s.buildMod(x, y, 'mod_floor_wood', 'floor'); await sleep(170); }
      for (const [x, y] of [[181, 144], [182, 144], [183, 144], [184, 145], [184, 146], [184, 147]]) { await s.buildMod(x, y, 'mod_wall_stone', 'wall'); await sleep(220); }
      await s.build(179, 147, 'campfire');
      await sleep(400);
      await s.build(179, 145, 'workbench');
    });
  },
  async daynight(s) {
    await goTo(s, 180, 148, 2500);
    await s.build(179, 147, 'campfire');
    await clip(s, 'daynight', 8000, async () => {
      for (let k = 0; k <= 26; k++) { await s.time(0.6 + k * 0.012); await sleep(280); }
    });
  },
  async rain(s) {
    await s.time(0.5);
    await goTo(s, 184, 175, 2500);
    await s.weather('rain');
    await sleep(1500);
    await clip(s, 'rain', 6000, () => s.walk([['d', 1500], ['s', 1500], ['a', 1500]]));
    await s.weather(null);
  },
  async blizzard(s) {
    await s.time(0.5);
    await goTo(s, 176, 1092, 3000);
    await s.weather('snowstorm');
    await sleep(1800);
    await clip(s, 'blizzard', 6000, () => s.walk([['s', 1800], ['d', 1800]]));
    await s.weather(null);
  },
  async sandstorm(s) {
    await s.time(0.5);
    await goTo(s, 1100, 172, 3000);
    await s.weather('sandstorm');
    await sleep(1800);
    await clip(s, 'sandstorm', 6000, () => s.walk([['a', 1800], ['s', 1800]]));
    await s.weather(null);
  },
  async hunt(s) {
    await s.time(0.86);
    await goTo(s, 186, 160, 2500);
    await s.tap('4'); // sword
    await s.spawnCre('husk_wolf', 3);
    await s.spawnCre('crawler', 3);
    await s.spawnCre('stalker', 1);
    await sleep(600);
    await clip(s, 'night-hunt', 9000, async () => {
      for (let k = 0; k < 10; k++) { await s.tap('f'); await sleep(260); }
      await s.walk([['a', 900]]);
      for (let k = 0; k < 8; k++) { await s.tap('f'); await sleep(280); }
      await s.walk([['s', 900]]);
    });
    await s.clearCre();
  },
  async enemies(s) {
    await s.time(0.7);
    await goTo(s, 186, 160, 2500);
    for (const t of ['brute', 'blight_lancer', 'bog_shambler', 'drowned', 'wisp', 'frost_wraith', 'stalker', 'husk_wolf', 'crawler']) await s.spawnCre(t);
    await sleep(2500);
    await clip(s, 'enemies', 6000, () => s.walk([['a', 1200], ['w', 1200], ['d', 1200]]));
    await s.clearCre();
  },
  async bridge(s) {
    await s.time(0.45);
    await goTo(s, 153, 185, 3000);
    // finish the span (the save has gaps in it): north to south, each segment
    // anchored on the last
    for (let y = 187; y <= 194; y++) for (let x = 152; x <= 154; x++) { await s.buildMod(x, y, 'mod_bridge_segment', 'floor'); await sleep(60); }
    await goTo(s, 153, 186, 1500); // the shore tile at the north end (tp refuses water, bridged or not)
    // the chasers must start on the north shore, behind the keeper — a crawler
    // that lands ahead would knock it off the deck. Re-roll until they do.
    for (let tries = 0; tries < 10; tries++) {
      await s.clearCre();
      await sleep(300);
      await s.spawnCre('crawler', 3);
      await sleep(700);
      const ys = await s.ev(`[...__hearth.creSpr.values()].map((c) => c.getData('cy'))`);
      if (ys.length >= 2 && ys.every((y) => y < 185)) break;
    }
    // straight down the deck (+y on the map is screen down-left), crawlers behind
    await clip(s, 'bridge-chase', 8000, async () => {
      await s.walk([['sa', 2200]]);
      await s.walk([['s', 500]]);
      await sleep(1500);
    });
    await s.clearCre();
  },
  async camp(s) {
    await s.time(0.45);
    await goTo(s, 178, 188, 3500);
    await sleep(2500);
    await clip(s, 'camp', 9000, async () => {
      await s.walk([['a', 700]]);
      await s.tap('e');
      await sleep(2600);
      await s.spawnCre('crawler', 2);
      await sleep(4000);
    });
    await s.clearCre();
  },
  async swim(s) {
    await s.time(0.42);
    await goTo(s, 176, 150, 2500);
    await s.tap('4');
    await clip(s, 'swim', 6500, async () => {
      await s.walk([['a', 2200]]);
      for (let k = 0; k < 3; k++) { await s.tap('f'); await sleep(450); }
      await s.walk([['s', 1200]]);
    });
  },
  async mines(s) {
    await s.time(0.45);
    await goTo(s, 188, 1117, 3000);
    await s.tap('e'); // down the shaft
    await sleep(2500);
    await clip(s, 'mines', 7000, async () => {
      await s.walk([['s', 1200], ['d', 1200]]);
      await s.tap('t');
      await sleep(900);
      await s.walk([['w', 1200], ['a', 1200]]);
    });
    await s.tap('e');
    await sleep(1500);
  },

  // ── tooling ──────────────────────────────────────────────────────────────
  async probe(s) {
    await goTo(s, 168, 168);
    await still(s, 'probe');
  },
  async survey(s) {
    await s.time(0.35);
    for (const [label, x, y, r] of (process.env.SURVEY ? JSON.parse(process.env.SURVEY) : [['bridge', 152, 190, 9], ['woods camp', 173, 188, 7], ['woods spot', 175, 150, 6]])) {
      await goTo(s, x, y, 2500);
      console.log(`${label}\n${await s.ev(`__cap.map(${x - r}, ${y - r}, ${x + r}, ${y + r})`)}`);
    }
  },
  async keytest(s) {
    await s.time(0.45);
    for (const k of ['s', 'a', 'sa', 'd', 'w']) {
      await goTo(s, 186, 160, 1200);
      const a0 = await s.ev(`[__hearth.px, __hearth.py]`);
      await s.hold(k, 800);
      await sleep(200);
      const a1 = await s.ev(`[__hearth.px, __hearth.py]`);
      console.log(`  ${k}: dx ${(a1[0] - a0[0]).toFixed(2)} dy ${(a1[1] - a0[1]).toFixed(2)}`);
    }
  },
  async fps(s) {
    await s.time(0.35);
    await goTo(s, 175, 150);
    await sleep(1500);
    console.log('  fps', await s.ev(`__hearth.game.loop.actualFps.toFixed(1) + ' renderer=' + __hearth.game.renderer.type + ' canvas=' + __hearth.game.canvas.width + 'x' + __hearth.game.canvas.height + ' css=' + __hearth.game.canvas.clientWidth + 'x' + __hearth.game.canvas.clientHeight + ' zoom=' + __hearth.cameras.main.zoom + ' dpr=' + devicePixelRatio`));
  },
  async probeclip(s) {
    await s.time(0.35);
    await goTo(s, 175, 150);
    await clip(s, 'probeclip', 4000, () => s.walk([['d', 1500], ['s', 1500], ['a', 900]]));
  },
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const TOOLING = new Set(['probe', 'probeclip', 'fps', 'survey', 'keytest']);
  const names = Object.keys(SCENES).filter((n) => (ONLY ? ONLY.has(n) : !TOOLING.has(n)));
  if (args.includes('--list')) { console.log(Object.keys(SCENES).join('\n')); return; }
  const { cdp, close } = await launch();
  const s = new Session(cdp);
  try {
    await join(s, 'Lumen');
    await s.dev({ cmd: 'god' });
    await s.kit();
    for (const n of names) {
      console.log(`scene ${n}`);
      await s.clearCre();
      await SCENES[n](s);
    }
  } finally {
    close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
