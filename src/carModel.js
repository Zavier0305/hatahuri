import * as THREE from 'three';
import { clamp, lerp } from './util.js';

/**
 * 断面（ロフト）でボディを作ります。
 * 「前から後ろへ輪切りにした形」を並べて面を張る方式なので、
 * 車種ごとに輪切りの数値を変えるだけでシルエットが作り分けられます。
 */
const RING = 20; // 1断面あたりの頂点数

function ringPoints(y0, y1, wb, wt, squareness, out) {
  const yc = (y0 + y1) * 0.5;
  const hy = (y1 - y0) * 0.5;
  const n = 2 / squareness;
  for (let i = 0; i < RING; i++) {
    const th = (i / RING) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const nx = Math.sign(c) * Math.pow(Math.abs(c), n);
    const ny = Math.sign(s) * Math.pow(Math.abs(s), n);
    const y = yc + ny * hy;
    const t = (ny + 1) * 0.5;
    const hw = lerp(wb, wt, t);
    out[i * 2] = nx * hw;
    out[i * 2 + 1] = y;
  }
}

/**
 * @param {Array} sections [t, y0, y1, wb, wt] の配列（tは前0→後1）
 * @param {Object} o { length, width, height, squareness, capFront, capBack, zOffset }
 */
export function loft(sections, o) {
  const { length: L, width: W, height: H } = o;
  const sq = o.squareness ?? 4;
  const halfW = W * 0.5;
  const n = sections.length;
  const pos = [];
  const idx = [];
  const tmp = new Float32Array(RING * 2);

  for (let s = 0; s < n; s++) {
    const [t, y0, y1, wb, wt] = sections[s];
    ringPoints(y0 * H, y1 * H, wb * halfW, wt * halfW, sq, tmp);
    const z = (0.5 - t) * L + (o.zOffset || 0);
    for (let i = 0; i < RING; i++) pos.push(tmp[i * 2], tmp[i * 2 + 1], z);
  }
  for (let s = 0; s < n - 1; s++) {
    const a = s * RING;
    const b = (s + 1) * RING;
    for (let i = 0; i < RING; i++) {
      const j = (i + 1) % RING;
      idx.push(a + i, b + i, b + j);
      idx.push(a + i, b + j, a + j);
    }
  }
  // 前後の蓋（断面の中心へ扇状に）
  const capFan = (ringStart, sec, flip) => {
    const [, y0, y1] = sec;
    const cy = ((y0 + y1) * 0.5) * H;
    const cz = pos[ringStart * 3 + 2];
    const ci = pos.length / 3;
    pos.push(0, cy, cz);
    for (let i = 0; i < RING; i++) {
      const j = (i + 1) % RING;
      if (flip) idx.push(ci, ringStart + j, ringStart + i);
      else idx.push(ci, ringStart + i, ringStart + j);
    }
  };
  if (o.capFront !== false) capFan(0, sections[0], true);
  if (o.capBack !== false) capFan((n - 1) * RING, sections[n - 1], false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- マテリアル

function bodyMaterial(color, metal = 0.85) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: metal,
    roughness: 0.22,
    envMapIntensity: 1.2,
  });
}

const glassMaterial = () =>
  new THREE.MeshStandardMaterial({
    color: 0x090c11,
    metalness: 0.35,
    roughness: 0.06,
    transparent: true,
    opacity: 0.88,
  });

const rubberMaterial = () =>
  new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.0, roughness: 0.92 });

const chromeMaterial = () =>
  new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 1.0, roughness: 0.18 });

/** ランプの「にじみ」用の丸いテクスチャ（1枚だけ作って使い回します） */
let _lampGlowTex = null;
function lampGlowTexture() {
  if (_lampGlowTex) return _lampGlowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.28, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  _lampGlowTex = new THREE.CanvasTexture(cv);
  _lampGlowTex.colorSpace = THREE.SRGBColorSpace;
  return _lampGlowTex;
}

/**
 * ランプの手前に薄い加算の板を置いて、夜に「光っている」ように見せます。
 * 発光マテリアルだけだと、少し離れると点にしか見えないためです。
 */
function lampGlow(color, size, opacity = 0.55) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size * 0.62),
    new THREE.MeshBasicMaterial({
      map: lampGlowTexture(), color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    })
  );
  m.renderOrder = 3;
  return m;
}

// ---------------------------------------------------------------- ホイール

