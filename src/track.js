import * as THREE from 'three';
import { rng, clamp, lerp, TAU, wrapAngle } from './util.js';

// ---------------------------------------------------------------- 諸元
export const ROAD = {
  spacing: 5,          // センターラインのサンプル間隔[m]
  laneW: 3.6,          // 1車線の幅[m]
  lanes: 3,            // 片側3車線
  halfRoad: 13.4,      // 中央分離帯の中心から路肩外側まで[m]
  medianHalf: 0.7,     // 中央分離帯の半幅[m]
  wallH: 1.05,         // 壁の高さ[m]
};

/** 走行車線の中心（u座標）。u はセンター基準で、進行方向に対して右が＋。 */
export const LANE_U = [-2.9, -6.5, -10.1];  // 追越車線 → 走行車線（日本は左側通行）
export const ONCOMING_U = [2.9, 6.5, 10.1];

/**
 * 出口ランプの形。
 *
 * ランプは「本線の s に対する 横位置 と 高さ」で表せます。つまり道路を
 * グラフとして持たなくても、いまの (s, u) のままで走れます。
 * ここが見た目と当たり判定の唯一の定義です。別々に持つと必ずズレます。
 *
 *   lead … 出口の何m手前から分かれ始めるか
 *   span … 分かれてから戻ってくるまでの長さ
 *   inU  … 分岐点／合流点での横位置（本線の走行車線と同じ位置）
 *   out  … いちばん外へ離れる量[m]
 *   drop … いちばん下がる量[m]
 *   half … ランプの半幅[m]
 */
// 数値の根拠：分岐の角度が atan(out / 分岐にかかる距離) になります。
// span 320 / out 44 では約20度あり、110km/h では曲がりきれずに車が
// 逆向きになりました（実測で s が減少）。実際のインターの分岐は5〜8度です。
// span 560 / out 30 で、分岐にかかる距離は約210m、角度は約8度になります。
export const RAMP = {
  lead: 160, span: 560, inU: -8.0, out: 30, drop: 11, half: 5.0,
  // ランプの中間は平らな台地にして、横へ大きく広げます。そこが
  // パーキングエリア＝自由に走り回れる広場になります。
  // 広げるのは外側だけ（内側を広げると本線に届いてしまいます）。
  pad: 20,
};

/**
 * ランプ上のある横位置での高さ。
 * 本線の路肩では0、ランプの中心で r.h、それより外は r.h のまま。
 * 分岐部のねじれ（本線側は水平、外側だけ下がる）はこれで表せます。
 * 当たり判定と見た目が同じ式を使うので、床が食い違いません。
 */
export function rampHeightAtU(r, u) {
  const EDGE = -(ROAD.halfRoad - 0.35);
  if (u >= EDGE) return 0;
  const span = EDGE - r.u;
  if (span <= 0.01) return r.h;
  const k = Math.min(1, Math.max(0, (EDGE - u) / span));
  return r.h * k;
}

/**
 * 0..1 の位置から「どれだけ本線から離れているか」を返します（両端で0）。
 * 中間を 1 のまま保つ台形にしてあります。その平らな区間が広場になります。
 */
const RAMP_RISE = 0.375, RAMP_HOLD = 0.25;
export function rampProfile(t) {
  if (t <= 0 || t >= 1) return 0;
  if (t < RAMP_RISE) { const x = t / RAMP_RISE; return x * x * (3 - 2 * x); }
  if (t < RAMP_RISE + RAMP_HOLD) return 1;
  const x = (1 - t) / RAMP_RISE;
  return x * x * (3 - 2 * x);
}
/** 平らな区間のどのあたりにいるか（両端0・中央1）。広場の広がり方に使います。 */
export function rampPad(t) {
  if (t <= RAMP_RISE || t >= RAMP_RISE + RAMP_HOLD) return 0;
  return Math.sin(Math.PI * ((t - RAMP_RISE) / RAMP_HOLD));
}

/**
 * パーキングエリアの配置。
 * 設備（scenery.js）と、たむろしている車（game.js）が別々に位置を計算すると
 * 必ずずれるので、寸法はここに一本化します。
 *   bayU     … 外側の縁から何m内側に停めるか
 *   bayPitch … 駐車ますの間隔（進行方向）
 *   bays     … ます数
 *   shopZ    … 売店の位置。0のままだと駐車ますの上に建ってしまいます
 */
export const PA = {
  bayU: 4.6,      // 外側の縁から、駐車ますの中心までの距離
  bayDepth: 5.2,  // ますの奥行き
  bayPitch: 2.9,  // ますの間隔（進行方向）
  bays: 8,
  shopZ: 26,      // 売店の位置。0のままだと駐車ますの上に建ってしまいます
  poleZ: 20,      // 照明柱の位置
};

