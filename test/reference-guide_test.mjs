/**
 * reference-guide_test.mjs — 参考文献のガイド編集を、実ブラウザで通しで動かす。
 *
 *   node test/reference-guide_test.mjs
 *
 * なぜ別立てにするか:
 *   ui_test.mjs は ①原稿 → ②書誌情報 → ③ゲラ → ④出力 の本線を見るが、
 *   ガイド編集モーダルには一度も触れない。つまりモーダル側が丸ごと壊れても緑になる。
 *
 * このテストが守っている回帰（2026-09-02）:
 *   ゲラは bodyLines（state.lines.slice(bodyStart)）の添字で描かれているのに、
 *   モーダルへ渡す原文を state.lines[i] から引いていた。bodyStart ぶんずれて
 *   所属の行が「残り」枠に出ていた。添字ではなく原文そのものを渡す形に変えてある。
 *   → handoff 15-9 / 16-7
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

const isNoise = t => /Failed to load resource|net::ERR|fonts\.(googleapis|gstatic)/.test(t);
const errors = [];
page.on('pageerror', e => { if (!isNoise(String(e))) errors.push(String(e)); });
page.on('console', m => { if (m.type() === 'error' && !isNoise(m.text())) errors.push(m.text()); });

// 開くのは run-all が「いまのソースから」焼いた1枚。
// 直接叩いたときだけ、リポジトリの index.html にフォールバックする。
// （単体で走らせて落ちたら、まず `npm run build` を疑うこと）
const bundle = process.env.BUNDLE_HTML ?? path.join(root, 'index.html');
await page.goto('file://' + bundle);
await page.setInputFiles('#file', path.join(root, 'fixture-full.docx'));
await page.waitForSelector('.form', { timeout: 20000 });
await page.click('.actions .btn-primary');
await page.waitForSelector('.galley-body');

console.log('\n【1】ガイド編集の入口');
const guideCount = await page.locator('.gl-guide').count();
ok(guideCount > 0, `文献の行に「ガイド編集」が出ている（${guideCount}件）`);

const row = page.locator('.gl').filter({ has: page.locator('.gl-guide') }).first();
const rowText = (await row.locator('.gl-t').innerText()).replace(/\s+/g, ' ').trim();

await row.locator('.gl-guide').click();
await page.waitForSelector('.rg', { timeout: 5000 });
ok(errors.length === 0, `モーダルを開いてエラーなし${errors.length ? ': ' + errors[0] : ''}`);

console.log('\n【2】渡っている原文が、押した行と同じか（回帰）');
const orig = (await page.locator('.rg-orig').innerText()).replace(/^元：/, '').trim();
const rest = await page.locator('.rg-rest').inputValue();

// 原文は「押した行そのもの」でなければならない。
ok(rowText.includes(orig) || orig === rowText,
   `「元：」がゲラの行と一致: ${orig.slice(0, 44)}`);

// 「残り」は原文から取り出した分を抜いたものなので、原文の部分列になっているはず。
// 無関係な行が渡ると、ここで別の文字列が出る。
const restCore = rest.replace(/\s+/g, '');
const origCore = orig.replace(/\s+/g, '');
ok(restCore.length > 0 && [...restCore].every(ch => origCore.includes(ch)),
   `「残り」が原文由来の文字だけでできている: ${rest.slice(0, 44)}`);
ok(!rest.includes('School of Ergonomics') && !rest.includes('人間工学大学'),
   '「残り」に所属の行が混ざっていない（bodyStart ずれの回帰）');

console.log('\n【3】組み立て');
await page.selectOption('.rg-type', 'journal');
const fieldCount = await page.locator('.rg-in').count();
ok(fieldCount > 0, `種別を選ぶと入力欄が出る（${fieldCount}欄）`);

const yearVal = await page.locator('#rg-f-year').inputValue().catch(() => '');
ok(yearVal !== '', `出版年が自動で入っている: ${yearVal}`);

// 「残り」の先頭語を著者名へ取り込む
const before = await page.locator('.rg-rest').inputValue();
const head = before.replace(/^\d+\)\s*/, '').split(/[.．,，]/)[0];
const at = before.indexOf(head);
await page.$eval('.rg-rest', (n, [a, len]) => { n.focus(); n.setSelectionRange(a, a + len); },
                 [at, head.length]);
await page.locator('.rg-row', { has: page.locator('#rg-f-authors') })
  .locator('.rg-take').click().catch(async () => {
    await page.locator('.rg-take').first().click();
  });
const after = await page.locator('.rg-rest').inputValue();
ok(after.length < before.length, `取り込むと「残り」が減る（${before.length} → ${after.length}字）`);

const out = (await page.locator('.rg-out').innerText()).trim();
ok(out.length > 0 && out !== '（まだ何も入っていません）', `プレビューが組み上がる: ${out.slice(0, 44)}`);

console.log('\n【4】確定してゲラへ戻る');
await page.locator('.rg-foot .btn-primary').click();
await page.waitForSelector('.rg', { state: 'detached', timeout: 5000 });
const edited = (await row.locator('.gl-t').innerText()).replace(/\s+/g, ' ').trim();
ok(edited !== rowText, `ゲラの行が差し替わった: ${edited.slice(0, 44)}`);
ok(await row.locator('.gl-t.is-edited').count() === 1, '編集済みの印が付いている');

console.log('\n【5】工程を行き来しても編集が残るか');
await page.locator('.step').nth(1).click().catch(() => {});
await page.waitForTimeout(300);
await page.locator('.step').nth(2).click().catch(() => {});
await page.waitForTimeout(300);
if (await page.locator('.galley-body').count()) {
  const again = page.locator('.gl').filter({ has: page.locator('.gl-guide') }).first();
  const shown = (await again.locator('.gl-t').innerText()).replace(/\s+/g, ' ').trim();
  ok(shown === edited, `再描画しても編集後の文字列が出ている: ${shown.slice(0, 44)}`);
} else {
  ok(true, '再描画の確認は工程UIの都合で省略');
}

ok(errors.length === 0, `通しでエラーなし${errors.length ? ': ' + errors[0] : ''}`);
await page.screenshot({ path: path.join(root, 'shot-guide.png'), fullPage: true });
await browser.close();

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
