// Procedural audio engine — everything synthesized with Web Audio, no sound files.

export class GameAudio {
  ctx!: AudioContext; master!: GainNode; noise!: AudioBuffer;
  rain!: GainNode; wind!: GainNode; bliz!: GainNode;
  started = false; muted = false;
  private barTimer = 99; private pluckTimer = 2; private bar = 0;
  private roots = [220, 174.61, 196, 146.83];          // Am–F–G–Dm feel

  start() {
    if (this.started) return;
    this.started = true;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.rain = this.noiseLayer('lowpass', 1100, 0);
    this.wind = this.windLayer(260, 0.11);             // sandstorm: deep howl
    this.bliz = this.windLayer(750, 0.35);             // blizzard: high whistle
  }

  toggleMute() {
    if (!this.started) return false;
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
    return this.muted;
  }

  private noiseLayer(type: BiquadFilterType, freq: number, gain: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
    return g;
  }

  private windLayer(base: number, lfoRate: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = base; f.Q.value = 2.5;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = lfoRate;
    const lg = this.ctx.createGain(); lg.gain.value = base * 0.45;
    lfo.connect(lg); lg.connect(f.frequency); lfo.start();
    const g = this.ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.master); src.start();
    return g;
  }

  setWeather(rainOn: boolean, sandOn: boolean, blizOn: boolean, snowAmbient: boolean) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.rain.gain.linearRampToValueAtTime(rainOn ? 0.13 : 0, t + 1.5);
    this.wind.gain.linearRampToValueAtTime(sandOn ? 0.22 : 0, t + 1.5);
    this.bliz.gain.linearRampToValueAtTime(blizOn ? 0.2 : snowAmbient ? 0.035 : 0, t + 1.5);
  }

  private burst(dur: number, freq: number, vol: number, type: BiquadFilterType = 'lowpass') {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  step(surface: string) {
    const f = ({ grass: 650, sand: 380, snow: 1500, mud: 240, blight: 240, cave: 500 } as any)[surface] || 650;
    this.burst(0.07, f, surface === 'snow' ? 0.09 : 0.11);
  }
  swing() { this.burst(0.12, 2000, 0.07, 'bandpass'); }
  chop() { this.burst(0.09, 420, 0.22); }
  hitmob() {
    this.burst(0.1, 900, 0.12, 'bandpass');
    this.tone('sawtooth', 110, 55, 0.16, 0.1, 300);
  }
  hurt() { this.tone('sine', 170, 55, 0.25, 0.22, 800); }
  growl(closeness: number) {
    this.tone('sawtooth', 60 + Math.random() * 25, 38, 0.9, 0.1 * closeness + 0.02, 220);
  }
  build() { this.burst(0.15, 500, 0.18); this.tone('triangle', 300, 220, 0.15, 0.08, 1200); }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, filterF: number) {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterF;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // generative ambient score: slow pads on a minor progression, sparse plucked notes; darker at night
  update(dt: number, night: boolean) {
    if (!this.started || this.muted) return;
    this.barTimer += dt;
    if (this.barTimer >= 4.5) {
      this.barTimer = 0;
      const root = this.roots[this.bar++ % this.roots.length] * (night ? 0.5 : 1);
      for (const [m, v] of [[1, 0.035], [1.5, 0.026], [2, 0.02], [night ? 1.189 : 1.26, 0.022]] as [number, number][])
        this.pad(root * m, v);
    }
    this.pluckTimer -= dt;
    if (this.pluckTimer <= 0) {
      this.pluckTimer = 2.5 + Math.random() * 5;
      const scale = [2, 2.378, 2.67, 3, 3.564];
      const root = this.roots[(this.bar - 1 + this.roots.length) % this.roots.length] * (night ? 0.5 : 1);
      const n = root * scale[(Math.random() * scale.length) | 0];
      this.tone('sine', n, n * 0.995, 1.1, night ? 0.028 : 0.045, 4000);
    }
  }

  private pad(freq: number, vol: number) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'triangle';
    o.frequency.value = freq;
    o.detune.value = (Math.random() - 0.5) * 8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(vol, t + 1.6);
    g.gain.linearRampToValueAtTime(0.001, t + 4.6);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 4.8);
  }
}
