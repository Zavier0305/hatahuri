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

  const track = {
    curve, length, n, spacing, course,
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

    zoneAt(s) {
      const x = ((s % length) + length) % length;
      for (const z of zones) if (x >= z.from && x < z.to) return z.kind;
      return 'bay';
    },

    isTunnel(s) { return this.zoneAt(s) === 'tunnel'; },
  };
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

  // 帯状の壁を作るヘルパー（u位置・高さ・材質を指定）
  const ribbon = (u, y0, y1, mat, step = 2) => {
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
        const a = r * 2, b = a + 1, cc = a + 2, d = a + 3;
        idx.push(a, cc, d, a, d, b);
      }
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
  ribbon(-H - 0.55, 0.2, 0.2 + ROAD.wallH, wallM(wallMat));
  ribbon(H + 0.55, 0.2, 0.2 + ROAD.wallH, wallM(wallMat));
  ribbon(-H - 0.5, 0.80, 0.94, railMat);
  ribbon(H + 0.5, 0.80, 0.94, railMat);

  function wallM(m) { return m; }

  // 濡れた路面へ切り替えられるよう、材質を外へ渡します
  group.userData.roadMat = roadMat;
  return group;
}
