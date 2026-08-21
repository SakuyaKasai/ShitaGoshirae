import fs from 'fs';
import JSZip from 'jszip';
import { parseSourceDocx, parseRels, blocksToLines } from '../src/source-parse.js';
import {
  elementEnd, topLevelChildren, firstElement, allElements, attrOf,
  innerXml, textOf, escapeXml, unescapeXml, stripInvalidXmlChars, withAttr,
} from '../src/xml-util.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

console.log('\n【1】xml-util: 入れ子の取り出し');
const nested = '<w:r><w:rPr><w:b/></w:rPr><w:drawing><w:r><w:t>inner</w:t></w:r></w:drawing></w:r><w:r><w:t>next</w:t></w:r>';
const runs = allElements(nested, 'w:r');
ok(runs.length === 2, `直下の run は2本（入れ子の run を数えていない）: ${runs.length}`);
ok(runs[0].includes('inner'), '1本目に入れ子の中身が丸ごと入っている');
ok(runs[1] === '<w:r><w:t>next</w:t></w:r>', '2本目が正しく切れている');

ok(elementEnd('<w:br/>rest', 0) === 7, '自己終了タグの終端（"<w:br/>" は7文字）');
ok(elementEnd('<w:p><w:p/></w:p>tail', 0) === 17, '同名タグの入れ子で外側の終端を返す');
ok(firstElement('<a><w:p x="1"/></a>', 'w:p') === '<w:p x="1"/>', '自己終了要素をfirstElementで取得');
ok(attrOf('<wp:extent cx="123" cy="45"/>', 'cx') === '123', '属性の取得');
ok(withAttr('<w:t a="1">x</w:t>', 'a', '2') === '<w:t a="2">x</w:t>', '属性の上書き');
ok(withAttr('<w:t>x</w:t>', 'b', '9') === '<w:t b="9">x</w:t>', '属性の追加');
ok(innerXml('<w:p><w:r/></w:p>') === '<w:r/>', 'innerXml');
ok(innerXml('<w:p/>') === '', '自己終了のinnerXmlは空');

console.log('\n【2】xml-util: テキストとエスケープ');
ok(textOf('<w:t>あ</w:t><w:tab/><w:t xml:space="preserve"> い</w:t>') === 'あ\t い',
   'w:tab と xml:space を保った連結');
ok(textOf('<w:t>a &amp; b &lt;c&gt;</w:t>') === 'a & b <c>', '実体参照の復元');
ok(escapeXml('a & b <c>') === 'a &amp; b &lt;c&gt;', 'エスケープ');
ok(unescapeXml(escapeXml('"\'&<>')) === '"\'&<>', '往復して元に戻る');
ok(stripInvalidXmlChars('あ\u000Bい\u0000う') === 'あいう',
   '制御文字を除去（Googleドキュメント由来の0x0B対策）');

console.log('\n【3】rels の解析');
const rels = parseRels(
  '<Relationships><Relationship Id="rId5" Type="http://x/image" Target="media/image1.png"/>' +
  '<Relationship Id="rId9" Type="http://x/hyperlink" Target="http://e.com" TargetMode="External"/></Relationships>');
ok(rels.size === 2 && rels.get('rId5').target === 'media/image1.png', 'rId → target');
ok(rels.get('rId9').mode === 'External', 'TargetMode を保持');

console.log('\n【4】原稿docxの解析');
const zip = await JSZip.loadAsync(fs.readFileSync(new URL('../fixture-source.docx', import.meta.url)));
const src = await parseSourceDocx(zip);
console.log('     stats:', JSON.stringify(src.stats));

ok(src.stats.tables === 1, '表を1件、w:tbl のまま取得');
ok(src.stats.images === 2, '画像を2件取得');
ok(src.blocks.filter(b => b.kind === 'image').every(b => b.bytes instanceof Uint8Array),
   '画像は Uint8Array で読めている（文字列で読むと壊れる）');

const img = src.blocks.find(b => b.kind === 'image');
ok(img.srcExtent && img.srcExtent.cx > 0, `wp:extent を取得: ${img.srcExtent.cx}×${img.srcExtent.cy} EMU`);
ok(img.path.startsWith('word/media/'), `パスを解決: ${img.path}`);

const tbl = src.blocks.find(b => b.kind === 'table');
ok(tbl.xml.startsWith('<w:tbl') && tbl.xml.endsWith('</w:tbl>'), '表は生XMLを丸ごと保持');
ok(tbl.xml.includes('摩擦係数'), '表の中身が失われていない');

console.log('\n【5】行への変換とチェッカー連携');
const lines = blocksToLines(src.blocks);
ok(lines.some(l => l.startsWith('１．はじめに')), '全角記法の見出しを保持');
ok(lines.some(l => l.includes('ΣᵢFᵢ')), 'Unicode数式のベタ書きを保持（W07で拾う対象）');
ok(lines.length === src.blocks.length, '行数とブロック数が1対1で対応');

console.log('\n【6】画像とキャプションの分離');
const idx = src.blocks.findIndex(b => b.kind === 'image');
const after = src.blocks.slice(idx + 1).find(b => b.kind === 'paragraph' && b.text);
ok(/^図1/.test(after.text), `画像の直後にキャプション段落が独立している: ${after.text}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
