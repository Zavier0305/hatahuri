import * as THREE from 'three';
import { rng, clamp, lerp, TAU } from './util.js';
import { ROAD } from './track.js';

// ---------------------------------------------------------------- 空と海

export function buildSky(scene) {
  const geo = new THREE.SphereGeometry(9000, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x05070f) },
      mid: { value: new THREE.Color(0x121a30) },
      hor: { value: new THREE.Color(0x3a2a44) },
      glow: { value: new THREE.Color(0x6b4a3a) },
    },
    vertexShader: `
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: `
      uniform vec3 top, mid, hor, glow;
      varying vec3 vP;
      void main(){
        float h = normalize(vP).y;
        vec3 c = mix(hor, mid, smoothstep(-0.02, 0.30, h));
        c = mix(c, top, smoothstep(0.25, 0.85, h));
        // 地平線ぎわの街明かり
        c += glow * pow(clamp(1.0 - abs(h) * 6.0, 0.0, 1.0), 2.0) * 0.55;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);

  // 星
  const N = 1400;
  const p = new Float32Array(N * 3);
  const r = rng(7);
  for (let i = 0; i < N; i++) {
    const a = r() * TAU;
    const y = 0.08 + r() * 0.92;
    const rad = Math.sqrt(1 - y * y);
    p[i * 3] = Math.cos(a) * rad * 7600;
    p[i * 3 + 1] = y * 7600;
    p[i * 3 + 2] = Math.sin(a) * rad * 7600;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  const stars = new THREE.Points(
    sg,
    new THREE.PointsMaterial({
      color: 0xbfd0ff, size: 16, sizeAttenuation: true,
      transparent: true, opacity: 0.8, fog: false, depthWrite: false,
    })
  );
  stars.frustumCulled = false;
  scene.add(stars);

  // 月
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(150, 32),
    new THREE.MeshBasicMaterial({ color: 0xf6f3e6, transparent: true, opacity: 0.95, fog: false })
  );
  moon.position.set(3200, 2400, -5200);
  moon.lookAt(0, 0, 0);
  scene.add(moon);
  return { sky, stars, moon };
}

export function buildSea(scene) {
  const geo = new THREE.PlaneGeometry(24000, 24000, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0b1526, roughness: 0.30, metalness: 0.45,
    emissive: 0x0a1220, emissiveIntensity: 0.55,
  });
  const sea = new THREE.Mesh(geo, mat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -2.0;
  scene.add(sea);
  return sea;
}

// ---------------------------------------------------------------- テクスチャ

