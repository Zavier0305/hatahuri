import * as THREE from 'three';
import { rng, clamp } from './util.js';
import { buildTrafficCar } from './carModel.js';
import { signalPhase, levelH } from './track.js';

const CROSS_COLORS = [0xd8dade, 0x1b1d22, 0x5a6068, 0x2a3a5a, 0x8f9298, 0xbfc3c8];

/**
 * 交差点を横切る車。
 *
 * 信号を守る理由を作るための仕組みです。赤で突っ切ると横から車が出てきます。
 * 手配度が上がるだけでは、止まる側が時間を損するだけで、守る意味がありません。
 *
 * 交差する道そのものは作りません。車は交差点の位置（s は固定）で、道を横切る
 * 向き（u）へ動くだけです。1本の道に沿った座標のままでも「横切る」は表せます。
 */
export class Crossing {
  constructor(track, scene, seed = 77, count = 3) {
    this.track = track;
    this.rand = rng(seed);
    this.group = new THREE.Group();
    this.group.name = 'crossing';
    scene.add(this.group);
    this.cars = [];
    for (let i = 0; i < count; i++) {
      const kind = this.rand() < 0.22 ? 'van' : 'sedan';
      const model = buildTrafficCar(kind, CROSS_COLORS[(this.rand() * CROSS_COLORS.length) | 0], this.rand);
      model.root.visible = false;
      this.group.add(model.root);
      this.cars.push({
        model, active: false, s: 0, u: 0, dir: 1, vx: 0, drop: 0,
        halfL: model.length * 0.5, halfW: model.width * 0.5,
      });
    }
    this._sm = {};
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._f = new THREE.Vector3();
    this._x = new THREE.Vector3();
  }

  clear() {
    for (const c of this.cars) { c.active = false; c.model.root.visible = false; }
  }

  /**
   * @param v       自車
   * @param signals game が持っている信号の一覧（s を使います）
   * @param time    信号の時計
   */
  update(dt, v, signals, time) {
    const t = this.track;
    if (!signals || !signals.length || !t.surfaceAt) { this.clear(); return; }
    // 一般道にいるときだけ動かします。本線からは見えません
    if (!v.onSurface) { this.clear(); return; }
    const L = t.length;
    const wrap = (d) => (d > L / 2 ? d - L : d < -L / 2 ? d + L : d);

    for (const c of this.cars) {
      if (c.active) {
        c.u += c.dir * c.vx * dt;
        const sf = t.surfaceAt(c.s);
        // 道を渡りきったら消えます
        if (!sf || Math.abs(c.u - sf.u) > 34) { c.active = false; c.model.root.visible = false; continue; }
        this.place(c);
        continue;
      }
      // 空いている車を、近くの「赤（＝交差側が青）」の交差点へ出します
      let pick = null;
      for (const sg of signals) {
        const d = wrap(sg.s - v.s);
        if (d < -30 || d > 150) continue;
        if (signalPhase(sg.s, time) !== 'red') continue;
        // 1つの交差点に2台まで。1台だけだと、赤なのに閑散として見えます
        const n = this.cars.filter((o) => o.active && o.s === sg.s).length;
        if (n >= 2) continue;
        pick = sg; c.slot = n; break;
      }
      if (!pick) continue;
      const sf = t.surfaceAt(pick.s);
      if (!sf) continue;
      c.s = pick.s;
      c.dir = this.rand() < 0.5 ? 1 : -1;
      c.u = sf.u - c.dir * (24 + (c.slot || 0) * 10);
      c.vx = (28 + this.rand() * 16) / 3.6;
      c.drop = sf.drop;
      c.active = true;
      c.model.root.visible = true;
      this.place(c);
    }
  }

  place(c) {
    const sm = this.track.sample(c.s, this._sm);
    const root = c.model.root;
    // 横切る車も、道を渡るあいだ水平に保ちます
    const h = levelH(sm, c.u, c.drop);
    root.position.copy(sm.pos).addScaledVector(sm.lat, c.u).addScaledVector(sm.up, h + 0.01);
    // 進む向きは横（lat）。右手系（X×Y=Z）になるよう X には tan を取ります
    const fwd = this._f.copy(sm.lat).multiplyScalar(c.dir);
    const left = this._x.copy(sm.tan).multiplyScalar(c.dir);
    this._m.makeBasis(left, sm.up, fwd);
    this._q.setFromRotationMatrix(this._m);
    root.quaternion.copy(this._q);
  }

  /**
   * 自車との接触。
   * 横切る車は「進行方向に細く、横に長い」ので、s と u の役割が入れ替わります。
   * ぶつかった強さを返します（0 なら当たっていません）。
   */
  hitTest(v) {
    if (!v.onSurface) return 0;
    const L = this.track.length;
    for (const c of this.cars) {
      if (!c.active) continue;
      let ds = v.s - c.s;
      if (ds > L / 2) ds -= L;
      if (ds < -L / 2) ds += L;
      if (Math.abs(ds) > c.halfW + v.spec.dims.L * 0.5) continue;
      if (Math.abs(v.u - c.u) > c.halfL + v.spec.dims.W * 0.5) continue;
      const sev = clamp((Math.abs(v.vx) + c.vx) / 22, 0.25, 1);
      // 一度当たったら、その車は退場します（めり込んだまま何度も数えないため）
      c.active = false;
      c.model.root.visible = false;
      return sev;
    }
    return 0;
  }
}
