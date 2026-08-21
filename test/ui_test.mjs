/**
 * ui_test.mjs — 実ブラウザで画面を通しで動かす。
 *
 * ここまでの単体テストは Node 上で動いており、
 * ブラウザ固有の落とし穴（File API / atob / Blob / localStorage 不可）を踏まない。
 * 配布物は HTML 1枚なので、その1枚をそのまま開いて確かめる。
 */
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

const CHROME = process.env.CHROME_BIN
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// 外部フォントの取得失敗はアプリの不具合ではない（この検証環境は外部通信を遮断している）。
// 本番では読み込めるし、読み込めなくても代替フォントで動く。
const isNetworkNoise = t => /Failed to load resource|net::ERR|fonts\.(googleapis|gstatic)/.test(t);
const errors = [];
page.on('pageerror', e => { if (!isNetworkNoise(String(e))) errors.push(String(e)); });
page.on('console', m => { if (m.type() === 'error' && !isNetworkNoise(m.text())) errors.push(m.text()); });

await page.goto('file://' + path.join(root, 'index.html'));
await page.waitForSelector('.drop');

console.log('\n【1】起動');
ok(errors.length === 0, `起動時のエラーなし${errors.length ? ': ' + errors[0] : ''}`);
ok(await page.locator('.brand h1').innerText() === '原稿したごしらえ', '見出しが出ている');
ok(await page.locator('.step').count() === 3, '工程が3つ出ている');
await page.screenshot({ path: path.join(root, 'shot-1-drop.png'), fullPage: true });

console.log('\n【2】原稿を読ませる');
await page.setInputFiles('#file', path.join(root, 'fixture-full.docx'));
await page.waitForSelector('.form', { timeout: 15000 });
ok(errors.length === 0, `読み込みでエラーなし${errors.length ? ': ' + errors[0] : ''}`);

const titleVal = await page.inputValue('#f-japaneseTitle');
ok(titleVal === '女性腰紐着付け構造の数値解析条件への変換手法', `和文表題を自動入力: ${titleVal}`);
const enAuthors = await page.inputValue('#f-englishAuthors');
ok(enAuthors === 'Yuri AOKI，Miho KASAI', `英文著者名を自動入力: ${enAuthors}`);
const kw = await page.inputValue('#f-keywords');
ok(kw.split('，').length === 5, `キーワード5個を自動入力: ${kw}`);
ok((await page.locator('.badge-high').count()) >= 3, '確度の高い項目にバッジが付いている');
const counters = await page.locator('.counter').allInnerTexts();
ok(counters.some(t => /字 \/ 目安/.test(t)), `和文抄録の文字数カウンタ: ${counters.find(t => t.includes('字 /')) ?? 'なし'}`);
ok(counters.some(t => /words \/ 規定/.test(t)), `英文抄録の語数カウンタ: ${counters.find(t => t.includes('words')) ?? 'なし'}`);
await page.screenshot({ path: path.join(root, 'shot-2-form.png'), fullPage: true });

console.log('\n【3】ゲラ');
await page.click('.actions .btn-primary');
await page.waitForSelector('.galley-body');
const lineCount = await page.locator('.gl').count();
ok(lineCount > 0, `ゲラに ${lineCount}行 表示された`);
ok(await page.locator('.gl-warn').count() > 0, '指摘のある行に朱の傍線が付いている');
ok(await page.locator('.gl-lv').count() > 0, '見出し行にレベル表示が付いている');
const cards = await page.locator('.wcard').count();
ok(cards > 0, `指摘カードが ${cards}件 出ている`);
ok(await page.locator('.switch input:checked').count() > 0, '自動修正が既定でONの項目がある');
await page.screenshot({ path: path.join(root, 'shot-3-galley.png'), fullPage: true });

console.log('\n【4】出力');
await page.click('#go');
await page.waitForSelector('.btn-download', { timeout: 30000 });
ok(errors.length === 0, `変換でエラーなし${errors.length ? ': ' + errors[0] : ''}`);
const dlName = await page.locator('.btn-download').getAttribute('download');
ok(/_人間工学誌\.docx$/.test(dlName), `保存名: ${dlName}`);

// 生成されたバイト列を取り出して、Node 側と同じものか確かめる
const bytes = await page.evaluate(async () => {
  const href = document.querySelector('.btn-download').href;
  const buf = await (await fetch(href)).arrayBuffer();
  return Array.from(new Uint8Array(buf));
});
fs.writeFileSync(path.join(root, 'out-browser.docx'), Buffer.from(bytes));
ok(bytes.length > 30000, `docx を ${(bytes.length / 1024).toFixed(0)} KB 生成`);
ok(bytes[0] === 0x50 && bytes[1] === 0x4B, 'ZIP として正しい先頭バイト（PK）');
await page.screenshot({ path: path.join(root, 'shot-4-done.png'), fullPage: true });

console.log('\n【5】狭い画面');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(200);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(overflow <= 1, `横スクロールが出ない（はみ出し ${overflow}px）`);
await page.screenshot({ path: path.join(root, 'shot-5-mobile.png'), fullPage: true });

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (errors.length) console.log('ブラウザのエラー:', errors.slice(0, 5));
process.exit(fail ? 1 : 0);