const WIN_COLS = 6, WIN_ROWS = 8;   // テクスチャ1枚に入る窓の数
function windowTexture(seedNum, cols = WIN_COLS, rows = WIN_ROWS) {
  const cv = document.createElement('canvas');
  cv.width = 192; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#0b0d13';
  g.fillRect(0, 0, cv.width, cv.height);
  const r = rng(seedNum);
  const cw = cv.width / cols, ch = cv.height / rows;
  const tints = ['#ffe6b0', '#d8e6ff', '#fff2cf', '#bcd4ff', '#ffd9a0'];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (r() < 0.55) continue;
      g.fillStyle = tints[(r() * tints.length) | 0];
      g.globalAlpha = 0.35 + r() * 0.65;
      g.fillRect(x * cw + cw * 0.22, y * ch + ch * 0.24, cw * 0.56, ch * 0.44);
    }
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,243,222,0.95)');
  grd.addColorStop(0.35, 'rgba(255,231,190,0.38)');
  grd.addColorStop(1, 'rgba(255,222,165,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture(text, sub) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#0d4a2c';
  g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = '#e9eef0';
  g.lineWidth = 6;
  g.strokeRect(9, 9, cv.width - 18, cv.height - 18);
  g.fillStyle = '#f2f6f7';
  g.font = 'bold 58px "Hiragino Sans","Noto Sans JP",sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 34, 56);
  g.font = '26px "Hiragino Sans",sans-serif';
  g.fillStyle = '#cfe6da';
  g.fillText(sub, 36, 100);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- 街灯

export function buildStreetLights(track, scene) {
  const group = new THREE.Group();
  const step = 45; // 45mおき
  const count = Math.floor(track.length / step);
  const poleG = new THREE.CylinderGeometry(0.11, 0.15, 9.2, 6);
  poleG.translate(0, 4.6, 0);
  const poleM = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.7, metalness: 0.4 });
  const poles = new THREE.InstancedMesh(poleG, poleM, count);

  const headG = new THREE.BoxGeometry(0.55, 0.16, 1.5);
  const headM = new THREE.MeshStandardMaterial({
    color: 0xffe7bb, emissive: 0xffd79a, emissiveIntensity: 5.0, roughness: 0.4,
  });
  const heads = new THREE.InstancedMesh(headG, headM, count);

  const armG = new THREE.BoxGeometry(0.10, 0.10, 2.2);
  const arms = new THREE.InstancedMesh(armG, poleM, count);

  const poolG = new THREE.PlaneGeometry(19, 32);
  const poolM = new THREE.MeshBasicMaterial({
    map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.28,
  });
  const pools = new THREE.InstancedMesh(poolG, poolM, count);
  pools.renderOrder = 2;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  const sm = {};
  const basis = new THREE.Matrix4();
  const back = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const s = i * step;
    track.sample(s, sm);
    const side = i % 2 === 0 ? -1 : 1;
    const u = side * (ROAD.halfRoad + 1.3);
    // 右手系：+X=進行方向の右（lat）、+Y=上、+Z=後ろ
    basis.makeBasis(sm.lat, sm.up, back.copy(sm.tan).negate());
    q.setFromRotationMatrix(basis);

    pos.copy(sm.pos).addScaledVector(sm.lat, u).addScaledVector(sm.up, 0.25);
    m.compose(pos, q, sc);
    poles.setMatrixAt(i, m);

    pos.copy(sm.pos).addScaledVector(sm.lat, u - side * 1.05).addScaledVector(sm.up, 9.1);
    const q2 = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
    m.compose(pos, q2, sc);
    arms.setMatrixAt(i, m);

    pos.copy(sm.pos).addScaledVector(sm.lat, u - side * 2.1).addScaledVector(sm.up, 9.05);
    m.compose(pos, q, sc);
    heads.setMatrixAt(i, m);

    // 路面の光だまり
    const qp = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    pos.copy(sm.pos).addScaledVector(sm.lat, u - side * 5.5).addScaledVector(sm.up, 0.06);
    m.compose(pos, qp, sc);
    pools.setMatrixAt(i, m);
  }
  for (const im of [poles, arms, heads, pools]) { im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; }
  group.add(poles, arms, heads, pools);
  scene.add(group);
  return { group, pools, heads };
}

// ---------------------------------------------------------------- 高架の橋脚

export function buildPiers(track, scene) {
  const step = 42;
  const count = Math.floor(track.length / step);
  const g = new THREE.BoxGeometry(2.6, 1, 3.4);
  g.translate(0, -0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9, metalness: 0.05 });
  const im = new THREE.InstancedMesh(g, mat, count);
  const beamG = new THREE.BoxGeometry(ROAD.halfRoad * 2 + 2, 1.2, 3.0);
  const beams = new THREE.InstancedMesh(beamG, mat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const pos = new THREE.Vector3(), sm = {}, basis = new THREE.Matrix4();
  const back = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    track.sample(i * step, sm);
    basis.makeBasis(sm.lat, sm.up, back.copy(sm.tan).negate());
    q.setFromRotationMatrix(basis);
    const h = Math.max(3, sm.pos.y + 3.0);
    pos.copy(sm.pos).addScaledVector(sm.up, -1.2);
    sc.set(1, h, 1);
    m.compose(pos, q, sc);
    im.setMatrixAt(i, m);
    sc.set(1, 1, 1);
    pos.copy(sm.pos).addScaledVector(sm.up, -0.7);
    m.compose(pos, q, sc);
    beams.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  beams.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false; beams.frustumCulled = false;
  const grp = new THREE.Group();
  grp.add(im, beams);
  scene.add(grp);
  return grp;
}

