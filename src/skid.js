import * as THREE from 'three';
import { clamp } from './util.js';

/**
 * タイヤ痕。
 *
 * 滑らせたところに黒い跡を残します。走った結果が路面に残ると、同じ道でも
 * 「さっき自分がどう走ったか」が見えるようになります。
 *
 * 1本ずつメッシュを作ると、数百本になったところで描画命令が破綻します。
 * あらかじめ最大本数ぶんの頂点を持った1つの帯を用意して、書き込む場所を
 * 使い回します（古いものから上書きされて消えていきます）。
 */
const MAX = 420;          // 残せる区間の数（左右で1組）
const FADE = 26;          // 消えるまでの時間[s]

export class Skid {
  constructor(scene) {
    this.n = 0;                 // 次に書き込む位置
    this.used = 0;
    this.age = new Float32Array(MAX);
    this.base = new Float32Array(MAX);   // 付いたときの濃さ（薄れる計算の元）
    this.pos = new Float32Array(MAX * 4 * 3);   // 1区間＝4頂点（左右2本ぶんを1枚で）
    this.alpha = new Float32Array(MAX * 4);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const idx = new Uint16Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const a = i * 4;
      idx.set([a, a + 1, a + 2, a, a + 2, a + 3], i * 6);
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // 帯の表裏は、車がどちら回りに滑ったかで変わります。片面だけだと
      // 半分の跡が消えて見えます（実際、真上から見て一本も見えませんでした）。
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      vertexShader: `
        attribute float aAlpha;
        varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        varying float vA;
        void main(){
          if (vA <= 0.001) discard;
          gl_FragColor = vec4(0.015, 0.015, 0.02, vA);
        }
      `,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this._prev = null;
    this._tmp = new THREE.Vector3();
  }

  clear() {
    this.n = 0; this.used = 0;
    this.age.fill(0);
    this.base.fill(0);
    this.alpha.fill(0);
    this.mesh.geometry.setDrawRange(0, 0);
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
    this._prev = null;
  }

  /**
   * @param v      自車
   * @param slip   0..1。1で完全に滑っている
   * @param left   車体の左向きの単位ベクトル
   */
  add(v, slip, left) {
    if (slip < 0.12) { this._prev = null; return; }
    const W = v.spec.dims.W * 0.48;
    const p = v.pos;
    const cur = {
      lx: p.x + left.x * W, ly: p.y + left.y * W + 0.02, lz: p.z + left.z * W,
      rx: p.x - left.x * W, ry: p.y - left.y * W + 0.02, rz: p.z - left.z * W,
    };
    const prev = this._prev;
    this._prev = cur;
    if (!prev) return;
    // 前回と今回の4点で1枚の帯を作ります
    const i = this.n;
    const o = i * 12;
    const P = this.pos;
    P[o] = prev.lx; P[o + 1] = prev.ly; P[o + 2] = prev.lz;
    P[o + 3] = prev.rx; P[o + 4] = prev.ry; P[o + 5] = prev.rz;
    P[o + 6] = cur.rx; P[o + 7] = cur.ry; P[o + 8] = cur.rz;
    P[o + 9] = cur.lx; P[o + 10] = cur.ly; P[o + 11] = cur.lz;
    const a = clamp(slip, 0, 1);
    this.base[i] = a;
    for (let k = 0; k < 4; k++) this.alpha[i * 4 + k] = a;
    this.age[i] = FADE;
    this.n = (this.n + 1) % MAX;
    this.used = Math.min(MAX, this.used + 1);
    this.mesh.geometry.setDrawRange(0, this.used * 6);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }

  update(dt) {
    if (!this.used) return;
    let touched = false;
    for (let i = 0; i < this.used; i++) {
      if (this.age[i] <= 0) continue;
      this.age[i] -= dt;
      // 濃さは「付いたときの濃さ × 残り時間」。前フレームの値に掛けていくと
      // 指数的に消えてしまい、あっという間に見えなくなります。
      const a = this.base[i] * clamp(this.age[i] / FADE, 0, 1);
      for (let q = 0; q < 4; q++) this.alpha[i * 4 + q] = a;
      touched = true;
    }
    if (touched) this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
}
