import * as THREE from 'three';
import { rng, clamp, lerp, TAU } from './util.js';
import { ROAD } from './track.js';

// ---------------------------------------------------------------- 空と海

export function buildSky(scene) {
  const geo = new THREE.SphereGeometry(9000, 48, 32);
  // 明け方（薄明）の空。太陽はまだ地平線の下にあり、東の空だけが焼けています。
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x070d1e) },   // 天頂：まだ夜
      upper: { value: new THREE.Color(0x16233f) },
      lower: { value: new THREE.Color(0x2b4767) },    // 地平線ぎわ：白みはじめた青
      dawn: { value: new THREE.Color(0xd87a44) },     // 東の空の焼け
      dawnDir: { value: new THREE.Vector3(0.82, 0, 0.57).normalize() },
    },
    vertexShader: `
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: `
      uniform vec3 zenith, upper, lower, dawn;
      uniform vec3 dawnDir;
      varying vec3 vP;
      void main(){
        vec3 d = normalize(vP);
        float h = d.y;
        vec3 c = mix(lower, upper, smoothstep(-0.03, 0.32, h));
        c = mix(c, zenith, smoothstep(0.22, 0.9, h));
        // 東の空だけを焼く（方位と高度の両方で絞り込みます）
        float az = max(0.0, dot(normalize(vec3(d.x, 0.0, d.z)), dawnDir));
        float band = pow(clamp(1.0 - abs(h) * 4.2, 0.0, 1.0), 2.2);
        c += dawn * pow(az, 3.0) * band * 0.85;
        // 反対側にもわずかな街明かりの照り返し
        c += vec3(0.10, 0.07, 0.05) * band * 0.5;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);

  // 星（東の空と地平線ぎわでは薄れます）
  const N = 1100;
  const p = new Float32Array(N * 3);
  const r = rng(7);
  let k = 0;
  for (let i = 0; i < N; i++) {
    const a = r() * TAU;
    const y = 0.10 + r() * 0.90;
    const rad = Math.sqrt(1 - y * y);
    const dx = Math.cos(a) * rad, dz = Math.sin(a) * rad;
    // 東側（明けている方角）の低い星は間引く
    const east = dx * 0.82 + dz * 0.57;
    if (east > 0.2 && y < 0.45 && r() < 0.85) continue;
    if (y < 0.25 && r() < 0.6) continue;
    p[k * 3] = dx * 7600; p[k * 3 + 1] = y * 7600; p[k * 3 + 2] = dz * 7600;
    k++;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(p.slice(0, k * 3), 3));
  const stars = new THREE.Points(
    sg,
    new THREE.PointsMaterial({
      color: 0xcfdcff, size: 15, sizeAttenuation: true,
      transparent: true, opacity: 0.62, fog: false, depthWrite: false,
    })
  );
  stars.frustumCulled = false;
  scene.add(stars);

  // 沈みかけの月（明けていく側の反対に置きます）
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(120, 32),
    new THREE.MeshBasicMaterial({ color: 0xe8eaf2, transparent: true, opacity: 0.75, fog: false })
  );
  moon.position.set(-4600, 1500, -3200);
  moon.lookAt(0, 0, 0);
  scene.add(moon);
  return { sky, stars, moon };
}

export function buildEnvironment(renderer, skyMesh) {
  const envScene = new THREE.Scene();
  const sky = skyMesh.clone();
  sky.material = skyMesh.material.clone();
  sky.scale.setScalar(0.02);
  envScene.add(sky);

  // 地平線の街明かり（帯）。明け方なので東側だけ少し明るくします。
  const bandMat = new THREE.MeshBasicMaterial({ color: 0xffb974, side: THREE.DoubleSide });
  const dawnMat = new THREE.MeshBasicMaterial({ color: 0xffb27a, side: THREE.DoubleSide });
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * TAU;
    const east = Math.cos(a) * 0.82 + Math.sin(a) * 0.57;
    const q = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 3 + Math.random() * 7),
      east > 0.25 ? dawnMat : bandMat
    );
    q.position.set(Math.cos(a) * 90, 2 + Math.random() * 6, Math.sin(a) * 90);
    q.lookAt(0, 4, 0);
    envScene.add(q);
  }
  // 頭上の街灯列（ボディに縦に流れるハイライトを作ります）
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff0d2 });
  for (const side of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(3, 26), lampMat);
      q.position.set(side * 16, 26, i * 34);
      q.rotation.x = Math.PI / 2;
      envScene.add(q);
    }
  }
  // 足元（路面）の暗い面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshBasicMaterial({ color: 0x0a0d14 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -6;
  envScene.add(ground);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  return rt.texture;
}