/**
 * 一般道（側道）。
 * 高速の外側・下を、コースに沿って一周しています。
 *
 * 横位置と高さは「両隣のパーキングエリアの値をなめらかにつないだもの」です。
 * こうしておけば、どのPAからも段差なく出入りできます（PAごとに落差が
 * ちがうコースがあるため、一定の深さにすると出られないPAが生まれます）。
 * 道路をグラフとして持たなくても、ランプと同じ「本線の s に対する横位置と
 * 高さ」で書けます。
 */
// 半幅3.4m＝片側1車線ずつ。広場の設備（駐車ます・料金所・売店）の
// あいだを通す必要があるので、幅と通す位置は勝手に決められません。
export const SURF = { half: 3.4, lanes: 2, offset: 11.0 };

/**
 * 一般道の信号。
 * 位置と周期だけを決めておき、状態は「時刻と位置から計算する」ようにします。
 * 一つずつ状態を持たせて更新すると、遠くの信号まで毎フレーム面倒を見ることに
 * なります。計算で出せば、近くの数個だけ見た目を更新すれば済みます。
 */
export const SIGNAL = { every: 640, green: 19, yellow: 3, red: 14, near: 260 };

/** その信号が、いま何色か。 */
export function signalPhase(s, time) {
  const cycle = SIGNAL.green + SIGNAL.yellow + SIGNAL.red;
  // 場所ごとに位相をずらして、全部が一斉に変わらないようにします
  const t = (((time + s * 0.037) % cycle) + cycle) % cycle;
  if (t < SIGNAL.green) return 'green';
  if (t < SIGNAL.green + SIGNAL.yellow) return 'yellow';
  return 'red';
}

/** そのコースの信号の位置。パーキングエリアの中には置きません。 */
export function signalPoints(track) {
  if (!track.surfaceNodes) return [];
  const out = [];
  const n = Math.max(2, Math.round(track.length / SIGNAL.every));
  for (let i = 0; i < n; i++) {
    const s = (i / n) * track.length;
    // 交差点をインターの中に作ると、合流と重なって分かりにくくなります
    const r = track.rampAt ? track.rampAt(s) : null;
    if (r && r.f > 0.25) continue;
    if (!track.surfaceAt(s)) continue;
    out.push(s);
  }
  return out;
}

/** 節点のあいだの、つなぎ方。両端は平ら（PAの周りを水平に保つため）。 */
function surfBlend(k) {
  const x = Math.min(1, Math.max(0, (k - 0.2) / 0.6));
  return x * x * (3 - 2 * x);
}

/** k番目（0..bays-1）の駐車ますの、広場中心からの進行方向オフセット[m]。 */
export function paBayZ(k) { return (k - (PA.bays - 1) / 2) * PA.bayPitch; }

/**
 * このコースのパーキングエリア一覧。
 * 広場がいちばん広いのは台形の平らな区間のまんなか＝ t=0.5 の地点です。
 */
export function paSpots(track) {
  const out = [];
  const ex = (track.course && track.course.exits) || [];
  const eps = track.exitPoints || [];
  for (let i = 0; i < ex.length; i++) {
    if (!eps[i]) continue;
    const s = eps[i].s - RAMP.lead + RAMP.span * 0.5;
    const r = track.rampAt(s);
    if (!r || r.index !== i || r.pad < 0.99) continue;
    out.push({ index: i, name: r.name, s, outerU: r.outerU, innerU: r.innerU, h: r.h });
  }
  return out;
}
const smoothstep01 = (x) => {
  const k = x < 0 ? 0 : x > 1 ? 1 : x;
  return k * k * (3 - 2 * k);
};

/**
 * コース定義から周回路を生成します。
 * 半径を三角関数で揺らした閉ループなので、必ず一周でつながります。
 *
 * 手順は「形を作る → 全長を測る → 目標の全長になるよう水平方向だけ拡大縮小する」。
 * こうすると、同じ形のまま長さだけ変えられ、短いコースは自動的にコーナーがきつくなります。
 */
