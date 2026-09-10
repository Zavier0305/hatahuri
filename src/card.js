import { formatTime, formatMoney } from './util.js';

/**
 * 走行結果の共有カード。
 *
 * 走った内容を1枚の絵にして、保存できるようにします。数字を並べた表を
 * そのまま撮るより、画像1枚のほうが概要欄にも SNS にも置きやすいためです。
 *
 * 配色と書体はゲーム本体から取っています。別物の見た目にすると、
 * 「このゲームの記録だ」と分からなくなります。
 */

const W = 1200, H = 630;   // SNS のカードでよく使われる比率

const NIGHT = '#070c17';
const DEEP = '#0d1523';
const INK = '#eaf0f8';
const DIM = '#8fa0b8';
const FAINT = '#5c6b82';
const DAWN = '#ff9a52';
const COLD = '#6fd5ff';
const LINE = 'rgba(146,176,214,.22)';

const DISPLAY = '"Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",sans-serif';
const DATA = '"Roboto Condensed","DIN Alternate",sans-serif';

/**
 * カードを描いて canvas を返します。
 * @param d.course    コース名
 * @param d.place     地名
 * @param d.carName   車名
 * @param d.chassis   型式
 * @param d.color     車体色（0xRRGGBB）
 * @param d.headline  大きく出す文字（WIN / BEST LAP など）
 * @param d.rows      [ラベル, 値] の並び
 * @param d.note      下に添える一言
 */
export function drawResultCard(d) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // --- 地。上が夜、下に夜明けの気配
  g.fillStyle = NIGHT;
  g.fillRect(0, 0, W, H);
  const sky = g.createLinearGradient(0, H * 0.35, 0, H);
  sky.addColorStop(0, 'rgba(255,154,82,0)');
  sky.addColorStop(1, 'rgba(255,154,82,.09)');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // 水平線の光
  const glow = g.createRadialGradient(W * 0.5, H * 1.02, 10, W * 0.5, H * 1.02, W * 0.55);
  glow.addColorStop(0, 'rgba(255,192,138,.17)');
  glow.addColorStop(1, 'rgba(255,192,138,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // 数字を置く帯だけ、わずかに沈めます。夜明けの光がそのまま乗ると
  // 背景が濁って読みにくくなります
  const band = g.createLinearGradient(0, H * 0.44, 0, H);
  band.addColorStop(0, 'rgba(7,12,23,0)');
  band.addColorStop(0.35, 'rgba(7,12,23,.45)');
  band.addColorStop(1, 'rgba(7,12,23,.55)');
  g.fillStyle = band;
  g.fillRect(0, 0, W, H);

  const pad = 64;

  // --- 上：作品名と、その走行の車
  g.fillStyle = FAINT;
  g.font = `700 17px ${DATA}`;
  g.letterSpacing = '6px';
  g.fillText('TOKYO BAY EARLY MORNING', pad, pad + 6);
  g.letterSpacing = '0px';

  // 車体色の帯。どの車で走ったかが一目で分かります
  const col = '#' + ((d.color ?? 0x8899aa) >>> 0).toString(16).padStart(6, '0');
  g.fillStyle = col;
  g.fillRect(pad, pad + 22, 54, 6);

  // --- 見出し
  g.fillStyle = INK;
  g.font = `900 78px ${DISPLAY}`;
  g.fillText(d.headline || '走行記録', pad, pad + 118);

  g.fillStyle = DAWN;
  g.font = `700 30px ${DISPLAY}`;
  g.fillText(d.course || '', pad, pad + 168);
  if (d.place) {
    g.fillStyle = DIM;
    g.font = `500 20px ${DISPLAY}`;
    g.fillText(d.place, pad, pad + 200);
  }

  // --- 区切り
  g.strokeStyle = LINE;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pad, pad + 232);
  g.lineTo(W - pad, pad + 232);
  g.stroke();

  // --- 数字。2列に並べます
  const rows = (d.rows || []).slice(0, 6);
  const colW = (W - pad * 2) / 3;
  rows.forEach(([label, value], i) => {
    const cx = pad + (i % 3) * colW;
    const cy = pad + 296 + Math.floor(i / 3) * 108;
    g.fillStyle = FAINT;
    g.font = `600 15px ${DATA}`;
    g.letterSpacing = '3px';
    g.fillText(String(label).toUpperCase(), cx, cy);
    g.letterSpacing = '0px';
    g.fillStyle = INK;
    g.font = `700 44px ${DATA}`;
    g.fillText(String(value), cx, cy + 50);
  });

  // --- 右上：車
  g.textAlign = 'right';
  g.fillStyle = INK;
  g.font = `700 30px ${DISPLAY}`;
  g.fillText(d.carName || '', W - pad, pad + 118);
  g.fillStyle = COLD;
  g.font = `700 20px ${DATA}`;
  g.letterSpacing = '3px';
  g.fillText(d.chassis || '', W - pad, pad + 150);
  g.letterSpacing = '0px';
  g.textAlign = 'left';

  // --- 下：一言
  if (d.note) {
    g.fillStyle = DIM;
    g.font = `500 19px ${DISPLAY}`;
    g.fillText(d.note, pad, H - pad + 8);
  }

  return cv;
}

/** 走行の状態からカードの中身を組み立てます */
export function cardData(opts) {
  const { state, course, car, color, headline, money } = opts;
  const rows = [
    ['最高速', `${Math.round(state.topSpeed)} km/h`],
    ['走行距離', `${(state.distance / 1000).toFixed(2)} km`],
    ['ベストラップ', state.bestLap < Infinity ? formatTime(state.bestLap) : '—'],
  ];
  if (opts.reward) rows.push(['獲得', `¥${formatMoney(opts.reward)}`]);
  rows.push(['所持金', `¥${formatMoney(money || 0)}`]);
  rows.push(['経過', `${state.elapsed.toFixed(1)} 秒`]);
  return {
    course: course.name, place: course.place,
    carName: car.name, chassis: car.chassis, color,
    headline, rows,
    note: opts.note || '午前2時。夜が明けるまでに、あと9台。',
  };
}