// ---------------------------------------------------------------- 路側の細かい造作

/**
 * ガードレールの支柱と、壁面の視線誘導標（オレンジの反射板）。
 * 一定間隔で流れていく小さな物体があると、速度感が一気に上がります。
 */
export function buildRoadside(track, scene) {
  const group = new THREE.Group();
  const sm = {}, basis = new THREE.Matrix4(), q = new THREE.Quaternion();
  const back = new THREE.Vector3(), pos = new THREE.Vector3();
  const m = new THREE.Matrix4(), sc = new THREE.Vector3(1, 1, 1);

  // --- 支柱（6mおき・左右）
  const POST_STEP = 6;
  const pn = Math.floor(track.length / POST_STEP);
  const postG = new THREE.BoxGeometry(0.10, 0.86, 0.10);
  postG.translate(0, 0.43, 0);
  const posts = new THREE.InstancedMesh(
    postG,
    new THREE.MeshStandardMaterial({ color: 0x6f7681, roughness: 0.6, metalness: 0.6 }),
    pn * 2
  );
  let k = 0;
  for (let i = 0; i < pn; i++) {
    track.sample(i * POST_STEP, sm);
    basis.makeBasis(sm.lat, sm.up, back.copy(sm.tan).negate());
    q.setFromRotationMatrix(basis);
    for (const side of [-1, 1]) {
      pos.copy(sm.pos).addScaledVector(sm.lat, side * (ROAD.halfRoad + 0.5)).addScaledVector(sm.up, 0.16);
      m.compose(pos, q, sc);
      posts.setMatrixAt(k++, m);
    }
  }
  posts.count = k;
  posts.instanceMatrix.needsUpdate = true;
  posts.frustumCulled = false;
  group.add(posts);

  // --- 視線誘導標（16mおき・路肩側と中央分離帯側）
  const DEL_STEP = 16;
  const dn = Math.floor(track.length / DEL_STEP);
  const delG = new THREE.BoxGeometry(0.05, 0.13, 0.11);
  const dels = new THREE.InstancedMesh(
    delG,
    new THREE.MeshStandardMaterial({
      color: 0xff9c2e, emissive: 0xff8a12, emissiveIntensity: 3.2, roughness: 0.4,
    }),
    dn * 4
  );
  k = 0;
  const uList = [
    -(ROAD.halfRoad + 0.45), -(ROAD.medianHalf - 0.04),
    ROAD.medianHalf - 0.04, ROAD.halfRoad + 0.45,
  ];
  for (let i = 0; i < dn; i++) {
    track.sample(i * DEL_STEP, sm);
    basis.makeBasis(sm.lat, sm.up, back.copy(sm.tan).negate());
    q.setFromRotationMatrix(basis);
    for (const u of uList) {
      pos.copy(sm.pos).addScaledVector(sm.lat, u).addScaledVector(sm.up, 0.78);
      m.compose(pos, q, sc);
      dels.setMatrixAt(k++, m);
    }
  }
  dels.count = k;
  dels.instanceMatrix.needsUpdate = true;
  dels.frustumCulled = false;
  group.add(dels);

  scene.add(group);
  return group;
}

// ---------------------------------------------------------------- ビル群

/**
 * 「その座標がコースからどれだけ離れているか」を高速に判定するための格子。
 * コース点を100mのマスに配り、近傍9マスだけを調べます。
 * これを使わないと、ループが自分の近くを通る場所で建物が路上に生えてしまいます。
 */
