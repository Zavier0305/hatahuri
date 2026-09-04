import { clamp, wrapAngle, KMH } from './util.js';
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
    this.laneU = LANE_U[0];     // 選んだ車線の中心
    this.targetU = LANE_U[0];   // 実際に狙う横位置（車線変更は時間をかけて寄せます）
    this.laneTimer = 0;
    this.rubber = cfg.rubber ?? 0.10;   // 競り合いを保つための微調整
    this.gripScale = 1;                 // 路面の状態（雨なら下げます）
    this._tmp = {};
    this._tmp2 = {};
    this._tmp3 = {};
    this._p = new THREE.Vector3();
  }

  /** 先の区間で必要になる最低速度[m/s]を調べます。 */
  cornerSpeed(sAhead) {
    const track = this.track;
    const S = this.v.spec;
    let vmin = 200;
    // 先読みの距離は速度に比例させます。
    // 300m固定だと、250km/h から 150km/h まで落とすのに必要な距離（約250m）を
    // ぎりぎりでしか見ておらず、速いほどコーナーに突っ込むことになっていました。
    const scan = clamp(Math.abs(this.v.vx) * 5.0, 140, 700);
    const step = Math.max(15, scan / 22);
    for (let d = 15; d < scan; d += step) {
      const sm = track.sample(this.v.s + d, this._tmp);
      const c = Math.abs(sm.curv);
      if (c < 1e-5) continue;
      const grip = S.grip * this.gripScale * (1 + S.downforce * 0.30);
      const vAllowed = Math.sqrt((grip * 9.81) / c) * 0.94;   // 限界ぎりぎりを狙わない
      // 遠い曲がりほど、まだ減速しなくてよい
      const brakeDist = Math.max(0, d - 25);
      // 旋回しながらのブレーキは全グリップを使えないので、控えめな減速度で見積もります
      const vNow = Math.sqrt(vAllowed * vAllowed + 2 * (S.grip * this.gripScale * 6.3) * brakeDist);
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
    if (best !== this.lane) this.laneTimer = 1.4;
    this.lane = best;
    this.laneU = LANE_U[best];
  }

  update(dt, obstacles, playerGap) {
    const v = this.v;
    const track = this.track;
    this.chooseLane(dt, obstacles);

    // コーナーでは内側へ寄せます。
    // 左コーナーで車線中央のままだと、アンダーが出たときに外側＝中央分離帯へ
    // 押し出されて延々と擦り続けることになります。
    const curvAhead = track.sample(v.s + clamp(Math.abs(v.vx) * 1.1, 25, 140), this._tmp3).curv;
    // ただし寄せるのは車線の中だけ（車線幅3.6mの半分まで）。
    // ここを大きく取ると隣の走行車線へはみ出し、一般車に詰まって
    // 減速と幅寄せを繰り返す羽目になります。
    const inside = clamp(curvAhead * 300, -1.25, 1.25);
    // 中央分離帯側には 3.3m まで。追越車線の中心(-2.9)ちょうどを狙うと、
    // わずかな振れで毎回コンクリートに触れてしまいます。
    const laneTarget = clamp(this.laneU - inside, -11.4, -3.3);

    // 目標の横位置は、車線の中心へ毎秒2.2mまでの速さで寄せます。
    // ここを一気に切り替えると、3.6mぶんの横ズレを一度に埋めようとして
    // タイヤの限界を超え、行き過ぎて中央分離帯に当たっていました。
    const step = 2.2 * dt;
    const d = laneTarget - this.targetU;
    this.targetU += Math.abs(d) <= step ? d : Math.sign(d) * step;

    // --- 目標速度
    const skill = clamp(this.skill + (playerGap ? clamp(playerGap * 0.0009, -this.rubber, this.rubber) : 0), 0.4, 1.05);
    let vTarget = this.cornerSpeed() * (0.80 + 0.15 * skill);
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
    inp.brake = clamp(-err * 0.30, 0, 1);
    if (inp.brake > 0.05) inp.throttle = 0;

    // --- ステア
    // 以前は「先の1点へ向ける」方式でしたが、高速では小さな向きの誤差が大きな舵になり、
    // 中央分離帯すれすれの追越車線で左右に振れて壁を擦っていました。
    // ここでは (1) 進行方向のズレ (2) 目標ラインからの横ズレ (3) コーナーの曲率
    // の3つを別々に見て足し合わせます（いわゆる Stanley 制御＋フィードフォワード）。
    const at = track.sample(v.s, this._tmp2);
    const headErr = wrapAngle(at.heading - v.heading);          // ＋なら左へ向けたい
    const cross = v.u - this.targetU;                            // ＋なら目標より右にいる
    const speed = Math.max(8, Math.abs(v.vx));
    // 横ズレの補正量には上限を設けます（タイヤが受け止められない舵は打たない）
    const crossTerm = clamp(Math.atan2(cross * 2.1, speed), -0.16, 0.16);

    // コーナーで必要な舵角を先に入れておく（曲率×ホイールベース）
    const ahead = track.sample(v.s + clamp(speed * 0.55, 12, 60), this._tmp);
    const maxSteer = 0.55 / (1 + speed * 0.040);   // vehicle.js の AI 用と揃えます
    const ff = clamp((v.spec.dims.WB * ahead.curv) / maxSteer, -0.8, 0.8);

    // ヨーの減衰は「そのコーナーで本来出るべきヨー」との差にだけ効かせます。
    // 生のヨーレートを引くと、定常旋回中に自分の舵を打ち消してしまいます。
    const expectedYaw = v.vx * ahead.curv;
    inp.steer = clamp((headErr + crossTerm) * 2.4 + ff - (v.yawRate - expectedYaw) * 0.34, -1, 1);
    inp.handbrake = 0;

    // --- 自動変速
    if (v.shiftTimer <= 0) {
      if (v.rpm > v.spec.redline * 0.965 && v.gear < v.maxGear) v.shiftUp();
      else if (v.rpm < v.spec.redline * 0.46 && v.gear > 1) v.shiftDown();
    }
  }
}