function buildWheel(radius, width, rimColor = 0x8f959e) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 24, 1, false),
    rubberMaterial()
  );
  tire.rotation.z = Math.PI / 2;
  g.add(tire);

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.68, radius * 0.68, width * 1.01, 20),
    new THREE.MeshStandardMaterial({ color: rimColor, metalness: 0.95, roughness: 0.28 })
  );
  rim.rotation.z = Math.PI / 2;
  g.add(rim);

  // スポーク（5本）
  const spokeMat = new THREE.MeshStandardMaterial({
    color: rimColor, metalness: 0.95, roughness: 0.3,
  });
  for (let s = 0; s < 5; s++) {
    const sp = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.16, radius * 1.28, width * 0.34),
      spokeMat
    );
    sp.rotation.x = (s / 5) * Math.PI;
    sp.position.x = 0;
    g.add(sp);
  }
  // ブレーキローター
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width * 0.2, 18),
    new THREE.MeshStandardMaterial({ color: 0x35393f, metalness: 0.8, roughness: 0.55 })
  );
  disc.rotation.z = Math.PI / 2;
  g.add(disc);
  return g;
}

// ---------------------------------------------------------------- 車体一式

/**
 * spec（cars.js の1台分）から走行用の Object3D を組み立てます。
 * 戻り値には wheels / brakeLights など、走行中に触る参照をぶら下げます。
 */
