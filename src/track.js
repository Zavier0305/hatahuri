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
 * 湾岸をイメージした周回コースを生成します。
 * 半径を三角関数で揺らした閉ループなので、必ず一周でつながります。
 */
export function createTrack(seed = 20240) {
  const rand = rng(seed);
  const CP = 60;
  const pts = [];
  for (let i = 0; i < CP; i++) {
    const a = (i / CP) * TAU;
    const R =
      2050 +
      760 * Math.sin(a + 0.35) +
      430 * Math.sin(2 * a + 1.9) +
      260 * Math.sin(3 * a + 0.4) +
      130 * Math.sin(5 * a + 2.6) +
      70 * Math.sin(8 * a + 1.2);
    const y =
      11 +
      13 * Math.sin(2 * a + 1.05) +
      7 * Math.sin(3 * a + 0.2) +
      3.5 * Math.sin(5 * a + 2.2);
    pts.push(new THREE.Vector3(Math.cos(a) * R, y, Math.sin(a) * R));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
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
  const zones = [];
  const zoneKinds = ['bay', 'bridge', 'city', 'tunnel', 'bay', 'city', 'tunnel', 'bay', 'bridge', 'city'];
  let cursor = 0;
  let zi = 0;
  while (cursor < length - 200) {
    const kind = zoneKinds[zi % zoneKinds.length];
    let len;
    if (kind === 'tunnel') len = 340 + rand() * 420;
    else if (kind === 'bridge') len = 500 + rand() * 500;
    else len = 900 + rand() * 900;
    len = Math.min(len, length - cursor);
    zones.push({ from: cursor, to: cursor + len, kind });
    cursor += len;
    zi++;
  }
  if (zones.length) zones[zones.length - 1].to = length;

  const track = {
    curve, length, n, spacing,
    pos, tan, lat, up, curvature, bank, heading, zones, seed,

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

  // 伸縮目地（20mごとの継ぎ目）とタールの補修跡
  g.globalAlpha = 0.55;
  g.fillStyle = '#15171b';
  g.fillRect(0, 0, cv.width, 4);
  g.globalAlpha = 0.28;
  for (let i = 0; i < 7; i++) {
    const y = Math.random() * cv.height;
    g.fillStyle = '#101216';
    g.fillRect(0, y, cv.width, 2 + Math.random() * 3);
  }
  g.globalAlpha = 1;

  const solid = (u, w = 0.15, color = '#e8e8e4') => {
    g.fillStyle = color;
    g.fillRect(toPx(u - w / 2), 0, Math.max(2, toPx(u + w / 2) - toPx(u - w / 2)), cv.height);
  };
  const dashed = (u, w = 0.15) => {
    g.fillStyle = '#eef0ec';
    const x = toPx(u - w / 2);
    const ww = Math.max(2, toPx(u + w / 2) - toPx(u - w / 2));
    g.fillRect(x, 0, ww, toPy(8));   // 8m 引いて 12m 空ける
    // 車線境界の反射鋲（キャッツアイ）
    g.fillStyle = '#fffef2';
    g.fillRect(x - ww * 0.4, toPy(14), ww * 1.8, Math.max(2, toPy(0.25)));
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
    map: tex, roughness: 0.80, metalness: 0.05, color: 0xffffff,
  });
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x767c86, roughness: 0.75, metalness: 0.15, side: THREE.DoubleSide,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xc3cad5, roughness: 0.38, metalness: 0.8, side: THREE.DoubleSide,
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
  ribbon(-H - 0.5, 0.78, 0.98, railMat);
  ribbon(H + 0.5, 0.78, 0.98, railMat);

  function wallM(m) { return m; }

  return group;
}
