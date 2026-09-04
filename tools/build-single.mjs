// 全モジュールを1枚のHTMLに束ねるビルドスクリプト。
// Artifact など「1ファイルしか置けない場所」で配布するために使います。
//   node tools/build-single.mjs <出力先> <three のベースURL>
// 例: node tools/build-single.mjs dist/wangan.html https://cdn.jsdelivr.net/npm/three@0.160.0
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'dist/wangan-single.html';
const threeBase = process.argv[3] || 'https://cdn.jsdelivr.net/npm/three@0.160.0';

const ORDER = [
  'util', 'cars', 'carModel', 'track', 'scenery', 'vehicle',
  'ai', 'traffic', 'audio', 'input', 'hud', 'story', 'save', 'game', 'main',
];

// ローカルの vendor/addons は平坦だが、npm 配布は postprocessing/ 配下にある
const ADDON_DIR = {
  'EffectComposer.js': 'postprocessing/',
  'RenderPass.js': 'postprocessing/',
  'UnrealBloomPass.js': 'postprocessing/',
  'OutputPass.js': 'postprocessing/',
  'ShaderPass.js': 'postprocessing/',
  'MaskPass.js': 'postprocessing/',
  'Pass.js': 'postprocessing/',
};

const externalImports = new Set();
const bodies = [];

for (const name of ORDER) {
  const src = fs.readFileSync(path.join('src', `${name}.js`), 'utf8');
  const kept = [];
  for (const line of src.split('\n')) {
    const im = line.match(/^import\s+.*?from\s+'([^']+)';\s*$/);
    if (im) {
      const spec = im[1];
      if (spec.startsWith('.')) continue;              // ローカル依存は連結で解決
      let fixed = line;
      if (spec.startsWith('three/addons/')) {
        const file = spec.slice('three/addons/'.length);
        fixed = line.replace(spec, `three/addons/${ADDON_DIR[file] ?? ''}${file}`);
      }
      externalImports.add(fixed.trim());
      continue;
    }
    if (/^import\s+/.test(line)) continue;
    kept.push(
      line
        .replace(/^export\s+(const|let|var|function|class|async)\b/, '$1')
        .replace(/^export\s*\{[^}]*\};?\s*$/, '')
    );
  }
  bodies.push(`\n// ============================== src/${name}.js ==============================\n` + kept.join('\n'));
}

const css = fs.readFileSync(path.join('styles', 'main.css'), 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('index.html に <body> が見つかりません');
const markup = bodyMatch[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')   // importmap と main.js の読み込みを除去
  .trim();

// 単体でも文字化けしないよう先頭に charset を置いておきます
const page = `<meta charset="utf-8">
<title>湾岸MIDNIGHT</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;600;700;800&display=swap">
<style>
${css}
</style>

${markup}

<script type="importmap">
{
  "imports": {
    "three": "${threeBase}/build/three.module.min.js",
    "three/addons/": "${threeBase}/examples/jsm/"
  }
}
</script>
<script type="module">
${[...externalImports].join('\n')}
${bodies.join('\n')}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`${out}  (${(page.length / 1024).toFixed(0)} KB)  three: ${threeBase}`);