export function buildSea(scene) {
  const geo = new THREE.PlaneGeometry(24000, 24000, 1, 1);
  // 水は金属ではなく誘電体です。metalness を上げると反射が水面の色に染まり、
  // 環境マップに焼いた夜明けの帯をそのまま拾って「砂浜」に見えていました。
  // metalness 0 にすると、真上から見ると暗く・浅い角度でだけ明るく映る
  // （フレネル反射）という、実際の水面の見え方になります。
  // 前回 envMapIntensity を下げすぎて、海がただの黒い面になりました
  // （タイトル画面の平均輝度が 42 → 22 まで落ちた）。
  // 暗くすべきなのは「真上から見たとき」だけで、水平に近い角度では
  // 夜明けの空を強く映して光の道ができるのが本来の見え方です。
  // 粗さを少し上げると、その反射がさざ波状に広がります。
  const mat = new THREE.MeshStandardMaterial({
    color: 0x070d18, roughness: 0.22, metalness: 0.0,
    emissive: 0x0a1120, emissiveIntensity: 0.55,
    envMapIntensity: 1.8,
  });
  const sea = new THREE.Mesh(geo, mat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -2.0;
  scene.add(sea);
  return sea;
}

// ---------------------------------------------------------------- テクスチャ

const WIN_COLS = 8, WIN_ROWS = 12;   // テクスチャ1枚に入る窓の数
/**
 * ビルの窓。
 *
 * 以前は「1枚1枚を独立に45%の確率で点ける」だけだったので、点いた窓が
 * 一様に散らばり、遠目にはただのノイズに見えていました。実際のビルは
 * ・フロア単位で明かりが揃う（残業しているフロア／消えているフロア）
 * ・階段室や設備の縦のラインだけが点いている
 * ・機械室の階は窓がない
 * という構造を持っていて、その規則性こそが「ビルらしさ」になります。
 */
function windowTexture(seedNum, cols = WIN_COLS, rows = WIN_ROWS) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 512;
  const g = cv.getContext('2d');
  const r = rng(seedNum);
  g.fillStyle = '#0a0c11';
  g.fillRect(0, 0, cv.width, cv.height);

  const cw = cv.width / cols, ch = cv.height / rows;
  // 建物ごとに照明の色味を決めます（蛍光灯の白／電球色）
  const warm = r() < 0.55;
  const tints = warm
    ? ['#ffe6b0', '#fff2cf', '#ffd9a0', '#ffeccb']
    : ['#dfeaff', '#cfe0ff', '#eef4ff', '#bcd4ff'];

  // 縦の芯（階段室・エレベーターホール）は上から下までだいたい点いています
  const coreX = (r() * cols) | 0;
  // 設備階（窓のない帯）
  const plantRow = r() < 0.5 ? (1 + r() * (rows - 2)) | 0 : -1;

  for (let y = 0; y < rows; y++) {
    if (y === plantRow) continue;                 // 機械室の階：窓なし
    const floorLit = r();                         // その階全体の在館率
    for (let x = 0; x < cols; x++) {
      const isCore = x === coreX;
      const on = isCore ? r() < 0.85 : r() < floorLit * 0.85;
      const px = x * cw, py = y * ch;
      // 窓わく（サッシ）。これがないと明かりが板に見えます。
      g.fillStyle = '#141821';
      g.fillRect(px + cw * 0.14, py + ch * 0.16, cw * 0.72, ch * 0.60);
      if (!on) continue;
      g.fillStyle = tints[(r() * tints.length) | 0];
      g.globalAlpha = isCore ? 0.55 : 0.35 + r() * 0.6;
      g.fillRect(px + cw * 0.20, py + ch * 0.22, cw * 0.60, ch * 0.48);
      g.globalAlpha = 1;
    }
  }
  // 各階の床スラブ（横の暗い帯）
  g.globalAlpha = 0.5;
  g.fillStyle = '#080a0e';
  for (let y = 0; y < rows; y++) g.fillRect(0, y * ch + ch * 0.80, cv.width, ch * 0.18);
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
  grd.addColorStop(0, 'rgba(255,246,232,0.8)');
  grd.addColorStop(0.30, 'rgba(255,238,214,0.26)');
  grd.addColorStop(1, 'rgba(255,232,196,0)');
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

  const poolG = new THREE.PlaneGeometry(17, 30);
  const poolM = new THREE.MeshBasicMaterial({
    map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.17,
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
  // 灯りのにじみ。Points は常にカメラを向くので、遠くの灯りが点々と連なって見えます
  // （インスタンス化した板だと向きが固定され、横から見ると消えてしまいます）
  const flarePos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    track.sample(i * step, sm);
    const side = i % 2 === 0 ? -1 : 1;
    pos.copy(sm.pos)
      .addScaledVector(sm.lat, side * (ROAD.halfRoad - 0.8))
      .addScaledVector(sm.up, 9.05);
    flarePos[i * 3] = pos.x; flarePos[i * 3 + 1] = pos.y; flarePos[i * 3 + 2] = pos.z;
  }
  const flareGeo = new THREE.BufferGeometry();
  flareGeo.setAttribute('position', new THREE.Float32BufferAttribute(flarePos, 3));
  const flares = new THREE.Points(flareGeo, new THREE.PointsMaterial({
    // size はワールド単位。大きくすると発光する球が浮いているように見えるので、
    // 実際の灯具に近い 3m 程度にとどめ、遠くでも見えることは fog:false とブルームに任せます。
    map: glowTexture(), color: 0xffe6bb, size: 3.0, sizeAttenuation: true,
    transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  }));
  flares.frustumCulled = false;
  flares.renderOrder = 3;
  group.add(flares);

  for (const im of [poles, arms, heads, pools]) { im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; }
  group.add(poles, arms, heads, pools);
  scene.add(group);
  return { group, pools, heads, flares };
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

/**
 * 市街地区間の地面。
 * これがないと、ビルの足元が真っ黒な海のままになり「宙に浮いた箱」に見えます。
 * コースに沿った幅広の帯として1枚だけ張るので、重なりによるちらつきも起きません。
 */
export function buildLand(track, scene) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x14171e, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.25,
  });
  const HALF = 460;
  // 地面の高さを -1.4m 固定にしていました。ところが路面の高さはコースにより
  // -33m〜+50m と大きく上下するため、路面が沈む区間では地面が路面を覆い、
  // 画面の半分が真っ黒になっていました（12コース中7コースで発生）。
  // 高架下の地面として、路面から一定の深さを保って追従させます。
  const BELOW = 11;
  const sm = {};
  for (const z of track.zones) {
    if (z.kind !== 'city') continue;
    const from = z.from - 120, to = z.to + 120;
    const rows = Math.max(2, Math.floor((to - from) / 60));
    const posA = new Float32Array((rows + 1) * 2 * 3);
    const idx = [];
    for (let r = 0; r <= rows; r++) {
      const s2 = lerp(from, to, r / rows);
      track.sample(s2, sm);
      const y = sm.pos.y - BELOW;
      for (let q = 0; q < 2; q++) {
        const u = q === 0 ? -HALF : HALF;
        const o = (r * 2 + q) * 3;
        posA[o] = sm.pos.x + sm.lat.x * u;
        posA[o + 1] = y;
        posA[o + 2] = sm.pos.z + sm.lat.z * u;
      }
    }
    for (let r = 0; r < rows; r++) {
      const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, d, c, a, b, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    group.add(new THREE.Mesh(g, mat));
  }
  scene.add(group);
  return group;
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

export function buildCity(track, scene, seed = 99, density = 0.9) {
  const r = rng(seed);
  const isClear = trackClearance(track);
  const group = new THREE.Group();
  const near = [];   // 沿道のビル
  const far = [];    // 遠景のスカイライン

  const sm = {};
  for (let s = 0; s < track.length; s += 26) {
    const kind = track.zoneAt(s);
    track.sample(s, sm);
    // 湾岸区間は海なので建てません。市街地の密度はコースごとに変わります。
    const dens = kind === 'city' ? density : 0;
    for (const side of [-1, 1]) {
      if (r() > dens) continue;
      const dist = ROAD.halfRoad + 42 + r() * 240;
      const h = 32 + Math.pow(r(), 1.7) * 122;
      const w = 11 + r() * 24;
      const d = 11 + r() * 24;
      const p = sm.pos.clone().addScaledVector(sm.lat, side * dist);
      // 土台も -3m 固定でした。路面が沈む区間ではビルの足元が路面より
      // 上に来てしまい、道が建物の下をくぐるような絵になっていました。
      p.y = sm.pos.y - 11;
      // コース本体（他の区間も含む）に被る位置には建てない
      if (!isClear(p.x, p.z, ROAD.halfRoad + 10 + Math.hypot(w, d) * 0.5)) continue;
      near.push({ p, w, h, d, rot: r() * TAU });
    }
  }
  // 遠景（水平線に並ぶ高層ビル）。コース全体の平均の高さに合わせます。
  let avgY = 0;
  for (let i = 0; i < track.n; i++) avgY += track.pos[i * 3 + 1];
  const groundY = avgY / track.n - 11;
  for (let i = 0; i < 620 && far.length < 420; i++) {
    const a = r() * TAU;
    const rad = 2600 + r() * 3400;
    const h = 70 + Math.pow(r(), 2.2) * 250;
    const w = 26 + r() * 46, d = 26 + r() * 46;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    // 遠景のビルもコースの真上に来ることがあるので同じ判定を通す
    if (!isClear(x, z, ROAD.halfRoad + 14 + Math.hypot(w, d) * 0.5)) continue;
    far.push({ p: new THREE.Vector3(x, groundY, z), w, h, d, rot: r() * TAU });
  }

  // 窓1枚を約4.2m×3.4mに保ちます。
  //
  // 以前は「高さ帯ごとの平均サイズ」から繰り返し数を出し、しかも整数に
  // 丸めていました。横方向は round(幅/4.2/6) がほぼ常に 1 になるため、
  // 幅11mのビルも35mのビルも同じ6列で窓を描き、窓の大きさが3倍以上ばらつく
  // という結果になっていました（実際に画面で確認）。
  //
  // ここではビルを「幅と高さの近いものどうし」に仕分けし、組ごとに
  // 実寸から繰り返し数を出します。丸めないので、窓の大きさが揃います。
  const PITCH_W = 4.2, PITCH_H = 3.4;
  const buildGroups = (list, wStep, hStep, seedBase, emis, out) => {
    const buckets = new Map();
    for (const b of list) {
      const k = `${Math.round(b.w / wStep)}_${Math.round(b.h / hStep)}`;
      let a = buckets.get(k);
      if (!a) buckets.set(k, (a = []));
      a.push(b);
    }
    let n = 0;
    for (const [, a] of buckets) {
      const w = a.reduce((x, b) => x + b.w, 0) / a.length;
      const h = a.reduce((x, b) => x + b.h, 0) / a.length;
      // 丸めずに実寸から出します。端で窓が途切れるのは実際のビルでも起きます。
      const ru = Math.max(0.6, w / PITCH_W / WIN_COLS);
      const rv = Math.max(0.6, h / PITCH_H / WIN_ROWS);
      out.push(mk(a, seedBase + n * 13, ru, rv, emis));
      n++;
    }
  };
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

  const nearMeshes = [], farMeshes = [];
  buildGroups(near, 8, 30, 31, 0.85, nearMeshes);
  buildGroups(far, 16, 70, 57, 1.05, farMeshes);
  for (const m of nearMeshes) group.add(m);
  for (const m of farMeshes) { m.frustumCulled = false; group.add(m); }

  // ---- 屋上まわり
  // すべてのビルが「窓のついた直方体」で頭が真っ平らだったため、
  // 街並みが積み木に見えていました。実際のビルの頭には必ず
  // パラペット（立ち上がり）があり、その上に塔屋・貯水槽・アンテナが載ります。
  // 輪郭にこの凹凸が出るだけで、遠景の見え方が大きく変わります。
  {
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x191d25, roughness: 0.92, metalness: 0.05, envMapIntensity: 0.3,
    });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const rr = rng(seed + 771);
    const parapets = new THREE.InstancedMesh(box, roofMat, near.length);
    const huts = new THREE.InstancedMesh(box, roofMat, near.length);
    const masts = new THREE.InstancedMesh(box, roofMat, near.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    let np = 0, nh = 0, nm = 0;
    for (const b of near) {
      q.setFromAxisAngle(axis, b.rot);
      // パラペット：本体よりわずかに広く、屋上の縁に立ち上がる
      p.set(b.p.x, b.p.y + b.h - 0.4, b.p.z);
      sc.set(b.w * 1.04, 1.5, b.d * 1.04);
      m.compose(p, q, sc); parapets.setMatrixAt(np++, m);
      // 塔屋（エレベーター機械室・貯水槽）。屋上の中心から少しずらして置きます
      if (rr() < 0.8) {
        const ox = (rr() - 0.5) * b.w * 0.35, oz = (rr() - 0.5) * b.d * 0.35;
        const ca = Math.cos(b.rot), sa = Math.sin(b.rot);
        p.set(b.p.x + ox * ca - oz * sa, b.p.y + b.h + 0.6, b.p.z + ox * sa + oz * ca);
        sc.set(b.w * (0.22 + rr() * 0.16), 2.5 + rr() * 3.5, b.d * (0.22 + rr() * 0.16));
        m.compose(p, q, sc); huts.setMatrixAt(nh++, m);
      }
      // アンテナ／避雷針
      if (rr() < 0.45) {
        p.set(b.p.x, b.p.y + b.h + 1.0, b.p.z);
        sc.set(0.35, 5 + rr() * 9, 0.35);
        m.compose(p, q, sc); masts.setMatrixAt(nm++, m);
      }
    }
    parapets.count = np; huts.count = nh; masts.count = nm;
    for (const im of [parapets, huts, masts]) { im.instanceMatrix.needsUpdate = true; group.add(im); }
  }

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
    // 以前は 0xb9bfc7（ほぼ白）。夜のトンネルで至近距離から照らすと
    // 画面全体が白飛びし、路面もライトも見えなくなっていました。
    // 実際の覆工コンクリートは汚れた灰色です。
    color: 0x6b7178, roughness: 0.93, metalness: 0.03, side: THREE.FrontSide,
    emissive: 0x232830, emissiveIntensity: 0.9,
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
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4a4e56, roughness: 0.8, metalness: 0.2, envMapIntensity: 0.4,
  });
  // ケーブルは細く・暗く。明るい線を長く張ると空を引っ掻いたように見えます。
  const cableMat = new THREE.LineBasicMaterial({ color: 0x7d8694, transparent: true, opacity: 0.22 });
  const sm = {}, basis = new THREE.Matrix4(), q = new THREE.Quaternion();
  const back = new THREE.Vector3();
  for (const z of track.zones) {
    if (z.kind !== 'bridge') continue;
    // 主塔は2基まで。3基だとケーブルが重なって収拾がつかなくなります。
    const span = z.to - z.from;
    const towers = span > 700
      ? [z.from + span * 0.30, z.from + span * 0.70]
      : [z.from + span * 0.5];
    for (const s of towers) {
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
      // 主塔から路面へ扇状に。届く距離を抑えて、隣の塔のケーブルと交差させません。
      const pts = [];
      for (const side of [-1, 1]) {
        for (let i = 1; i <= 5; i++) {
          const dz = i * 22;
          const top = new THREE.Vector3(side * (ROAD.halfRoad + 3.2), H - 18 - i * 1.4, 0);
          pts.push(top.clone(), new THREE.Vector3(side * (ROAD.halfRoad + 1.0), 1.4, dz));
          pts.push(top.clone(), new THREE.Vector3(side * (ROAD.halfRoad + 1.0), 1.4, -dz));
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
