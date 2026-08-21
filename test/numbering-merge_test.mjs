import fs from 'fs';
import { scanNumberingIds, collectUsedNumIds, mergeNumbering, remapNumPr }
  from '../src/numbering-merge.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  ✅',m)):(fail++,console.log('  ❌',m)); };

const tplNum = fs.readFileSync('numbering.xml','utf8');
const docXml = fs.readFileSync('document.xml','utf8');

console.log('\n【1】テンプレの使用済みID');
const t = scanNumberingIds(tplNum);
ok(t.maxNumId===21 && t.maxAbstractNumId===20,
   `max numId=${t.maxNumId} / max abstractNumId=${t.maxAbstractNumId}`);

console.log('\n【2】本文で実際に使われている numId');
const used = collectUsedNumIds(docXml);
ok(used.has(17) && used.has(14), `使用中: ${[...used].sort((a,b)=>a-b).join(', ')}`);
ok(used.size < t.numIds.size, `定義21件のうち使用は${used.size}件（未使用は取り込まない）`);

console.log('\n【3】自己マージ耐性テスト（最も衝突しやすい条件）');
// テンプレ自身を「原稿」として食わせる = 全IDが確実に衝突する状況
const merged = mergeNumbering({ templateXml: tplNum, sourceXml: tplNum, usedNumIds: used });
ok(merged.imported === used.size, `${merged.imported}件を取り込み`);

const after = scanNumberingIds(merged.xml);
ok(after.numIds.size === t.numIds.size + merged.imported,
   `numId 総数 ${t.numIds.size} → ${after.numIds.size}（欠落・上書きなし）`);
ok(after.abstractNumIds.size === t.abstractNumIds.size + [...new Set([...merged.numIdMap.keys()])].length,
   `abstractNumId 総数 ${t.abstractNumIds.size} → ${after.abstractNumIds.size}`);

// 重複チェック（生テキストで数える）
const allNumIds = [...merged.xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"/g)].map(m=>m[1]);
ok(new Set(allNumIds).size === allNumIds.length,
   `numId に重複なし（全${allNumIds.length}件がユニーク）`);
const allAbs = [...merged.xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"/g)].map(m=>m[1]);
ok(new Set(allAbs).size === allAbs.length,
   `abstractNumId に重複なし（全${allAbs.length}件がユニーク）`);
console.log(`     → 対応表: ${[...merged.numIdMap].map(([a,b])=>`${a}→${b}`).join(', ')}`);

console.log('\n【4】スキーマ順序（abstractNum は num より前）');
const lastAbs = merged.xml.lastIndexOf('</w:abstractNum>');
const firstNum = merged.xml.search(/<w:num\b[^>]*w:numId=/);
ok(lastAbs < firstNum, `最後の abstractNum(${lastAbs}) < 最初の num(${firstNum})`);

console.log('\n【5】ぶら下がり参照の除去');
const importedChunk = merged.xml.slice(lastAbs - 4000);
ok(!/w16cid:durableId/.test(merged.xml.slice(merged.xml.length - 2000)),
   'durableId を除去');
const nsids = [...merged.xml.matchAll(/<w:nsid w:val="([^"]+)"/g)].map(m=>m[1]);
ok(new Set(nsids).size === nsids.length, `nsid に重複なし（全${nsids.length}件）`);

console.log('\n【6】本文の張り替え');
const body = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="17"/></w:numPr>' +
             '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="14"/></w:numPr>';
const remapped = remapNumPr(body, merged.numIdMap);
const m17 = merged.numIdMap.get(17), m14 = merged.numIdMap.get(14);
ok(remapped.includes(`w:val="${m17}"`) && remapped.includes(`w:val="${m14}"`),
   `17→${m17}, 14→${m14} に張り替え`);
ok(!remapped.includes('w:val="17"') && !remapped.includes('w:val="14"'),
   '旧IDが残っていない');

// 二重変換の罠: 17→38 のとき、38 が既存の旧IDでも再変換されないこと
const twice = remapNumPr(remapped, new Map([[m17, 999]]));
ok(twice.includes('w:val="999"'), '単一パス置換（Mapを引くのは常に元の値）');

console.log('\n【7】原稿に numbering.xml が無い場合');
const none = mergeNumbering({ templateXml: tplNum, sourceXml: null, usedNumIds: new Set([1]) });
ok(none.xml === tplNum && none.imported === 0, 'テンプレを一切変更しない');

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail?1:0);