export function buildCar(spec, opts = {}) {
  const root = new THREE.Group();
  const D = spec.dims;
  const prof = spec.profile;
  const color = opts.color ?? spec.color;
  const paint = bodyMaterial(color);
  const dark = new THREE.MeshStandardMaterial({
    color: spec.accent ?? 0x15181d, metalness: 0.5, roughness: 0.55,
  });

  // ボディ本体
  const body = new THREE.Mesh(
    loft(prof.body, { length: D.L, width: D.W, height: D.H, squareness: prof.squareness }),
    paint
  );
  body.castShadow = true;
  root.add(body);

  // キャビン（ガラス面）
  const glass = new THREE.Mesh(
    loft(prof.glass, {
      length: D.L, width: D.W, height: D.H,
      squareness: prof.squareness * 0.9,
      capFront: true, capBack: true,
    }),
    glassMaterial()
  );
  root.add(glass);

  // ルーフパネル（ガラスの上面を車体色で覆って「屋根」に見せます）
  const roofSec = prof.glass
    .filter((s) => s[2] > 0.9)
    .map((s) => [s[0], s[2] - 0.055, s[2] + 0.004, s[3] * 0.99, s[4] * 0.99]);
  if (roofSec.length >= 2) {
    const roof = new THREE.Mesh(
      loft(roofSec, {
        length: D.L, width: D.W, height: D.H, squareness: prof.squareness * 0.9,
      }),
      paint
    );
    root.add(roof);
  }

  // フロントリップ / リアバンパー下
  const lip = new THREE.Mesh(new THREE.BoxGeometry(D.W * 0.94, 0.06, 0.30), dark);
  lip.position.set(0, D.H * 0.145, D.L * 0.5 - 0.14);
  root.add(lip);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(D.W * 0.88, 0.08, 0.26), dark);
  diffuser.position.set(0, D.H * 0.19, -D.L * 0.5 + 0.13);
  root.add(diffuser);

  // サイドスカート
  for (const sx of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, D.L * 0.46), dark);
    skirt.position.set(sx * D.W * 0.49, D.H * 0.155, 0);
    root.add(skirt);
  }

  // ドアミラー
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.045, 0.05), dark);
    arm.position.set(sx * (D.W * 0.5 + 0.05), D.H * 0.62, D.L * 0.5 - D.L * 0.42);
    root.add(arm);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.06), paint);
    cap.position.set(sx * (D.W * 0.5 + 0.11), D.H * 0.63, D.L * 0.5 - D.L * 0.42);
    root.add(cap);
  }

  // ヘッドライト
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff4d8, emissive: 0xfff0cc, emissiveIntensity: 2.6, roughness: 0.2,
  });
  const headOff = [];
  if (spec.lights === 'round' || spec.lights === 'popup') {
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.06, 16), headMat);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(sx * D.W * 0.31, D.H * (spec.lights === 'popup' ? 0.46 : 0.40), D.L * 0.5 - 0.06);
      root.add(lamp);
      headOff.push(lamp);
      const gl = lampGlow(0xfff0cc, D.W * 0.75, 0.42);
      gl.position.set(sx * D.W * 0.31, D.H * (spec.lights === 'popup' ? 0.46 : 0.40), D.L * 0.5 + 0.03);
      root.add(gl);
    }
  } else {
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(D.W * 0.30, 0.10, 0.06), headMat);
      lamp.position.set(sx * D.W * 0.31, D.H * 0.42, D.L * 0.5 - 0.05);
      root.add(lamp);
      headOff.push(lamp);
      const gl = lampGlow(0xfff0cc, D.W * 0.75, 0.42);
      gl.position.set(sx * D.W * 0.31, D.H * 0.42, D.L * 0.5 + 0.03);
      root.add(gl);
    }
  }

  // テールランプ（バトル中の視認性の要なので少し大きめ）
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff2418, emissive: 0xff1a0c, emissiveIntensity: 1.5, roughness: 0.35,
  });
  const brakeLights = [];
  const tailGlows = [];
  for (const sx of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(D.W * 0.30, 0.11, 0.05), tailMat);
    t.position.set(sx * D.W * 0.31, D.H * 0.46, -D.L * 0.5 + 0.03);
    root.add(t);
    brakeLights.push(t);
    const gl = lampGlow(0xff2a16, D.W * 0.85, 0.5);
    gl.position.set(sx * D.W * 0.31, D.H * 0.46, -D.L * 0.5 - 0.02);
    gl.rotation.y = Math.PI;
    root.add(gl);
    tailGlows.push(gl);
  }

  // マフラー
  for (const sx of [-1, 1]) {
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.14, 12), chromeMaterial()
    );
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(sx * D.W * 0.24, D.H * 0.19, -D.L * 0.5 + 0.02);
    root.add(pipe);
  }

  // リアウイング
  if (spec.wing) {
    const w = spec.wing;
    const z = (0.5 - w.t) * D.L;
    if (w.type === 'whale') {
      const tray = new THREE.Mesh(new THREE.BoxGeometry(D.W * w.w, 0.05, D.L * 0.20), paint);
      tray.position.set(0, D.H * w.h, z);
      tray.rotation.x = -0.06;
      root.add(tray);
      const lipw = new THREE.Mesh(new THREE.BoxGeometry(D.W * w.w, 0.09, 0.05), dark);
      lipw.position.set(0, D.H * w.h + 0.04, z - D.L * 0.10);
      root.add(lipw);
    } else {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(D.W * w.w, 0.035, 0.24), dark);
      blade.position.set(0, D.H * w.h + w.tall, z);
      blade.rotation.x = -0.13;
      root.add(blade);
      for (const sx of [-1, 1]) {
        const stay = new THREE.Mesh(new THREE.BoxGeometry(0.035, w.tall, 0.10), dark);
        stay.position.set(sx * D.W * w.w * 0.38, D.H * w.h + w.tall * 0.5, z);
        root.add(stay);
      }
    }
  }

  // ホイール4輪
  const wr = spec.wheelR;
  const ww = D.W * 0.155;
  const wheels = [];
  const axleZ = [D.WB * 0.5, -D.WB * 0.5];
  const track = D.W * 0.5 - ww * 0.52;
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const sx = i % 2 === 0 ? -1 : 1;
    const pivot = new THREE.Group();               // ステア用
    const spin = buildWheel(wr, ww * (front ? 1 : 1.12));
    pivot.add(spin);
    pivot.position.set(sx * track, wr, axleZ[front ? 0 : 1]);
    root.add(pivot);
    wheels.push({ pivot, spin, front, side: sx });
  }

  // 車高を合わせる（タイヤ半径ぶん持ち上げ済みなので、ボディを少しだけ落とす）
  body.position.y = 0;
  root.userData = { spec, brakeLights, headOff, wheels };
  return { root, wheels, brakeLights, tailGlows, headlights: headOff, paint, spec };
}

/** 一般車（交通量）用の簡易モデル。3種類をランダムに使い分けます。 */
const TRAFFIC_PROFILE = {
  body: [
    [0.00, 0.20, 0.46, 0.66, 0.76],
    [0.06, 0.16, 0.54, 0.94, 0.98],
    [0.18, 0.15, 0.58, 1.00, 1.00],
    [0.34, 0.15, 0.60, 1.00, 0.98],
    [0.62, 0.15, 0.60, 1.00, 0.98],
    [0.86, 0.15, 0.60, 1.00, 0.97],
    [0.96, 0.18, 0.58, 0.94, 0.86],
    [1.00, 0.26, 0.54, 0.78, 0.68],
  ],
  glass: [
    [0.30, 0.59, 0.63, 0.92, 0.84],
    [0.40, 0.62, 0.90, 0.90, 0.82],
    [0.50, 0.63, 1.00, 0.89, 0.80],
    [0.74, 0.63, 1.00, 0.89, 0.80],
    [0.86, 0.62, 0.88, 0.88, 0.80],
    [0.94, 0.60, 0.64, 0.88, 0.82],
  ],
  squareness: 4.8,
};

