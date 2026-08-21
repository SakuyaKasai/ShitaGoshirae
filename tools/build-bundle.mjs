/**
 * build-bundle.mjs — 配布用の単一 HTML を作る。
 *
 *   node tools/build-bundle.mjs
 *   → index.html （これ1つをサーバに置けば動く）
 *
 * なぜ1ファイルにするのか:
 *   利用者は2人。ビルド環境も CI も無い。
 *   「このファイルをサーバに置く」で終わるのが、この規模では最も壊れにくい。
 *   テンプレ .docx も base64 で同梱するので、外部への通信は一切発生しない。
 *   原稿がブラウザの外に出ないことが、未公開論文を扱ううえでの前提である。
 */

import fs from 'fs';
import path from 'path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const r = p => path.join(root, p);

/* ---------- 1. JS をひとまとめに ---------- */
const built = await esbuild.build({
  entryPoints: [r('src/app.js')],
  bundle: true, format: 'esm', target: 'es2022',
  minify: true, write: false,
  loader: { '.json': 'json' },
});
const js = built.outputFiles[0].text;

/* ---------- 2. テンプレを base64 で同梱 ---------- */
const templateB64 = fs.readFileSync(r('template.docx')).toString('base64');
const manifest = fs.readFileSync(r('src/manifest.json'), 'utf8');
const css = fs.readFileSync(r('src/app.css'), 'utf8');

/* ---------- 3. HTML を組む ---------- */
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>原稿したごしらえ — 人間工学誌 技術報告</title>
<meta name="description" content="Word原稿を日本人間工学会『人間工学』誌 技術報告テンプレートの体裁へ整えます。原稿はブラウザの外に出ません。">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@400;600&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>

<script type="application/json" id="manifest">${manifest.replace(/</g, '\\u003c')}</script>
<script type="text/plain" id="template">${templateB64}</script>

<script type="module">
${js}
boot({
  manifest: JSON.parse(document.getElementById('manifest').textContent),
  templateBase64: document.getElementById('template').textContent.trim(),
});
</script>
</body>
</html>
`;

fs.writeFileSync(r('index.html'), html);

const kb = n => `${(n / 1024).toFixed(0)} KB`;
console.log('✅ index.html を生成しました');
console.log(`   JavaScript : ${kb(js.length)}`);
console.log(`   テンプレ    : ${kb(templateB64.length)} (base64)`);
console.log(`   合計        : ${kb(html.length)}`);
