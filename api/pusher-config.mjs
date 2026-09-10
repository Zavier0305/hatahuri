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

/*
 * 環境変数は前後の空白を落としてから使います。
 *
 * 管理画面へ貼り付けるとき、コピー元のタブや改行が一緒に入ることがあります。
 * 実際、最初の設定では key の先頭にタブ、cluster の末尾に改行が入っていました。
 * 見た目では気づけず、症状は「アプリキーが違います」と出るだけなので、
 * 原因にたどり着くのに時間がかかります。ここで吸収します。
 */
const env = (name) => (process.env[name] || '').trim();

const KEY = env('PUSHER_KEY');
const CLUSTER = env('PUSHER_CLUSTER') || 'ap3';
const READY = !!(KEY && env('PUSHER_SECRET'));

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
