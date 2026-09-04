import { clamp, lerp, wrapAngle, damp, KMH } from './util.js';
import { LANE_U } from './track.js';
import * as THREE from 'three';

/**
 * ライバルのドライバーAI。
 * 「先の曲率から出せる速度を決める」→「その速度になるようアクセル/ブレーキ」→
 * 「先読み点へステアを向ける」という、実車の運転に近い順番で考えます。
 */
export class RivalAI {
  constructor(vehicle, track, cfg = {}) {
    this.v = vehicle;
    this.track = track;
    this.skill = cfg.skill ?? 0.85;
    this.aggression = cfg.aggression ?? 0.6;
    this.lane = 0;
    this.targetU = LANE_U[0];
    this.laneTimer = 0;
    this.rubber = cfg.rubber ?? 0.10;   // 競り合いを保つための微調整
    this._tmp = {};
    this._p = new THREE.Vector3();
  }

  /** 先の区間で必要になる最低速度[m/s]を調べます。 */
  cornerSpeed(sAhead) {
    const track = this.track;
    const S = this.v.spec;
    let vmin = 200;
    for (let d = 20; d < 320; d += 20) {
      const sm = track.sample(this.v.s + d, this._tmp);
      const c = Math.abs(sm.curv);
      if (c < 1e-5) continue;
      const grip = S.grip * (1 + S.downforce * 0.30);
      const vAllowed = Math.sqrt((grip * 9.81) / c);
      // 遠い曲がりほど、まだ減速しなくてよい
      const brakeDist = Math.max(0, d - 25);
      const vNow = Math.sqrt(vAllowed * vAllowed + 2 * (S.grip * 8.4) * brakeDist);
      vmin = Math.min(vmin, vNow);
    }
    return vmin;
  }

  /** 前方の交通と相手車を見て、走る車線を決めます。 */
  chooseLane(dt, obstacles) {
    this.laneTimer -= dt;
    if (this.laneTimer > 0) return;
    const scores = LANE_U.map((u, i) => {
      let sc = 0;
      // 追越車線を好む（アグレッシブなほど内寄り）
      sc -= i * (1.2 - this.aggression);
      for (const o of obstacles) {
        if (o === this.v) continue;
        const gap = o.s - this.v.s;
        if (gap < -8 || gap > 190) continue;
        if (Math.abs(o.u - u) < 3.0) {
          const closing = Math.max(0, this.v.vx - (o.vx || 0));
          sc -= (190 - gap) / 190 * (6 + closing * 0.35);
        }
      }
      sc -= Math.abs(u - this.v.u) * 0.10; // むやみに車線を変えない
      return sc;
    });
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    if (best !== this.lane) this.laneTimer = 1.1;
    this.lane = best;
    this.targetU = LANE_U[best];
  }

  update(dt, obstacles, playerGap) {
    const v = this.v;
    const track = this.track;
    this.chooseLane(dt, obstacles);

    // --- 目標速度
    const skill = clamp(this.skill + (playerGap ? clamp(playerGap * 0.0009, -this.rubber, this.rubber) : 0), 0.4, 1.05);
    let vTarget = this.cornerSpeed() * (0.86 + 0.16 * skill);
    vTarget = Math.min(vTarget, (v.spec.topSpeed / KMH) * 1.08);

    // 前車に詰まったら合わせる
    for (const o of obstacles) {
      if (o === v) continue;
      const gap = o.s - v.s;
      if (gap > 0 && gap < 60 && Math.abs(o.u - v.u) < 2.6) {
        const need = (o.vx || 0) + (gap - 12) * 0.55;
        vTarget = Math.min(vTarget, Math.max(4, need));
      }
    }

    const err = vTarget - v.vx;
    const inp = v.input;
    inp.throttle = clamp(err * 0.32, 0, 1);
    inp.brake = clamp(-err * 0.19, 0, 1);
    if (inp.brake > 0.05) inp.throttle = 0;

    // --- ステア（先読み点へ向ける）
    const look = clamp(14 + v.vx * 0.78, 22, 95);
    const sm = track.sample(v.s + look, this._tmp);
    this._p.copy(sm.pos).addScaledVector(sm.lat, this.targetU);
    const dx = this._p.x - v.pos.x;
    const dz = this._p.z - v.pos.z;
    const want = Math.atan2(dx, dz);
    const diff = wrapAngle(want - v.heading);
    inp.steer = clamp(diff * 2.6 - v.yawRate * 0.42, -1, 1);
    inp.handbrake = 0;

    // --- 自動変速
    if (v.shiftTimer <= 0) {
      if (v.rpm > v.spec.redline * 0.965 && v.gear < v.maxGear) v.shiftUp();
      else if (v.rpm < v.spec.redline * 0.46 && v.gear > 1) v.shiftDown();
    }
  }
}
