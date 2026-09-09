/**
 * ブラウザ側が使う Pusher の設定を返します。
 *
 * key と cluster は公開してよい値です（secret だけが秘密）。それでも
 * ソースに直接書かず、ここで環境変数から渡します。理由は2つあります。
 *
 *   - 鍵をリポジトリに1文字も置かなくて済む。公開リポジトリなので、
 *     「うっかり secret のほうを書いてしまう」経路を最初から塞げます
 *   - 設定していないときに、画面へ理由を出せる。未設定と通信障害を
 *     取り違えると、原因を探すのに時間がかかります
 */

const KEY = process.env.PUSHER_KEY;
const CLUSTER = process.env.PUSHER_CLUSTER || 'ap3';
const READY = !!(KEY && process.env.PUSHER_SECRET);

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    enabled: READY,
    key: READY ? KEY : null,
    cluster: CLUSTER,
    reason: READY ? null
      : 'サーバに Pusher の鍵が設定されていません（Vercel の環境変数 PUSHER_KEY / PUSHER_SECRET / PUSHER_CLUSTER）',
  });
}