function trackClearance(track, cell = 100) {
  const grid = new Map();
  const key = (ix, iz) => `${ix},${iz}`;
  for (let i = 0; i < track.n; i += 2) {          // 10mおき
    const x = track.pos[i * 3], z = track.pos[i * 3 + 2];
    const k = key(Math.floor(x / cell), Math.floor(z / cell));
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  return function isClear(x, z, need) {
    const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
    const r = Math.ceil(need / cell);
    const n2 = need * need;
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b++) {
        const list = grid.get(key(ix + a, iz + b));
        if (!list) continue;
        for (const i of list) {
          const dx = x - track.pos[i * 3];
          const dz = z - track.pos[i * 3 + 2];
          if (dx * dx + dz * dz < n2) return false;
        }
      }
    }
    return true;
  };
}

export function buildCity(track, scene, seed = 99) {
  const r = rng(seed);
  const isClear = trackClearance(track);
  const group = new THREE.Group();
  const near = [];   // 沿道のビル
  const far = [];    // 遠景のスカイライン

  const sm = {};
  for (let s = 0; s < track.length; s += 26) {
    const kind = track.zoneAt(s);
    track.sample(s, sm);
    const density = kind === 'city' ? 0.85 : kind === 'bay' ? 0.16 : 0.05;
    for (const side of [-1, 1]) {
      if (r() > density) continue;
      const dist = ROAD.halfRoad + 42 + r() * 240;
      const h = 32 + Math.pow(r(), 1.7) * 122;
      const w = 11 + r() * 24;
      const d = 11 + r() * 24;
      const p = sm.pos.clone().addScaledVector(sm.lat, side * dist);
      p.y = -3;
      // コース本体（他の区間も含む）に被る位置には建てない
      if (!isClear(p.x, p.z, ROAD.halfRoad + 10 + Math.hypot(w, d) * 0.5)) continue;
      near.push({ p, w, h, d, rot: r() * TAU });
    }
  }
  // 遠景（水平線に並ぶ高層ビル）
  for (let i = 0; i < 620 && far.length < 420; i++) {
    const a = r() * TAU;
    const rad = 2600 + r() * 3400;
    const h = 70 + Math.pow(r(), 2.2) * 250;
    const w = 26 + r() * 46, d = 26 + r() * 46;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    // 遠景のビルもコースの真上に来ることがあるので同じ判定を通す
    if (!isClear(x, z, ROAD.halfRoad + 14 + Math.hypot(w, d) * 0.5)) continue;
    far.push({ p: new THREE.Vector3(x, -3, z), w, h, d, rot: r() * TAU });
  }

  // 窓1枚が約4.2m×3.4mになるよう、繰り返し数を「必要な窓数 ÷ テクスチャ1枚の窓数」で決めます。
  // （ここを窓数そのものにすると窓が極小になり、遠目にはただの明るい箱になってしまいます）
  const repeatFor = (w, h) => [
    Math.max(1, Math.round(w / 4.2 / WIN_COLS)),
    Math.max(1, Math.round(h / 3.4 / WIN_ROWS)),
  ];
  const mk = (list, texSeed, repU, repV, emis) => {
    const tex = windowTexture(texSeed);
    tex.repeat.set(repU, repV);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d1017, roughness: 0.88, metalness: 0.1,
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: emis,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      q.setFromAxisAngle(axis, b.rot);
      sc.set(b.w, b.h, b.d);
      m.compose(b.p, q, sc);
      im.setMatrixAt(i, m);
    }
    im.instanceMatrix.needsUpdate = true;
    return im;
  };

  // 高さ帯で3つに分け、それぞれ窓の縮尺を合わせる
  const bands = [[0, 70], [70, 120], [120, 1e9]];
  bands.forEach(([lo, hi], bi) => {
    const list = near.filter((b) => b.h >= lo && b.h < hi);
    if (!list.length) return;
    const avgW = list.reduce((a, b) => a + b.w, 0) / list.length;
    const avgH = list.reduce((a, b) => a + b.h, 0) / list.length;
    const [ru, rv] = repeatFor(avgW, avgH);
    group.add(mk(list, 31 + bi * 7, ru, rv, 0.85));
  });
  bands.forEach(([lo, hi], bi) => {
    const list = far.filter((b) => b.h >= lo && b.h < hi);
    if (!list.length) return;
    const avgW = list.reduce((a, b) => a + b.w, 0) / list.length;
    const avgH = list.reduce((a, b) => a + b.h, 0) / list.length;
    const [ru, rv] = repeatFor(avgW, avgH);
    const mesh = mk(list, 57 + bi * 11, ru, rv, 1.05);
    mesh.frustumCulled = false;
    group.add(mesh);
  });

  // 航空障害灯（赤い点滅）
  const redG = new THREE.SphereGeometry(2.6, 6, 6);
  const redM = new THREE.MeshBasicMaterial({ color: 0xff3020 });
  const reds = new THREE.InstancedMesh(redG, redM, 70);
  const m2 = new THREE.Matrix4(), q0 = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1);
  const tall = far.filter((b) => b.h > 200).slice(0, 70);
  for (let i = 0; i < reds.count; i++) {
    const b = tall[i % Math.max(1, tall.length)] || far[i];
    m2.compose(new THREE.Vector3(b.p.x, b.p.y + b.h - 4, b.p.z), q0, s1);
    reds.setMatrixAt(i, m2);
  }
  reds.instanceMatrix.needsUpdate = true;
  reds.frustumCulled = false;
  group.add(reds);

  scene.add(group);
  return { group, reds };
}

