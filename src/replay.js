import { clamp } from './util.js';

/**
 * リプレイ。走った内容を、自動のカメラワークで見返します。
 *
 * ■ 記録はゴーストと同じ形です
 * 位置が s と u なので、走りは数値の並びとして残せます（ghost.js と同じ）。
 * 違うのは「自車として見せる」ことと、速度と入力も残して、カメラの
 * 切り替えどころを決める材料にすることです。
 *
 * ■ カメラは「何が起きたか」で切り替えます
 * 一定間隔で機械的に切り替えると、何でもない直線で寄りの絵になったり、
 * いちばん見せたい場面で引いたりします。そこで、記録から
 *   ・大きく滑った
 *   ・強く減速した
 *   ・最高速に近い
 * ところを先に拾い、その前後だけ寄りや低い位置のカメラを当てます。
 */

const REPLAY_STEP_MS = 100;
const MAX_REPLAY_SAMPLES = 9000;      // 15分ぶん

/** カメラの型。どれも車を見ますが、置き方が違います */
export const SHOTS = [
  { id: 'chase',  label: '追走',   dist: 7.5,  height: 2.4,  side: 0,    fov: 58 },
  { id: 'low',    label: 'ロー',   dist: 5.0,  height: 0.45, side: 1.6,  fov: 52 },
  { id: 'side',   label: '流し',   dist: 2.0,  height: 1.5,  side: 11,   fov: 42 },
  { id: 'front',  label: '前',     dist: -9.5, height: 1.7,  side: 2.2,  fov: 50 },
  { id: 'high',   label: 'ハイ',   dist: 12,   height: 9.5,  side: 4,    fov: 46 },
];

export class ReplayRecorder {
  constructor() { this.reset(); }

  reset() {
    this.acc = 0;
    this.s = []; this.u = []; this.h = []; this.z = []; this.v = []; this.k = [];
  }

  get length() { return this.s.length; }

  /** @param v 自車 */
  sample(dt, veh) {
    this.acc += dt * 1000;
    if (this.acc < REPLAY_STEP_MS && this.s.length) return;
    if (this.s.length) this.acc -= REPLAY_STEP_MS;
    if (this.s.length >= MAX_REPLAY_SAMPLES) return;
    this.s.push(Math.round(veh.s * 10) / 10);
    this.u.push(Math.round(veh.u * 100) / 100);
    this.h.push(Math.round(veh.heading * 1000) / 1000);
    this.z.push(veh.onAlley ? 3 : veh.onSurface ? 2 : veh.onRamp ? 1 : 0);
    this.v.push(Math.round(veh.speedKmh));
    // 滑り具合。カメラの切り替えどころを決めるのに使います
    this.k.push(Math.round(clamp(Math.max(veh.slipRear, veh.slipFront), 0, 1) * 100));
  }

  take(carId) {
    if (this.s.length < 20) return null;
    return { v: 1, carId, step: REPLAY_STEP_MS,
      s: this.s.slice(), u: this.u.slice(), h: this.h.slice(),
      z: this.z.slice(), sp: this.v.slice(), k: this.k.slice() };
  }
}

/**
 * 記録から、カメラの切り替え表を作ります。
 *
 * 「見どころ」を先に拾い、そこへ寄りの絵を当てます。残りは追走とハイを
 * 交互に置いて、単調にならないようにします。
 */
export function buildShots(data) {
  const n = data.s.length;
  const step = data.step || REPLAY_STEP_MS;
  const top = Math.max(1, ...data.sp);
  const marks = [];

  // 見どころ拾い
  for (let i = 2; i < n - 2; i++) {
    const slip = data.k[i] / 100;
    const decel = (data.sp[i - 2] - data.sp[i]) / 10;      // 0.2秒での減速[km/h]/10
    const fast = data.sp[i] / top;
    let score = 0, kind = null;
    if (slip > 0.35) { score = slip * 2.2; kind = 'low'; }
    if (decel > 2.2 && decel * 0.5 > score) { score = decel * 0.5; kind = 'front'; }
    if (fast > 0.94 && 1.3 > score) { score = 1.3; kind = 'side'; }
    if (kind) marks.push({ i, score, kind });
  }
  marks.sort((a, b) => b.score - a.score);

  // 近すぎる見どころは間引きます。細かく切り替わると何も見えません
  const minGap = Math.round(2500 / step);
  const picked = [];
  for (const m of marks) {
    if (picked.some((p) => Math.abs(p.i - m.i) < minGap)) continue;
    picked.push(m);
    if (picked.length >= 12) break;
  }
  picked.sort((a, b) => a.i - b.i);

  // 見どころの前後に割り当て、隙間は追走とハイで埋めます
  const shots = [];
  let at = 0, fill = 0;
  const lead = Math.round(1200 / step);
  for (const m of picked) {
    const from = Math.max(at, m.i - lead);
    if (from > at) {
      shots.push({ from: at, to: from, id: fill % 3 === 2 ? 'high' : 'chase' });
      fill++;
    }
    shots.push({ from, to: Math.min(n - 1, m.i + lead), id: m.kind });
    at = Math.min(n - 1, m.i + lead);
  }
  if (at < n - 1) shots.push({ from: at, to: n - 1, id: 'chase' });
  return shots.filter((sh) => sh.to > sh.from);
}

/** 再生の進行と、いま当てるカメラを持ちます */
export class Replay {
  constructor(data) {
    this.data = data;
    this.shots = buildShots(data);
    this.t = 0;                       // 再生位置[ms]
    this.speed = 1;
    this.playing = true;
  }

  get step() { return this.data.step || REPLAY_STEP_MS; }
  get duration() { return (this.data.s.length - 1) * this.step; }
  get index() { return clamp(Math.round(this.t / this.step), 0, this.data.s.length - 1); }
  get done() { return this.t >= this.duration; }

  update(dt) {
    if (!this.playing) return;
    this.t = clamp(this.t + dt * 1000 * this.speed, 0, this.duration);
    if (this.t >= this.duration) this.playing = false;
  }

  seek(ms) { this.t = clamp(ms, 0, this.duration); }

  /** その時刻の位置。前後の記録を混ぜます */
  sampleAt(tMs) {
    const d = this.data;
    const n = d.s.length;
    const x = clamp(tMs / this.step, 0, n - 1);
    const i = Math.floor(x);
    const j = Math.min(n - 1, i + 1);
    const f = x - i;
    let dh = d.h[j] - d.h[i];
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    return {
      s: d.s[i] + (d.s[j] - d.s[i]) * f,
      u: d.u[i] + (d.u[j] - d.u[i]) * f,
      h: d.h[i] + dh * f,
      z: d.z[i],
      kmh: d.sp[i],
    };
  }

  /** いま当てるカメラ */
  shotAt(tMs) {
    const i = clamp(Math.round(tMs / this.step), 0, this.data.s.length - 1);
    const sh = this.shots.find((x) => i >= x.from && i < x.to) || this.shots[this.shots.length - 1];
    const id = sh ? sh.id : 'chase';
    return SHOTS.find((x) => x.id === id) || SHOTS[0];
  }
}