export function buildTrafficCar(kind, color, rand) {
  const root = new THREE.Group();
  if (kind === 'truck') {
    const cabH = 2.5, boxH = 3.1, W = 2.4, L = 11.5;
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(W, cabH, 2.6),
      new THREE.MeshStandardMaterial({ color: 0xd6d8dc, metalness: 0.4, roughness: 0.5 })
    );
    cab.position.set(0, cabH * 0.5 + 0.55, L * 0.5 - 1.4);
    root.add(cab);
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(W, boxH, L - 3.4),
      new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.7 })
    );
    box.position.set(0, boxH * 0.5 + 0.85, -1.5);
    root.add(box);
    const wsMat = new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.1, metalness: 0.4 });
    const ws = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 1.0, 0.1), wsMat);
    ws.position.set(0, 2.35, L * 0.5 - 0.16);
    root.add(ws);
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xff2418, emissive: 0xff1a0c, emissiveIntensity: 1.2 });
    for (const sx of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.06), tailMat);
      t.position.set(sx * 0.9, 1.0, -L * 0.5 + 0.02);
      root.add(t);
      const tg = lampGlow(0xff2a16, 1.0, 0.42);
      tg.position.set(sx * 0.9, 1.0, -L * 0.5 - 0.03);
      tg.rotation.y = Math.PI;
      root.add(tg);
    }
    const wheels = [];
    for (const zz of [L * 0.5 - 1.6, -L * 0.5 + 2.6, -L * 0.5 + 1.3]) {
      for (const sx of [-1, 1]) {
        const w = buildWheel(0.5, 0.34, 0x50545c);
        w.position.set(sx * (W * 0.5 - 0.16), 0.5, zz);
        root.add(w);
        wheels.push(w);
      }
    }
    return { root, wheels, length: L, width: W };
  }

  const tall = kind === 'van' ? 1.9 : 1.45;
  const L = kind === 'van' ? 4.9 : 4.5;
  const W = kind === 'van' ? 1.75 : 1.72;
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.4 });
  const body = new THREE.Mesh(
    loft(TRAFFIC_PROFILE.body, { length: L, width: W, height: tall, squareness: 4.8 }),
    paint
  );
  root.add(body);
  const glass = new THREE.Mesh(
    loft(TRAFFIC_PROFILE.glass, { length: L, width: W, height: tall, squareness: 4.4 }),
    glassMaterial()
  );
  root.add(glass);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff2418, emissive: 0xff1a0c, emissiveIntensity: 1.4 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff2d6, emissive: 0xfff0cc, emissiveIntensity: 2.0 });
  for (const sx of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(W * 0.28, 0.12, 0.05), tailMat);
    t.position.set(sx * W * 0.32, tall * 0.46, -L * 0.5 + 0.02);
    root.add(t);
    const tg = lampGlow(0xff2a16, W * 0.8, 0.45);
    tg.position.set(sx * W * 0.32, tall * 0.46, -L * 0.5 - 0.03);
    tg.rotation.y = Math.PI;
    root.add(tg);
    const h = new THREE.Mesh(new THREE.BoxGeometry(W * 0.26, 0.10, 0.05), headMat);
    h.position.set(sx * W * 0.32, tall * 0.44, L * 0.5 - 0.03);
    root.add(h);
    const hg = lampGlow(0xfff2d6, W * 0.9, 0.5);
    hg.position.set(sx * W * 0.32, tall * 0.44, L * 0.5 + 0.04);
    root.add(hg);
  }
  const wheels = [];
  for (const zz of [L * 0.31, -L * 0.31]) {
    for (const sx of [-1, 1]) {
      const w = buildWheel(0.31, 0.22, 0x6a6f78);
      w.position.set(sx * (W * 0.5 - 0.12), 0.31, zz);
      root.add(w);
      wheels.push(w);
    }
  }
  return { root, wheels, length: L, width: W };
}

export { buildWheel };
