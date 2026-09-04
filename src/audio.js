import { clamp, lerp } from './util.js';

/**
 * 効果音はすべて WebAudio でその場で合成しています（音声ファイルなし）。
 * エンジン音は「回転数から基本周波数を作り、倍音を重ねる」方式です。
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.master = null;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);
    this.master = master;

    // --- エンジン（矩形＋鋸波の重ね）
    const engGain = ctx.createGain();
    engGain.gain.value = 0;
    const engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 900;
    engFilter.Q.value = 1.1;
    engGain.connect(engFilter);
    engFilter.connect(master);

    this.oscs = [];
    const harmonics = [
      { type: 'sawtooth', mul: 0.5, gain: 0.55 },
      { type: 'square', mul: 1.0, gain: 0.40 },
      { type: 'sawtooth', mul: 2.0, gain: 0.22 },
      { type: 'sawtooth', mul: 3.02, gain: 0.10 },
    ];
    for (const h of harmonics) {
      const o = ctx.createOscillator();
      o.type = h.type;
      o.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = h.gain;
      o.connect(g);
      g.connect(engGain);
      o.start();
      this.oscs.push({ o, mul: h.mul, g });
    }
    this.engGain = engGain;
    this.engFilter = engFilter;

    // --- ノイズ源（風・タイヤ・ターボで共有）
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noise.start();
    this.noise = noise;

    const mkNoise = (type, freq, q, gain) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain;
      noise.connect(f); f.connect(g); g.connect(master);
      return { f, g };
    };
    this.wind = mkNoise('bandpass', 700, 0.7, 0);
    this.tire = mkNoise('bandpass', 1800, 6, 0);
    this.turbo = mkNoise('bandpass', 3600, 9, 0);

    this.ready = true;
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.08);
  }

  /** 毎フレーム、車の状態から音を作ります。 */
  update(v, dt, opts = {}) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const spec = v.spec;
    const cyl = 6;
    const base = clamp((v.rpm / 60) * (cyl / 2), 22, 420);
    for (const h of this.oscs) {
      h.o.frequency.setTargetAtTime(base * h.mul, t, 0.02);
    }
    const load = clamp(v.input.throttle * 0.8 + 0.2, 0, 1);
    const rev = clamp(v.rpm / spec.redline, 0, 1.1);
    const g = (0.05 + 0.30 * load) * (0.45 + 0.55 * rev) * (opts.inside ? 1.0 : 0.85);
    this.engGain.gain.setTargetAtTime(g, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(420 + 3800 * load * (0.35 + 0.65 * rev), t, 0.05);

    const speed = Math.abs(v.vx);
    this.wind.g.gain.setTargetAtTime(clamp((speed / 95) ** 2 * 0.30, 0, 0.30), t, 0.12);
    this.wind.f.frequency.setTargetAtTime(400 + speed * 12, t, 0.15);

    const slip = clamp(Math.max(v.slipRear, v.slipFront) * 1.6 + v.wheelSpin * 0.8, 0, 1);
    this.tire.g.gain.setTargetAtTime(slip * 0.16 * clamp(speed / 8, 0, 1), t, 0.06);
    this.tire.f.frequency.setTargetAtTime(1300 + slip * 1400, t, 0.08);

    this.turbo.g.gain.setTargetAtTime(v.boost * 0.05 * load, t, 0.08);
    this.turbo.f.frequency.setTargetAtTime(2600 + v.boost * 3200, t, 0.1);

    // ブローオフ（アクセルオフの瞬間）
    if (this._lastThr === undefined) this._lastThr = 0;
    if (this._lastThr > 0.5 && v.input.throttle < 0.15 && v.boost > 0.35) this.blowoff(v.boost);
    this._lastThr = v.input.throttle;
  }

  blowoff(power) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    this.turbo.g.gain.cancelScheduledValues(t);
    this.turbo.g.gain.setValueAtTime(0.22 * power, t);
    this.turbo.g.gain.exponentialRampToValueAtTime(0.0008, t + 0.28);
  }

  crash(power = 1) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = ctx.sampleRate * 0.35;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.value = clamp(power, 0, 1) * 0.5;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
  }

  /** カウントダウンやメニュー用の短い電子音 */
  beep(freq = 880, dur = 0.12, vol = 0.15) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
}