export function createTrack(course) {
  // 旧シグネチャ（数値のseed）にも一応対応しておきます
  if (typeof course === 'number' || course == null) {
    course = { id: 'bayshore', name: '湾岸', length: 14700, seed: course ?? 20240,
      aspect: [1, 1], cycles: 3.4, cityDensity: 0.9, traffic: 1,
      radius: { base: 1, harmonics: [[0.37, 1, 0.35], [0.21, 2, 1.9], [0.13, 3, 0.4], [0.06, 5, 2.6], [0.034, 8, 1.2]] },
      elevation: [[13, 2, 1.05], [7, 3, 0.2], [3.5, 5, 2.2]],
      zones: [['bay', 3], ['bridge', 1.2], ['city', 2.2], ['tunnel', 1]] };
  }
  const rand = rng(course.seed ?? 1);
  const CP = Math.max(48, Math.min(160, Math.round(course.length / 260)));
  const [ax, az] = course.aspect ?? [1, 1];

  const shape = (a) => {
    let r = course.radius.base;
    for (const [amp, freq, phase] of course.radius.harmonics) r += amp * Math.sin(freq * a + phase);
    return Math.max(0.18, r);
  };
  const elev = (a) => {
    let y = 11;
    for (const [amp, freq, phase] of (course.elevation ?? [])) y += amp * Math.sin(freq * a + phase);
    return y;
  };

  // いったん半径1で作り、あとから目標の全長へ合わせます
  const build = (scale) => {
    const pts = [];
    for (let i = 0; i < CP; i++) {
      const a = (i / CP) * TAU;
      const r = shape(a) * scale;
      pts.push(new THREE.Vector3(Math.cos(a) * r * ax, elev(a), Math.sin(a) * r * az));
    }
    return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
  };
  let scale = course.length / TAU;          // 円周からの初期見積もり
  let curve = build(scale);
  for (let k = 0; k < 3; k++) {             // 2〜3回で十分収束します
    const L = curve.getLength();
    scale *= course.length / L;
    curve = build(scale);
  }

  // ---- 最小コーナー半径の保証
  // 揺らぎが強すぎると、片側3車線の道路に収まらないヘアピンができてしまいます。
  // 周波数の高い成分ほどきつい曲がりを作るので、そこから先に落として作り直します。
  const MIN_R = course.minRadius ?? 108;
  const measureMinRadius = (c) => {
    const M = 480;
    const p2 = c.getSpacedPoints(M);
    const step = c.getLength() / M;
    let maxC = 0;
    for (let i = 0; i < M; i++) {
      const a0 = p2[(i - 1 + M) % M], a1 = p2[i], a2 = p2[(i + 1) % M];
      const h0 = Math.atan2(a1.x - a0.x, a1.z - a0.z);
      const h1 = Math.atan2(a2.x - a1.x, a2.z - a1.z);
      maxC = Math.max(maxC, Math.abs(wrapAngle(h1 - h0)) / step);
    }
    return maxC > 1e-6 ? 1 / maxC : Infinity;
  };
  const originalHarmonics = course.radius.harmonics;
  let damp = 1;
  for (let iter = 0; iter < 10; iter++) {
    const minR = measureMinRadius(curve);
    if (minR >= MIN_R) break;
    damp *= 0.86;
    course = {
      ...course,
      radius: {
        ...course.radius,
        // 周波数が高い成分ほど強く抑えます（全体の形はできるだけ保ちます）
        harmonics: originalHarmonics.map(([amp, f, ph]) => [amp * Math.pow(damp, Math.max(1, f) / 2), f, ph]),
      },
    };
    curve = build(scale);
    for (let k = 0; k < 2; k++) {
      scale *= course.length / curve.getLength();
      curve = build(scale);
    }
  }

  const length = curve.getLength();
  const n = Math.round(length / ROAD.spacing);
  const spacing = length / n;
  const spaced = curve.getSpacedPoints(n); // n+1点（最後は始点と同じ）

  const pos = new Float32Array(n * 3);
  const tan = new Float32Array(n * 3);
  const lat = new Float32Array(n * 3);
  const up = new Float32Array(n * 3);
  const curvature = new Float32Array(n);
  const bank = new Float32Array(n);
  const heading = new Float32Array(n);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), t = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const l = new THREE.Vector3(), u = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const p = spaced[i];
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    a.copy(spaced[(i - 1 + n) % n]);
    b.copy(spaced[(i + 1) % n]);
    t.subVectors(b, a).normalize();
    tan[i * 3] = t.x; tan[i * 3 + 1] = t.y; tan[i * 3 + 2] = t.z;
    heading[i] = Math.atan2(t.x, t.z);
  }
  // 曲率（進行方向の変化量 / 距離）
  for (let i = 0; i < n; i++) {
    const h0 = heading[(i - 1 + n) % n];
    const h1 = heading[(i + 1) % n];
    curvature[i] = wrapAngle(h1 - h0) / (2 * spacing);
  }
  // 曲率を均して、バンク（路面の傾き）を作ります
  const smooth = new Float32Array(n);
  const W = 8;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -W; k <= W; k++) s += curvature[(i + k + n) % n];
    smooth[i] = s / (2 * W + 1);
  }
  for (let i = 0; i < n; i++) {
    curvature[i] = smooth[i];
    bank[i] = clamp(smooth[i] * 260, -0.11, 0.11); // 最大 約6.3度
  }
  for (let i = 0; i < n; i++) {
    t.set(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]);
    l.crossVectors(t, UP).normalize();            // 進行方向に対して右
    u.crossVectors(l, t).normalize();
    // バンク分だけ左右を回転
    const c = Math.cos(bank[i]), s = Math.sin(bank[i]);
    const lx = l.x * c + u.x * s, ly = l.y * c + u.y * s, lz = l.z * c + u.z * s;
    const ux = u.x * c - l.x * s, uy = u.y * c - l.y * s, uz = u.z * c - l.z * s;
    lat[i * 3] = lx; lat[i * 3 + 1] = ly; lat[i * 3 + 2] = lz;
    up[i * 3] = ux; up[i * 3 + 1] = uy; up[i * 3 + 2] = uz;
  }

  // ---- 区間の性格づけ（トンネル・橋・市街地・海沿い）
  // コースごとの並びと重みを、1周に指定回数ぶん敷き詰めます。
  const zones = [];
  {
    const pattern = course.zones ?? [['bay', 3], ['city', 2], ['tunnel', 1], ['bridge', 1]];
    const cycles = Math.max(1, course.cycles ?? 3);
    const totalW = pattern.reduce((a, z) => a + z[1], 0) * cycles;
    let cursor = 0;
    const reps = Math.round(cycles);
    for (let c = 0; c < reps && cursor < length - 60; c++) {
      for (const [kind, w] of pattern) {
        if (cursor >= length - 60) break;
        // 重み通りの長さに ±18% のばらつきを与えて、機械的な繰り返しに見えないようにします
        let len = (length * w) / totalW * (0.82 + rand() * 0.36);
        len = Math.min(len, length - cursor);
        if (len < 55) continue;
        zones.push({ from: cursor, to: cursor + len, kind });
        cursor += len;
      }
    }
    if (zones.length) zones[zones.length - 1].to = length;
    else zones.push({ from: 0, to: length, kind: 'bay' });
  }

  // ---- 出口の位置と、そこに作れるランプの大きさ
  //
  // 等間隔に置くと曲線の途中に分岐ができます。そのうえ、曲がっている場所で
  // 横へ大きく振ると、ランプの曲率半径が潰れて走れなくなります
  // （海ほたるで半径20m・勾配43%になりました。実際のランプは半径100m以上、
  // 勾配4〜6%です）。
  //
  // そこで「いちばん真っ直ぐな場所へ寄せる」→「実際に形を作って半径と勾配を
  // 測る」→「基準を満たすまで振り幅と落差を縮める」→「それでも駄目なら
  // その出口にはランプを作らない」という順で決めます。
  // 走れないものを作らないほうが、無理に作って壊れるより良いという判断です。
  const exitPoints = [];
  {
    const ex = (course.exits && course.exits.length) ? course.exits : [];
    const gap = ex.length ? length / ex.length : 0;
    const sampleAt = (x) => {
      const xx = ((x % length) + length) % length;
      const i0 = Math.floor(xx / spacing) % n;
      const i1 = (i0 + 1) % n;
      const fr = xx / spacing - Math.floor(xx / spacing);
      const g = (arr, k) => lerp(arr[i0 * 3 + k], arr[i1 * 3 + k], fr);
      return {
        px: g(pos, 0), py: g(pos, 1), pz: g(pos, 2),
        lx: g(lat, 0), ly: g(lat, 1), lz: g(lat, 2),
        ux: g(up, 0), uy: g(up, 1), uz: g(up, 2),
      };
    };
    // 与えた振り幅・落差でランプを作ったときの、最小半径と最大勾配
    const measure = (es, out, drop) => {
      const pts = [];
      for (let d = 0; d <= RAMP.span; d += 4) {
        const t = d / RAMP.span;
        const f = rampProfile(t);
        const u = RAMP.inU - out * f;
        const h = -drop * f;
        const m = sampleAt(es - RAMP.lead + d);
        pts.push({
          x: m.px + m.lx * u + m.ux * h,
          y: m.py + m.ly * u + m.uy * h,
          z: m.pz + m.lz * u + m.uz * h,
        });
      }
      let minR = Infinity, maxG = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const h1 = Math.atan2(b.x - a.x, b.z - a.z);
        const h2 = Math.atan2(c.x - b.x, c.z - b.z);
        let dh = wrapAngle(h2 - h1);
        const d1 = Math.hypot(b.x - a.x, b.z - a.z);
        const d2 = Math.hypot(c.x - b.x, c.z - b.z);
        const step = (d1 + d2) / 2;
        if (step > 0.5 && Math.abs(dh) > 1e-7) minR = Math.min(minR, step / Math.abs(dh));
        if (d1 > 0.5) maxG = Math.max(maxG, Math.abs(b.y - a.y) / d1);
      }
      return { minR, maxG };
    };

    for (let i = 0; i < ex.length; i++) {
      const base = gap * (i + 0.5);
      const reach = Math.min(gap * 0.4, 900);
      // まず、ランプが占める区間がいちばん真っ直ぐな位置を探します
      let es = base, bestCost = Infinity;
      for (let d = -reach; d <= reach; d += 20) {
        const c = base + d;
        let cost = 0;
        for (let k = -RAMP.lead; k < RAMP.span - RAMP.lead; k += 20) {
          const x = ((c + k) % length + length) % length;
          cost += Math.abs(curvature[Math.floor(x / spacing) % n]);
        }
        cost += (Math.abs(d) / reach) * 0.02;
        if (cost < bestCost) { bestCost = cost; es = c; }
      }
      es = ((es % length) + length) % length;

      // 次に、走れる大きさまで縮めます
      let chosen = null;
      for (const [out, drop] of [[RAMP.out, RAMP.drop], [22, 8], [15, 5], [10, 3]]) {
        const m = measure(es, out, drop);
        if (m.minR >= 95 && m.maxG <= 0.11) { chosen = { s: es, out, drop, minR: m.minR, maxG: m.maxG }; break; }
      }
      exitPoints.push(chosen);   // 作れなければ null（その出口にランプは作りません）
    }
  }

  const track = {
    curve, length, n, spacing, course, exitPoints,
    surfaceNodes: null,
    pos, tan, lat, up, curvature, bank, heading, zones, seed: course.seed,

    /** 距離 s（m, 0..length）における位置・方向を返します。 */
    sample(s, out = {}) {
      let x = ((s % length) + length) % length / spacing;
      const i0 = Math.floor(x) % n;
      const i1 = (i0 + 1) % n;
      const f = x - Math.floor(x);
      out.pos = out.pos || new THREE.Vector3();
      out.tan = out.tan || new THREE.Vector3();
      out.lat = out.lat || new THREE.Vector3();
      out.up = out.up || new THREE.Vector3();
      for (const [arr, v] of [[pos, out.pos], [tan, out.tan], [lat, out.lat], [up, out.up]]) {
        v.set(
          lerp(arr[i0 * 3], arr[i1 * 3], f),
          lerp(arr[i0 * 3 + 1], arr[i1 * 3 + 1], f),
          lerp(arr[i0 * 3 + 2], arr[i1 * 3 + 2], f)
        );
      }
      out.tan.normalize(); out.lat.normalize(); out.up.normalize();
      out.curv = lerp(curvature[i0], curvature[i1], f);
      out.heading = heading[i0] + wrapAngle(heading[i1] - heading[i0]) * f;
      out.index = i0;
      return out;
    },

    /** s と横位置 u からワールド座標を作ります。 */
    place(s, u, out = new THREE.Vector3(), tmp = {}) {
      const sm = this.sample(s, tmp);
      return out.copy(sm.pos).addScaledVector(sm.lat, u);
    },

    /** ワールド座標を (s, u) に逆変換。hint は前フレームの index。 */
    project(p, hint = 0) {
      let best = hint, bestD = Infinity;
      const R = 40; // 前後200mだけ探索（十分速い）
      for (let k = -R; k <= R; k++) {
        const i = (hint + k + n) % n;
        const dx = p.x - pos[i * 3], dy = p.y - pos[i * 3 + 1], dz = p.z - pos[i * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD > 40000) { // 見失ったら全周走査
        for (let i = 0; i < n; i++) {
          const dx = p.x - pos[i * 3], dy = p.y - pos[i * 3 + 1], dz = p.z - pos[i * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      const i = best;
      const dx = p.x - pos[i * 3], dy = p.y - pos[i * 3 + 1], dz = p.z - pos[i * 3 + 2];
      const along = dx * tan[i * 3] + dy * tan[i * 3 + 1] + dz * tan[i * 3 + 2];
      const side = dx * lat[i * 3] + dy * lat[i * 3 + 1] + dz * lat[i * 3 + 2];
      const height = dx * up[i * 3] + dy * up[i * 3 + 1] + dz * up[i * 3 + 2];
      return { s: i * spacing + along, u: side, h: height, index: i, curv: curvature[i] };
    },

    /**
     * その地点にランプがあるか。あれば横位置・高さ・幅を返します。
     * 出口は courses.js の exits を一周に等間隔で並べたものです。
     */
    rampAt(s) {
      const ex = (course && course.exits) || null;
      if (!ex || !ex.length) return null;
      const x = ((s % length) + length) % length;
      for (let i = 0; i < ex.length; i++) {
        const ep = exitPoints[i];
        if (!ep) continue;                            // 走れる形にならなかった出口
        const es = ep.s;
        if (this.zoneAt(es) === 'tunnel') continue;   // トンネル内には作りません
        let d = x - (es - RAMP.lead);
        if (d < -length / 2) d += length;
        if (d > length / 2) d -= length;
        if (d < 0 || d > RAMP.span) continue;
        const t = d / RAMP.span;
        const f = rampProfile(t);
        const u = RAMP.inU - ep.out * f;
        // 分岐部では、ランプの内側の縁を本線の路肩まで広げます。
        // これが実際のインターにある三角形の舗装（ゴア）です。
        // ここが地続きでないと、一瞬のうちに横へ寄り切らないと降りられません
        // （実際、最初の実装では本線の壁に阻まれて一度も降りられませんでした）。
        const gore = f < 0.55;
        // 平らな区間では外側だけを広げて、走り回れる広場にします
        const pad = rampPad(t);
        const outerU = u - (RAMP.half + (RAMP.pad - RAMP.half) * pad);
        const innerU = gore
          ? Math.max(u + RAMP.half, -(ROAD.halfRoad - 0.35))
          : u + RAMP.half;
        // 下りは分岐と同時に始めます。以前は「ゴアの区間は水平に保つ」ために
        // 下りを後半へ押し込んでいましたが、そのぶん勾配が15〜18%になり
        // （実際のランプは4〜6%）崖のようになっていました。
        // 本線側の縁は水平のまま、外側だけがねじれて下がる形にします。
        // ＝ 高さは「本線からどれだけ外へ出たか」で決まります（rampHeightAtU）。
        const h = -ep.drop * f;
        return { index: i, t, f, u, outerU, innerU, h, gore, pad, name: ex[i][0] };
      }
      return null;
    },

    zoneAt(s) {
      const x = ((s % length) + length) % length;
      for (const z of zones) if (x >= z.from && x < z.to) return z.kind;
      return 'bay';
    },

    isTunnel(s) { return this.zoneAt(s) === 'tunnel'; },

    /**
     * その地点の一般道（側道）。横位置・高さ・半幅を返します。
     * 節点（＝各パーキングエリアの中心）のあいだを、両端が平らになる
     * つなぎ方で補間します。PAの周りが水平でないと、出入りで段差ができます。
     * 節点が2つ未満のコースには側道を作りません（つなぐ先がないため）。
     */
    surfaceAt(s) {
      const nodes = this.surfaceNodes;
      if (!nodes || nodes.length < 2) return null;
      const x = ((s % length) + length) % length;
      for (let i = 0; i < nodes.length; i++) {
        const a2 = nodes[i], b2 = nodes[(i + 1) % nodes.length];
        let d = x - a2.s;
        if (d < 0) d += length;
        let span = b2.s - a2.s;
        if (span <= 0) span += length;
        if (d > span) continue;
        const k = surfBlend(d / span);
        return {
          u: a2.u + (b2.u - a2.u) * k,
          h: a2.h + (b2.h - a2.h) * k,
          half: SURF.half,
        };
      }
      return null;
    },
  };

  // 側道の節点＝各パーキングエリアの中心。
  // paSpots は track.rampAt を使うので、track を作ったあとで求めます。
  {
    const sp = paSpots(track);
    // 広場を通す位置は「外の縁から SURF.offset」。駐車ますより内側、
    // 料金所より外側の空き帯です（中央に通すと料金所を突き抜けます）。
    track.surfaceNodes = sp.length >= 2
      ? sp.map((n) => ({ s: n.s, u: n.outerU + SURF.offset, h: n.h }))
        .sort((a2, b2) => a2.s - b2.s)
      : null;
  }
  return track;
}

// ---------------------------------------------------------------- 路面テクスチャ

function makeRoadTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  const g = cv.getContext('2d');
  const W = ROAD.halfRoad * 2 + 0.8;  // テクスチャ横方向が覆う実距離[m]
  const toPx = (u) => ((u + W / 2) / W) * cv.width;
  const TILE = 20;                     // 縦20mで1タイル
  const toPy = (m) => (m / TILE) * cv.height;

  g.fillStyle = '#2b2f36';
  g.fillRect(0, 0, cv.width, cv.height);
  // アスファルトのざらつき
  for (let i = 0; i < 24000; i++) {
    const v = 34 + Math.random() * 30;
    g.fillStyle = `rgba(${v},${v + 2},${v + 5},0.55)`;
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 2, 2);
  }
  // わだち（少し明るい帯）
  g.globalAlpha = 0.14;
  g.fillStyle = '#8d93a0';
  for (const u of [...LANE_U, ...ONCOMING_U]) {
    g.fillRect(toPx(u - 0.85), 0, toPx(u - 0.35) - toPx(u - 0.85), cv.height);
    g.fillRect(toPx(u + 0.35), 0, toPx(u + 0.85) - toPx(u + 0.35), cv.height);
  }
  g.globalAlpha = 1;

  // 伸縮目地（20mごとの継ぎ目）。これは実物も等間隔なので繰り返して構いません。
  g.globalAlpha = 0.55;
  g.fillStyle = '#15171b';
  g.fillRect(0, 0, cv.width, 4);
  // タールの補修跡は「路面全体を横切る濃い線」を7本描いていたため、
  // 20mごとに同じ模様が現れ、走ると縞が流れて見えていました。
  // 実物の補修跡は部分的なので、幅の短い断片を散らします。
  g.globalAlpha = 0.20;
  g.fillStyle = '#101216';
  for (let i = 0; i < 22; i++) {
    const y = Math.random() * cv.height;
    const x = Math.random() * cv.width;
    g.fillRect(x, y, cv.width * (0.06 + Math.random() * 0.16), 2 + Math.random() * 3);
  }
  g.globalAlpha = 1;

  const solid = (u, w = 0.15, color = '#cfd3ca') => {
    g.fillStyle = color;
    g.fillRect(toPx(u - w / 2), 0, Math.max(2, toPx(u + w / 2) - toPx(u - w / 2)), cv.height);
  };
  const dashed = (u, w = 0.15) => {
    g.fillStyle = '#cfd3ca';
    const x = toPx(u - w / 2);
    const ww = Math.max(2, toPx(u + w / 2) - toPx(u - w / 2));
    g.fillRect(x, 0, ww, toPy(8));   // 8m 引いて 12m 空ける
    // 車線境界の反射鋲（キャッツアイ）
    g.fillStyle = '#f2f4e8';
    g.fillRect(x - ww * 0.35, toPy(14), ww * 1.6, Math.max(2, toPy(0.22)));
  };

  // 自車線側（u<0）
  solid(-ROAD.halfRoad + 0.55, 0.20);
  dashed(-ROAD.laneW * 1 - 1.1);
  dashed(-ROAD.laneW * 2 - 1.1);
  solid(-ROAD.medianHalf - 0.35, 0.18);
  // 対向側（u>0）
  solid(ROAD.halfRoad - 0.55, 0.20);
  dashed(ROAD.laneW * 1 + 1.1);
  dashed(ROAD.laneW * 2 + 1.1);
  solid(ROAD.medianHalf + 0.35, 0.18);

  // 白線の摩耗（一部を薄く削る）と、車線中央の油じみ
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 90; i++) {
    g.globalAlpha = 0.10 + Math.random() * 0.35;
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 3 + Math.random() * 10, 3 + Math.random() * 14);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 0.16;
  g.fillStyle = '#0b0d11';
  for (const u of [...LANE_U, ...ONCOMING_U]) {
    g.fillRect(toPx(u - 0.32), 0, toPx(u + 0.32) - toPx(u - 0.32), cv.height);
  }
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, TILE, W };
}