// ---------------------------------------------------------------- トンネル

export function buildTunnels(track, scene) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    // 面の法線がトンネル内側を向くように張っているので FrontSide のままで内壁が見えます
    color: 0xb9bfc7, roughness: 0.88, metalness: 0.05, side: THREE.FrontSide,
    emissive: 0x2f353d, emissiveIntensity: 1.0,
  });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0 });
  const sm = {};
  const basis = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const backT = new THREE.Vector3();

  // アーチ断面（u, y）
  const arch = [];
  const AW = ROAD.halfRoad + 1.6, AH = 6.6;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const a = Math.PI * t;
    arch.push([-Math.cos(a) * AW, 0.2 + Math.sin(a) * AH]);
  }

  for (const z of track.zones) {
    if (z.kind !== 'tunnel') continue;
    const from = z.from, to = z.to;
    const rows = Math.max(2, Math.floor((to - from) / 8));
    const cols = arch.length;
    const posA = new Float32Array((rows + 1) * cols * 3);
    const idx = [];
    for (let r = 0; r <= rows; r++) {
      const s = lerp(from, to, r / rows);
      track.sample(s, sm);
      for (let c = 0; c < cols; c++) {
        const o = (r * cols + c) * 3;
        const [u, y] = arch[c];
        posA[o] = sm.pos.x + sm.lat.x * u + sm.up.x * y;
        posA[o + 1] = sm.pos.y + sm.lat.y * u + sm.up.y * y;
        posA[o + 2] = sm.pos.z + sm.lat.z * u + sm.up.z * y;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, cc = a + cols, d = cc + 1;
        idx.push(a, cc, d, a, d, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    group.add(new THREE.Mesh(g, mat));

    // 天井のライン照明
    const lampCount = Math.floor((to - from) / 14);
    const lg = new THREE.BoxGeometry(0.5, 0.14, 5.5);
    const lm = new THREE.InstancedMesh(lg, lampMat, Math.max(1, lampCount * 2));
    const m = new THREE.Matrix4(), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < lampCount; i++) {
      const s = from + i * 14 + 7;
      track.sample(s, sm);
      basis.makeBasis(sm.lat, sm.up, backT.copy(sm.tan).negate());
      q.setFromRotationMatrix(basis);
      for (const side of [-1, 1]) {
        p.copy(sm.pos).addScaledVector(sm.lat, side * 6.5).addScaledVector(sm.up, 6.0);
        m.compose(p, q, sc);
        lm.setMatrixAt(k++, m);
      }
    }
    lm.count = k;
    lm.instanceMatrix.needsUpdate = true;
    group.add(lm);
  }
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------- 案内標識

const SIGN_TEXTS = [
  ['湾岸線', 'Wangan Line'],
  ['大黒ふ頭', 'Daikoku Futo'],
  ['ベイブリッジ', 'Bay Bridge'],
  ['有明', 'Ariake'],
  ['辰巳', 'Tatsumi'],
  ['葛西', 'Kasai'],
  ['浮島', 'Ukishima'],
  ['空港中央', 'Airport Central'],
  ['市川', 'Ichikawa'],
  ['幸浦', 'Sachiura'],
];

export function buildSigns(track, scene) {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.6, metalness: 0.6 });
  const sm = {}, basis = new THREE.Matrix4(), q = new THREE.Quaternion();
  const back = new THREE.Vector3();
  let k = 0;
  for (let s = 400; s < track.length; s += 760) {
    if (track.zoneAt(s) === 'tunnel') continue;
    track.sample(s, sm);
    basis.makeBasis(sm.lat, sm.up, back.copy(sm.tan).negate());
    q.setFromRotationMatrix(basis);
    const g = new THREE.Group();
    g.position.copy(sm.pos);
    g.quaternion.copy(q);

    const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD.halfRoad + 1.5, 0.35, 0.35), frameMat);
    beam.position.set(-ROAD.halfRoad / 2 - 0.5, 6.4, 0);
    g.add(beam);
    for (const u of [-ROAD.halfRoad - 0.4, -0.9]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6.4, 0.3), frameMat);
      post.position.set(u, 3.2, 0);
      g.add(post);
    }
    const [t1, t2] = SIGN_TEXTS[k % SIGN_TEXTS.length];
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(7.4, 1.85),
      new THREE.MeshStandardMaterial({
        map: signTexture(t1, t2), emissiveMap: signTexture(t1, t2),
        emissive: 0xffffff, emissiveIntensity: 0.34, roughness: 0.7,
      })
    );
    board.position.set(-6.6, 5.2, 0.22);   // 面は進行方向の手前を向く
    g.add(board);
    group.add(g);
    k++;
  }
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------- 吊り橋

