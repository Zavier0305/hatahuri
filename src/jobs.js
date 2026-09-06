import { rng } from './util.js';

/**
 * 依頼（ミッション）。
 *
 * パーキングエリアで受けて、別のパーキングエリアまで届けます。
 * 「速く走ること」以外の目的を作るための仕組みで、条件のちがう3種類があります。
 * 判定に使うのは、すでにゲームが持っている値（距離・接触・手配度）だけです。
 *
 *   run   … 制限時間内に着く
 *   clean … 制限時間内に、一度もぶつけずに着く
 *   heat  … 手配度2から始まり、捕まらずに着く
 */

export const JOB_KINDS = {
  run: {
    label: '回送', mult: 1.0, slack: 1.00,
    desc: '時間内に届ける',
  },
  clean: {
    label: '無傷回送', mult: 1.7, slack: 1.15,
    desc: '一度もぶつけずに届ける',
  },
  heat: {
    label: '逃走', mult: 2.2, slack: 1.25,
    desc: '高速隊に捕まらずに届ける',
  },
};

/** 想定平均速度[km/h]。制限時間はこれと距離から決めます。 */
const PACE_KMH = 150;

export class Jobs {
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.active = null;
    this.seed = 1;
  }

  reset() { this.active = null; }

  /**
   * その場所で受けられる依頼を1つ作ります。
   * 同じPAでは同じ依頼が出るようにして（コースの種と出口番号から決める）、
   * 気に入らない依頼を出し直すために往復する、という遊びにならないようにします。
   */
  offer(track, spots, spot) {
    if (!spot || !spots || spots.length === 0) return null;
    const r = rng((track.course.seed ?? 1) * 977 + spot.index * 131 + 7);
    const kinds = Object.keys(JOB_KINDS);
    const kind = kinds[Math.floor(r() * kinds.length) % kinds.length];

    // 行き先は別のPA。1か所しかないコースでは、一周して戻ってきます。
    let dest = spot;
    if (spots.length > 1) {
      const others = spots.filter((s) => s.index !== spot.index);
      dest = others[Math.floor(r() * others.length) % others.length];
    }
    let dist = dest.s - spot.s;
    if (dist <= 200) dist += track.length;

    const K = JOB_KINDS[kind];
    const limit = (dist / (PACE_KMH / 3.6)) * K.slack + 18;
    // 報酬の目安：ストーリー最初のライバルが90万円。
    // 距離あたりを高くしすぎると、バトルより依頼のほうが割がよくなります。
    const reward = Math.round(dist * 70 * K.mult / 1000) * 1000;
    return {
      kind, label: K.label, desc: K.desc,
      fromIndex: spot.index, toIndex: dest.index,
      fromName: spot.name, toName: dest.name,
      fromS: spot.s, toS: dest.s, dist, limit, reward,
    };
  }

  /** 受注。走行中の状態はここで作ります。 */
  accept(job) {
    this.active = {
      ...job,
      left: job.limit,
      startS: job.fromS,
      clean: true,
      done: false,
    };
    this.onEvent('job-start', this.active);
    return this.active;
  }

  abandon(reason) {
    if (!this.active) return;
    const j = this.active;
    this.active = null;
    this.onEvent('job-fail', { job: j, reason });
  }

  /** ぶつけた（無傷の依頼はここで失敗します）。 */
  hit() {
    const j = this.active;
    if (!j || !j.clean) return;
    j.clean = false;
    if (j.kind === 'clean') this.abandon('接触');
  }

  /** 連行された。 */
  busted() {
    if (this.active) this.abandon('連行');
  }

  /**
   * @param dt     経過時間
   * @param v      自車
   * @param track  コース（rampAt をメソッドとして呼ぶので、track ごと渡します。
   *               関数だけ取り出して渡すと this が外れて壊れます）
   */
  update(dt, v, track) {
    const j = this.active;
    if (!j) return;
    j.left -= dt;
    if (j.left <= 0) { this.abandon('時間切れ'); return; }

    // 到着判定。行き先のパーキングエリアに入れば完了です
    if (v.onRamp && track && track.rampAt) {
      const r = track.rampAt(v.s);
      if (r && r.index === j.toIndex && r.pad > 0.35) {
        this.active = null;
        this.onEvent('job-clear', { job: j, left: j.left });
      }
    }
  }

  /** HUD へ渡す状態 */
  state(v, length) {
    const j = this.active;
    if (!j) return null;
    let left = j.toS - v.s;
    if (left < -length / 2) left += length;
    if (left < 0) left += length;
    return {
      label: j.label,
      to: j.toName,
      time: Math.max(0, j.left),
      urgent: j.left < 15,
      dist: left,
      destS: j.toS,
      reward: j.reward,
      clean: j.clean,
      kind: j.kind,
    };
  }
}
