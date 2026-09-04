import * as THREE from 'three';
import { clamp, wrapAngle } from './util.js';
import { buildCar } from './carModel.js';
import { Vehicle } from './vehicle.js';

// 走行中の見た目まわり（車体・粒子）と、シーングラフの後始末をまとめたモジュール。
// game.js が肥大していたので、描画オブジェクトの生成と破棄だけを切り出しています。

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);


/** 走行中の1台ぶん（物理＋見た目＋エフェクト）をまとめた入れ物 */
export class Actor {
  constructor(spec, tune, scene, opts = {}) {
    this.vehicle = new Vehicle(spec, tune, opts);
    const built = buildCar(spec, { color: opts.color });
    this.mesh = built.root;
    this.built = built;
    this.mesh.rotation.order = 'YXZ';
    scene.add(this.mesh);

    // 接地感を出す偽の影。単色の板だと路面に長方形が浮くので、
    // 中心が濃く縁が消えるテクスチャを使って輪郭をなくします。
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.dims.W * 1.9, spec.dims.L * 1.35),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false,
        map: softDot(0.42), fog: true,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    scene.add(shadow);
    this.shadow = shadow;

    this.tmp = {};
    this.q = new THREE.Quaternion();
    this.qa = new THREE.Quaternion();
    this.basis = new THREE.Matrix4();
    this.left = new THREE.Vector3();
  }

  syncMesh(track) {
    const v = this.vehicle;
    const sm = track.sample(v.s, this.tmp);
    // 回転行列は右手系（X×Y=Z）である必要があります。
    // 進行方向を +Z、上を +Y に取ると、残る +X は「進行方向の左」になります。
    this.basis.makeBasis(this.left.copy(sm.lat).negate(), sm.up, sm.tan);
    this.q.setFromRotationMatrix(this.basis);
    this.q.multiply(this.qa.setFromAxisAngle(Y, wrapAngle(v.heading - sm.heading)));
    this.q.multiply(this.qa.setFromAxisAngle(X, v.pitch));
    this.q.multiply(this.qa.setFromAxisAngle(Z, v.roll));
    this.mesh.quaternion.copy(this.q);
    this.mesh.position.copy(v.pos);

    // ホイールの回転・ステア・サスペンションのストローク
    // 加速で前が浮き、ブレーキで沈む。旋回では外輪が縮む。
    const dive = clamp(v.lastAx / 26, -0.055, 0.055);
    const roll = clamp(v.lastAy / 26, -0.05, 0.05);
    for (const w of this.built.wheels) {
      w.spin.rotation.x -= (v.vx / v.spec.wheelR) * (1 / 60);
      if (w.front) {
        w.pivot.rotation.y = v.steer;
        w.pivot.rotation.z = -v.steer * 0.10 * w.side;   // 舵角に応じたキャンバー
      }
      const travel = (w.front ? dive : -dive * 0.7) + roll * w.side * 0.9;
      w.pivot.position.y = v.spec.wheelR + clamp(travel, -0.075, 0.075);
    }
    // ブレーキランプ（にじみの板もあわせて強くします）
    const on = v.input.brake > 0.05;
    for (const b of this.built.brakeLights) {
      b.material.emissiveIntensity = on ? 5.0 : 1.5;
    }
    if (this.built.tailGlows) {
      for (const g of this.built.tailGlows) {
        g.material.opacity = on ? 0.72 : 0.34;
        g.scale.setScalar(on ? 1.5 : 1);
      }
    }
    if (this.built.reflections) {
      for (const g of this.built.reflections) {
        g.material.opacity = on ? 0.20 : 0.075;
        g.scale.y = on ? 1.5 : 1;
      }
    }
    this.shadow.position.set(v.pos.x, v.pos.y + 0.04, v.pos.z);
    this.shadow.quaternion.copy(this.q);
    this.shadow.rotateX(-Math.PI / 2);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    scene.remove(this.shadow);
    // 取り外すだけだと GPU 側の資源が残り、車を替えるたびに積み上がります
    disposeTree(this.mesh);
    disposeTree(this.shadow);
  }
}

/** 使い終わったシーングラフのジオメトリ／マテリアルを解放します。 */
export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'emissiveMap', 'alphaMap', 'normalMap']) {
        // 使い回しているテクスチャ（ランプのにじみ等）は他のオブジェクトも使うので残します
        if (m[k] && m[k].dispose && !m[k].userData?.shared) m[k].dispose();
      }
      m.dispose();
    }
  });
}

/** 粒子用の丸いスプライト（四角い点にならないように）。同じ設定は使い回します。 */
const _softDots = new Map();
export function softDot(hard = 0.25) {
  const hit = _softDots.get(hard);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(hard, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.userData.shared = true;   // 使い回すので破棄しない
  _softDots.set(hard, t);
  return t;
}

/** 火花・タイヤスモークなどの粒子 */
export class Particles {
  constructor(scene, count, color, size, additive = true) {
    const pos = new Float32Array(count * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color, size, transparent: true, opacity: 0.9, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true, map: softDot(additive ? 0.15 : 0.05), fog: !additive,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.count = count;
    this.life = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.arr = g.attributes.position.array;
    this.cursor = 0;
    this.geo = g;
    for (let i = 0; i < count; i++) this.arr[i * 3 + 1] = -9999;
  }
  emit(p, v, life, spread) {
    const i = this.cursor++ % this.count;
    this.arr[i * 3] = p.x; this.arr[i * 3 + 1] = p.y; this.arr[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 1] = v.y + Math.random() * spread * 0.6;
    this.vel[i * 3 + 2] = v.z + (Math.random() - 0.5) * spread;
    this.life[i] = life;
  }
  update(dt) {
    let alive = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      alive = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.arr[i * 3 + 1] = -9999; continue; }
      this.arr[i * 3] += this.vel[i * 3] * dt;
      this.arr[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.arr[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 9.0 * dt;
      this.vel[i * 3] *= 0.98;
      this.vel[i * 3 + 2] *= 0.98;
    }
    if (alive) this.geo.attributes.position.needsUpdate = true;
  }
}