export function buildBridges(track, scene) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6d7078, roughness: 0.6, metalness: 0.35 });
  const cableMat = new THREE.LineBasicMaterial({ color: 0x9fa8b6, transparent: true, opacity: 0.42 });
  const sm = {}, basis = new THREE.Matrix4(), q = new THREE.Quaternion();
  const back = new THREE.Vector3();
  for (const z of track.zones) {
    if (z.kind !== 'bridge') continue;
    const mid = (z.from + z.to) / 2;
    for (const s of [z.from + 90, mid, z.to - 90]) {
      track.sample(s, sm);
      basis.makeBasis(sm.lat, sm.up, back.copy(sm.tan).negate());
      q.setFromRotationMatrix(basis);
      const g = new THREE.Group();
      g.position.copy(sm.pos);
      g.quaternion.copy(q);
      const H = 62;
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(3.0, H, 3.6), mat);
        leg.position.set(side * (ROAD.halfRoad + 3.2), H / 2 - 12, 0);
        g.add(leg);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(ROAD.halfRoad * 2 + 9, 3.0, 3.6), mat);
      top.position.set(0, H - 14, 0);
      g.add(top);
      // ケーブル
      const pts = [];
      for (const side of [-1, 1]) {
        for (let i = 1; i <= 5; i++) {
          const dz = i * 34;
          pts.push(
            new THREE.Vector3(side * (ROAD.halfRoad + 3.2), H - 16, 0),
            new THREE.Vector3(side * (ROAD.halfRoad + 1.0), 1.5, dz),
            new THREE.Vector3(side * (ROAD.halfRoad + 3.2), H - 16, 0),
            new THREE.Vector3(side * (ROAD.halfRoad + 1.0), 1.5, -dz)
          );
        }
      }
      const cg = new THREE.BufferGeometry().setFromPoints(pts);
      g.add(new THREE.LineSegments(cg, cableMat));
      group.add(g);
    }
  }
  scene.add(group);
  return group;
}
