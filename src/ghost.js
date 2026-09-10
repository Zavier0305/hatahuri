import { Actor } from './actors.js';
import { CAR_BY_ID, CARS } from './cars.js';
import { dropFor } from './remote.js';

/**
 * ゴースト（自己ベストとの並走）。
 *
 * 位置が「コース上の距離 s と横位置 u」で表されているので、1周ぶんの走りは
 * 数値の並びで丸ごと残せます。地形も入力も再現する必要がなく、走った跡だけを
 * 置き直す形です。
 *
 * ■ 一定間隔で記録します
 * 時刻を一緒に持たず、100ms ごとの並びとして持ちます。こうすると
 * 「何秒地点か」から添字が直接出るので、探索が要りません。保存する量も減ります。
 *
 * ■ オンラインの相手とは作りが違います
 * 相手の車（remote.js）は、届いていない先を予測で埋めています。ゴーストは
 * 1周ぶんが手元に揃っているので予測は要らず、前後の記録をそのまま補間します。
 * 共通しているのは車の見た目（Actor）と、道の高さの求め方だけです。
 */

const STEP_MS = 100;          // 記録の間隔
const MAX_SAMPLES = 6000;     // 1周ぶんの上限（10分ぶん）
export const MAX_GHOSTS = 6;  // 保存しておくコース数

/** 走りを記録します */
export class GhostRecorder {
  constructor() { this.reset(); }

  reset() {
    this.acc = 0;
    this.s = []; this.u = []; this.h = []; this.z = [];
  }

  get length() { return this.s.length; }

  /** @param v 自車 */
  sample(dt, v) {
    this.acc += dt * 1000;
    if (this.acc < STEP_MS && this.s.length) return;
    if (this.s.length) this.acc -= STEP_MS;
    if (this.s.length >= MAX_SAMPLES) return;
    this.s.push(Math.round(v.s * 10) / 10);
    this.u.push(Math.round(v.u * 100) / 100);
    this.h.push(Math.round(v.heading * 1000) / 1000);
    this.z.push(v.onAlley ? 3 : v.onSurface ? 2 : v.onRamp ? 1 : 0);
  }

  /** 保存できる形にして返します */
  take(carId, lapMs) {
    /*
     * 周回線を跨いだ直後の点が末尾に紛れ込むことがあります。
     * 記録は 100ms ごと（60fps なら6フレームに1回）で、その回がちょうど
     * ゴール通過のフレームに当たると、s が 4197 から 0 付近へ戻った値が
     * 最後に入ります。そのまま残すと、ゴーストが最後の一瞬だけ
     * スタート地点へワープして見えます。
     * 1周のあいだ s は増えていくので、後ろへ戻った点は落とします。
     */
    while (this.s.length >= 2 && this.s[this.s.length - 1] < this.s[this.s.length - 2]) {
      this.s.pop(); this.u.pop(); this.h.pop(); this.z.pop();
    }
    if (this.s.length < 4) return null;
    return { v: 1, carId, lap: Math.round(lapMs), step: STEP_MS,
      s: this.s.slice(), u: this.u.slice(), h: this.h.slice(), z: this.z.slice() };
  }
}

/** 記録を車として走らせます */
export class Ghost {
  constructor(data, scene, track) {
    this.data = data;
    this.track = track;
    const spec = CAR_BY_ID[data.carId] || CARS[0];
    this.actor = new Actor(spec, null, scene, { color: 0x6fd5ff, isAI: true });
    this.vehicle = this.actor.vehicle;
    this.spec = spec;
    fade(this.actor.mesh, 0.34);
    // 接地影まで薄くすると浮いて見えるので、影は少しだけ残します
    if (this.actor.shadow) this.actor.shadow.material.opacity = 0.18;
    this.visible = true;
    this.seek(0);
  }

  get lapMs() { return this.data.lap; }

  /** @param tMs 周回内の経過時間[ms] */
  seek(tMs) {
    const d = this.data;
    const n = d.s.length;
    if (!n) return;
    const step = d.step || STEP_MS;
    const x = Math.max(0, tMs / step);
    const i = Math.min(n - 1, Math.floor(x));
    const j = Math.min(n - 1, i + 1);
    const f = j > i ? x - i : 0;

    const s = d.s[i] + (d.s[j] - d.s[i]) * f;
    const u = d.u[i] + (d.u[j] - d.u[i]) * f;
    // 向きは -PI..PI をまたぐので、素直に混ぜると1周ぶん回ります
    let dh = d.h[j] - d.h[i];
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    const h = d.h[i] + dh * f;
    const z = d.z[i];

    // 記録を使い切ったら消えます（自分のほうが遅いと、先にゴールされた状態）
    const done = tMs > (n - 1) * step + step;
    this.actor.mesh.visible = this.visible && !done;
    if (this.actor.shadow) this.actor.shadow.visible = this.actor.mesh.visible;
    if (!this.actor.mesh.visible) return;

    const v = this.vehicle;
    v.s = s; v.u = u; v.heading = h;
    v.onRamp = z === 1; v.onSurface = z === 2; v.onAlley = z === 3;
    const sm = this.track.sample(s, v._sm || (v._sm = {}));
    const drop = z === 0 ? 0 : dropFor(this.track, s, z);
    v.pos.copy(sm.pos).addScaledVector(sm.lat, u).addScaledVector(sm.up, drop + 0.02);
    v.trackIndex = sm.index;
    this.actor.syncMesh(this.track);
  }

  /** いまの時刻で、自分より何メートル前にいるか */
  gapAt(tMs, playerS, trackLength) {
    const d = this.data;
    const step = d.step || STEP_MS;
    const i = Math.min(d.s.length - 1, Math.max(0, Math.round(tMs / step)));
    let g = d.s[i] - playerS;
    if (g > trackLength / 2) g -= trackLength;
    if (g < -trackLength / 2) g += trackLength;
    return g;
  }

  dispose(scene) { this.actor.dispose(scene); }
}

/**
 * 車体を半透明にします。マテリアルは車ごとに作られるので他車には影響しません。
 *
 * 1台の中では同じマテリアルが複数の部位で共有されています（4本のタイヤが
 * 1つのゴムを使う、など）。traverse は部位ごとに回るので、素直に掛け算すると
 * 同じマテリアルに何度も掛かります。5か所で共有していれば 0.34^5 ＝ ほぼ透明で、
 * 「ゴーストが出ているのに見えない」ことになります。一度処理したものは飛ばします。
 */
function fade(root, opacity) {
  const done = new Set();
  root.traverse((o) => {
    if (!o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (done.has(m)) continue;
      done.add(m);
      m.transparent = true;
      m.opacity = (m.opacity ?? 1) * opacity;
      m.depthWrite = false;
    }
  });
}

/**
 * 保存しておくゴーストを選びます。
 * 1周ぶんで数十KBあるので、全コースぶん貯めると保存領域を圧迫します。
 * 新しいものから MAX_GHOSTS 件だけ残します。
 */
export function trimGhosts(ghosts) {
  const keys = Object.keys(ghosts);
  if (keys.length <= MAX_GHOSTS) return ghosts;
  keys.sort((a, b) => (ghosts[b].at || 0) - (ghosts[a].at || 0));
  const out = {};
  for (const k of keys.slice(0, MAX_GHOSTS)) out[k] = ghosts[k];
  return out;
}