// ---------------------------------------------------------------- 路面メッシュ

/**
 * 路面・分離帯・ガードレールを、200mごとのチャンクに分けて作ります。
 * チャンク分割しておくと画面外を自動で描画スキップでき、動作が軽くなります。
 */
export function buildRoad(track) {
  const group = new THREE.Group();
  group.name = 'road';
  const { tex, TILE, W } = makeRoadTexture();
  const roadMat = new THREE.MeshStandardMaterial({
    // 環境マップを弱く反射させると、街灯が路面に薄く伸びて「濡れたアスファルト」に見えます
    map: tex, roughness: 0.62, metalness: 0.16, color: 0xffffff, envMapIntensity: 0.55,
  });
  // コンクリートは光を返さない。艶を出すと「白い壁」に見えてしまいます。
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x4e535b, roughness: 0.95, metalness: 0.0,
    envMapIntensity: 0.35, side: THREE.DoubleSide,
  });
  // ガードレールだけは亜鉛メッキの金属なので、細く鋭く光らせます
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x9aa3b0, roughness: 0.30, metalness: 0.85,
    envMapIntensity: 1.4, side: THREE.DoubleSide,
  });

  const H = ROAD.halfRoad;
  const uList = [-H - 0.6, -H, -H + 0.4, -ROAD.medianHalf, ROAD.medianHalf, H - 0.4, H, H + 0.6];
  const yList = [0.22, 0.02, 0, 0, 0, 0, 0.02, 0.22];

  const CHUNK = 40; // 40サンプル＝200m
  const n = track.n;
  const p = new THREE.Vector3(), lt = new THREE.Vector3(), upv = new THREE.Vector3();
  const sm = {};

  for (let c0 = 0; c0 < n; c0 += CHUNK) {
    const c1 = Math.min(c0 + CHUNK, n);
    const rows = c1 - c0 + 1;
    const cols = uList.length;
    const posA = new Float32Array(rows * cols * 3);
    const uvA = new Float32Array(rows * cols * 2);
    const idx = [];
    for (let r = 0; r < rows; r++) {
      const i = (c0 + r) % n;
      const s = (c0 + r) * track.spacing;
      p.set(track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]);
      lt.set(track.lat[i * 3], track.lat[i * 3 + 1], track.lat[i * 3 + 2]);
      upv.set(track.up[i * 3], track.up[i * 3 + 1], track.up[i * 3 + 2]);
      for (let q = 0; q < cols; q++) {
        const o = (r * cols + q) * 3;
        posA[o] = p.x + lt.x * uList[q] + upv.x * yList[q];
        posA[o + 1] = p.y + lt.y * uList[q] + upv.y * yList[q];
        posA[o + 2] = p.z + lt.z * uList[q] + upv.z * yList[q];
        uvA[(r * cols + q) * 2] = (uList[q] + W / 2) / W;
        uvA[(r * cols + q) * 2 + 1] = s / TILE;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let q = 0; q < cols - 1; q++) {
        const a = r * cols + q, b = a + 1, cc = a + cols, d = cc + 1;
        // 上（空）を向くように三角形を張る
        idx.push(a, d, cc, a, b, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvA, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ランプが本線の壁を横切る区間では、壁を切らないと出入りできません。
  // （当たり判定は resolveWalls 側で切り替えるので、ここは見た目の話です）
  const rampOpen = (i) => {
    if (!track.rampAt) return false;
    const r = track.rampAt(i * track.spacing);
    return !!r && r.f < 0.62;
  };

  // 帯状の壁を作るヘルパー（u位置・高さ・材質を指定）
  const ribbon = (u, y0, y1, mat, step = 2, gap = null) => {
    for (let c0 = 0; c0 < n; c0 += CHUNK * step) {
      const c1 = Math.min(c0 + CHUNK * step, n);
      const rows = c1 - c0 + 1;
      const posA = new Float32Array(rows * 2 * 3);
      const idx = [];
      for (let r = 0; r < rows; r++) {
        const i = (c0 + r) % n;
        p.set(track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]);
        lt.set(track.lat[i * 3], track.lat[i * 3 + 1], track.lat[i * 3 + 2]);
        upv.set(track.up[i * 3], track.up[i * 3 + 1], track.up[i * 3 + 2]);
        for (let q = 0; q < 2; q++) {
          const yy = q === 0 ? y0 : y1;
          const o = (r * 2 + q) * 3;
          posA[o] = p.x + lt.x * u + upv.x * yy;
          posA[o + 1] = p.y + lt.y * u + upv.y * yy;
          posA[o + 2] = p.z + lt.z * u + upv.z * yy;
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        if (gap && (gap((c0 + r) % n) || gap((c0 + r + 1) % n))) continue;
        const a = r * 2, b = a + 1, cc = a + 2, d = a + 3;
        idx.push(a, cc, d, a, d, b);
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      group.add(new THREE.Mesh(g, mat));
    }
  };

  // 中央分離帯（コンクリート）
  ribbon(-ROAD.medianHalf, 0, 0.92, wallM(wallMat));
  ribbon(ROAD.medianHalf, 0, 0.92, wallM(wallMat));
  // 外側の壁とガードレール
  ribbon(-H - 0.55, 0.2, 0.2 + ROAD.wallH, wallM(wallMat), 2, rampOpen);
  ribbon(H + 0.55, 0.2, 0.2 + ROAD.wallH, wallM(wallMat));
  ribbon(-H - 0.5, 0.80, 0.94, railMat, 2, rampOpen);
  ribbon(H + 0.5, 0.80, 0.94, railMat);

  function wallM(m) { return m; }

  // 濡れた路面へ切り替えられるよう、材質を外へ渡します
  group.userData.roadMat = roadMat;
  return group;
}
