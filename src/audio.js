import { clamp } from './util.js';
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
    // 基本の倍音構成。setVoice() でエンジン形式ごとに配合を変えます。
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
    /*
     * ロードノイズ（転がり音）と雨音。
     *
     * これまでタイヤの音は「滑ったとき」しか鳴っていませんでした。
     * まっすぐ走っているあいだは風切り音だけで、路面の上を転がっている
     * 感じがありません。実際の車内でいちばん大きいのはこの音です。
     *
     * 転がり音は低め（ゴーッ）、雨は高め（サーッ）で分けます。同じ帯域に
     * 重ねると、ただ音が濁るだけで両方とも聞き取れなくなります。
     */
    this.road = mkNoise('lowpass', 520, 0.8, 0);
    this.rainNoise = mkNoise('highpass', 2400, 0.6, 0);

    // トンネル用の反響（ディレイのフィードバック）。区間に入ると混ざります。
    const rev = ctx.createDelay(0.4);
    rev.delayTime.value = 0.075;
    const revFb = ctx.createGain();
    revFb.gain.value = 0.42;
    const revMix = ctx.createGain();
    revMix.gain.value = 0;
    const revTone = ctx.createBiquadFilter();
    revTone.type = 'lowpass';
    revTone.frequency.value = 2200;
    engFilter.connect(rev);
    rev.connect(revFb); revFb.connect(rev);
    rev.connect(revTone); revTone.connect(revMix); revMix.connect(master);
    this.reverb = revMix;

    this.voice = null;
    this.ready = true;
  }

  /**
   * エンジン形式に合わせて音色を切り替えます。
   * 直6は倍音が整い、直4は粗く、ロータリーは基音が高く滑らか、
   * 水平対向は独特の不等間隔感を弱いデチューンで表現します。
   */
  setVoice(spec) {
    if (!this.ready) return;
    const kind = spec.sound || 'i6';
    if (this.voice === kind) return;
    this.voice = kind;
    const P = {
      i6:     { mul: [0.5, 1, 2, 3.02], gain: [0.50, 0.40, 0.22, 0.12], type: ['sawtooth', 'square', 'sawtooth', 'sawtooth'], detune: 0 },
      i4:     { mul: [0.5, 1, 1.5, 2.5], gain: [0.62, 0.44, 0.20, 0.14], type: ['square', 'sawtooth', 'square', 'sawtooth'], detune: 8 },
      v6:     { mul: [0.5, 1, 2, 4.0],  gain: [0.44, 0.42, 0.26, 0.14], type: ['sawtooth', 'sawtooth', 'sawtooth', 'triangle'], detune: 4 },
      flat6:  { mul: [0.5, 1, 2, 3.5],  gain: [0.48, 0.38, 0.30, 0.16], type: ['sawtooth', 'sawtooth', 'square', 'sawtooth'], detune: 12 },
      boxer4: { mul: [0.5, 1, 1.5, 3.0], gain: [0.58, 0.40, 0.24, 0.12], type: ['square', 'sawtooth', 'sawtooth', 'square'], detune: 18 },
      rotary: { mul: [1, 2, 3, 4.5],    gain: [0.40, 0.34, 0.24, 0.14], type: ['sawtooth', 'triangle', 'sawtooth', 'triangle'], detune: 2 },
    }[kind] || P_i6_fallback();
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].mul = P.mul[i];
      this.oscs[i].g.gain.value = P.gain[i];
      this.oscs[i].o.type = P.type[i];
      this.oscs[i].o.detune.value = (i % 2 ? 1 : -1) * P.detune;
    }
    function P_i6_fallback() {
      return { mul: [0.5, 1, 2, 3.02], gain: [0.5, 0.4, 0.22, 0.12], type: ['sawtooth', 'square', 'sawtooth', 'sawtooth'], detune: 0 };
    }
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.08);
    // 音を切ると game 側は audio を渡さなくなるので、鳴りっぱなしを避けるために
    // ここで止めます（マスターを絞るだけでは発振器は動いたままです）。
    if (!on) this.siren(null);
  }

  /** 毎フレーム、車の状態から音を作ります。 */
  update(v, dt, opts = {}) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const spec = v.spec;
    this.setVoice(spec);
    // 4ストロークの発火周波数 = 回転数/60 × 気筒数/2（ロータリーは2ローターぶん）
    const cyl = spec.cyl || 6;
    const base = clamp((v.rpm / 60) * (cyl / 2), 22, 460);
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

    // --- 転がり音。速度で上がり、荒れた路面と濡れた路面で増えます
    const wet = clamp(opts.wet || 0, 0, 1);
    const rough = opts.surface ? 1.35 : 1;      // 一般道はざらついた舗装
    const roadG = clamp(speed / 78, 0, 1) ** 1.25 * 0.13 * rough * (1 + wet * 0.5);
    this.road.g.gain.setTargetAtTime(roadG, t, 0.10);
    // 速度が上がると周波数も上がります（タイヤの回転が速くなるため）
    this.road.f.frequency.setTargetAtTime(300 + speed * 9, t, 0.12);

    // --- 雨音。走っていなくても降っていれば鳴ります
    this.rainNoise.g.gain.setTargetAtTime(wet * (0.045 + clamp(speed / 90, 0, 1) * 0.05), t, 0.25);

    const slip = clamp(Math.max(v.slipRear, v.slipFront) * 1.6 + v.wheelSpin * 0.8, 0, 1);
    this.tire.g.gain.setTargetAtTime(slip * 0.16 * clamp(speed / 8, 0, 1), t, 0.06);
    this.tire.f.frequency.setTargetAtTime(1300 + slip * 1400, t, 0.08);

    this.turbo.g.gain.setTargetAtTime(v.boost * 0.05 * load, t, 0.08);
    this.turbo.f.frequency.setTargetAtTime(2600 + v.boost * 3200, t, 0.1);

    // トンネルの反響
    if (this.reverb) {
      this.reverb.gain.setTargetAtTime(opts.tunnel ? 0.34 : 0.0, t, 0.35);
    }

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

  /**
   * パトカーのサイレン。2音を交互に鳴らします。
   * 音量は距離で決めるので、近づいてくるのが音だけでも分かります。
   * 追われていない間は発振器を止めておきます（常時鳴らすと重い）。
   */
  siren(st) {
    if (!this.ready) return;
    const want = (this.enabled && st && st.chasing)
      ? clamp(1 - st.near / 260, 0, 1) * 0.10 : 0;
    if (want <= 0.001) {
      if (this._siren) {
        this._siren.osc.stop();
        this._siren.osc.disconnect();
        this._siren.gain.disconnect();
        this._siren = null;
      }
      return;
    }
    const ctx = this.ctx;
    if (!this._siren) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const g = ctx.createGain();
      g.gain.value = 0;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900;
      f.Q.value = 2.0;
      osc.connect(f); f.connect(g); g.connect(this.master);
      osc.start();
      this._siren = { osc, gain: g, t: 0 };
    }
    const s2 = this._siren;
    const t = ctx.currentTime;
    // 0.62秒ごとに高低を切り替え（日本のパトカーの「ウーウー」に近い間隔）
    const hi = Math.floor(t / 0.62) % 2 === 0;
    s2.osc.frequency.setTargetAtTime(hi ? 860 : 640, t, 0.05);
    s2.gain.gain.setTargetAtTime(want, t, 0.10);
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
