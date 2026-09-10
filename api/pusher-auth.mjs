import { createHmac } from 'node:crypto';

/**
 * Pusher の presence チャンネル認証。
 *
 * presence-* と private-* のチャンネルは、購読のたびにサーバの署名が要ります。
 * 署名には secret が必要で、これはブラウザに置けません（このリポジトリは
 * 公開なので、コードに書けばそのまま世界中から読めます）。
 * secret は Vercel の環境変数にだけ置き、この関数の中でしか触りません。
 *
 * 公式の pusher パッケージは使っていません。やることは HMAC-SHA256 を
 * 1回計算するだけで、そのために依存関係とビルド手順を増やすと、
 * 「ビルド不要の素の ES Modules」という構成が崩れるためです。
 */

// 前後の空白を落とします。貼り付けたときに紛れ込んだ改行やタブが
// そのまま署名に入ると、鍵は正しいのに認証だけが通りません。
const env = (name) => (process.env[name] || '').trim();

const KEY = env('PUSHER_KEY');
const SECRET = env('PUSHER_SECRET');

/**
 * 表示名は相手の画面に出ます。制御文字と山かっこを落としてから丸めます。
 * 描画は textContent なので HTML としては解釈されませんが、名前で画面の
 * 見た目を壊せる余地は元から作らないでおきます。
 */
function cleanName(v) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim();
  return s.slice(0, 16) || '名無し';
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST のみ受け付けます' });
  }
  if (!KEY || !SECRET) {
    // 鍵が未設定のときは、画面にそのまま出せる文言を返します
    return res.status(503).json({ error: 'サーバに Pusher の鍵が設定されていません' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const socketId = String(body.socket_id || '');
  const channel = String(body.channel_name || '');

  // socket_id の形式は "123.456"。ここを検証しないと、署名文字列に区切りの
  // ":" を混ぜて、別のチャンネルにも通る署名を作らせる余地が残ります。
  if (!/^\d+\.\d+$/.test(socketId)) {
    return res.status(400).json({ error: 'socket_id が不正です' });
  }
  // 部屋名は「合言葉のハッシュ16桁」だけを許可します
  if (!/^presence-wangan-[0-9a-f]{16}$/.test(channel)) {
    return res.status(400).json({ error: 'チャンネル名が不正です' });
  }

  // user_id は接続ごとに一意であればよく、推測されて困る値ではありません
  const userId = socketId.replace('.', '-');
  const channelData = JSON.stringify({
    user_id: userId,
    user_info: {
      name: cleanName(body.name),
      carId: String(body.carId || '').slice(0, 24),
      color: Number(body.color) || 0,
      courseId: String(body.courseId || '').slice(0, 24),
    },
  });

  const signature = createHmac('sha256', SECRET)
    .update(`${socketId}:${channel}:${channelData}`)
    .digest('hex');

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ auth: `${KEY}:${signature}`, channel_data: channelData });
}
