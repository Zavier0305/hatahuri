// 汎用の数学ヘルパー群。ゲーム全体で使い回します。

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const sign = Math.sign;
export const TAU = Math.PI * 2;

/** 角度を -PI..PI に正規化 */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** フレームレートに依存しない指数移動平均（追従） */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** 決定論的な擬似乱数（mulberry32）。同じ seed なら毎回同じ街並みになります。 */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const KMH = 3.6;              // m/s -> km/h
export const PS_TO_W = 735.49875;    // 1PS = 735.5W
export const RPM_TO_RADS = Math.PI / 30;
export const RADS_TO_RPM = 30 / Math.PI;

/** ミリ秒を 1'23"456 形式へ */
export function formatTime(ms) {
  if (!isFinite(ms) || ms < 0) return "--'--\"---";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${m}'${String(s).padStart(2, '0')}"${String(t).padStart(3, '0')}`;
}

/** 12345678 -> 12,345,678 */
export function formatMoney(v) {
  return Math.floor(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
