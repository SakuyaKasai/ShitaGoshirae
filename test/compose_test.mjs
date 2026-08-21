import fs from 'fs';
import JSZip from 'jszip';
import { convert } from '../src/pipeline.js';
import { fitTableWidth, parseCaption, stampTableFonts, replaceAffiliation } from '../src/compose.js';
import { importStyles, collectStyleRefs, indexStyles } from '../src/style-import.js';
import { firstElement, attrOf, allElements, textOf } from '../src/xml-util.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };
const u = p => fs.readFileSync(new URL(p, import.meta.url));
const manifest = JSON.parse(u('../src/manifest.json'));

console.log('\n【1】表の幅スナップ');
const tbl = '<w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="9000"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="6000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
  '<w:tr><w:tc><w:tcPr><w:tcW w:type="dxa" w:w="6000"/></w:tcPr><w:p/></w:tc>' +
  '<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="3000"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>';
const fit = fitTableWidth(tbl, 4634);
const cols = allElements(firstElement(fit.xml, 'w:tblGrid'), 'w:gridCol').map(c => +attrOf(c, 'w:w'));
ok(fit.scaled, '段幅超過を検出して縮小した');
ok(cols[0] + cols[1] <= 4634, `合計が段幅に収まる: ${cols[0]}+${cols[1]}=${cols[0] + cols[1]}`);
ok(Math.abs(cols[0] / cols[1] - 2) < 0.02, `列幅の比率2:1が保たれている: ${(cols[0] / cols[1]).toFixed(3)}`);
const tcWs = allElements(fit.xml, 'w:tcW').map(c => +attrOf(c, 'w:w'));
ok(tcWs[0] === cols[0] && tcWs[1] === cols[1], 'tcW と gridCol が食い違っていない（食い違うとWordが崩す）');
ok(!fitTableWidth(tbl, 99999).scaled, '段幅に収まる表は触らない');

console.log('\n【2】表のフォント統一');
const rPr = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="20"/></w:rPr>';
const t2 = stampTableFonts('<w:tbl><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>見出し</w:t></w:r>' +
                           '<w:r><w:t>素の文字</w:t></w:r></w:tbl>', rPr);
ok((t2.match(/Times New Roman/g) || []).length === 4, '両方の run にフォント指定が入った');
ok(t2.includes('<w:b/>'), '太字（原稿の意図）は残っている');
ok(!t2.includes('w:sz w:val="32"'), '古いサイズ指定は除去された');
ok(textOf(t2) === '見出し素の文字', 'テキストは一字も変わっていない');

console.log('\n【3】キャプション判定');
ok(parseCaption('図1．荷重流路の模式図').kind === 'figure', '図1 を図として判定');
ok(parseCaption('表 2: 解析条件').kind === 'table', '表2 を表として判定');
ok(parseCaption('Fig. 3 Load path').lang === 'en', 'Fig. 3 を英文として判定');
ok(parseCaption('図１．全角番号').num === 1, '全角数字の番号を読める');
ok(parseCaption('図表の作り方について') === null, '「図表の作り方」を誤検出しない');
ok(parseCaption('表現の統一が必要である') === null, '「表現」を表2と誤検出しない');

console.log('\n【4】スタイルの運搬');
const tplStyles = '<w:styles><w:style w:type="paragraph" w:styleId="1"><w:name w:val="標準"/></w:style></w:styles>';
const srcStyles = '<w:styles>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:basedOn w:val="TableNormal"/>' +
  '<w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '</w:styles>';
const imp = importStyles({
  templateStylesXml: tplStyles, sourceStylesXml: srcStyles,
  referencedIn: '<w:tbl><w:tblStyle w:val="TableGrid"/></w:tbl>',
});
ok(imp.imported.includes('TableGrid'), 'TableGrid を取り込んだ');
ok(imp.imported.includes('TableNormal'), 'basedOn の連鎖も辿った（欠けると罫線が半分になる）');
ok(!imp.imported.includes('Heading1'), '段落スタイルは運ばない（テンプレのハンコで上書きするため）');
ok(imp.xml.includes('tblBorders'), '罫線定義が出力に入った');
ok(imp.xml.endsWith('</w:styles>'), 'styles.xml として閉じている');

const imp2 = importStyles({
  templateStylesXml: '<w:styles><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="既存"/></w:style></w:styles>',
  sourceStylesXml: srcStyles, referencedIn: '<w:tblStyle w:val="TableGrid"/>',
});
ok(imp2.imported.length === 0, 'テンプレに同名がある場合は上書きしない');

const imp3 = importStyles({
  templateStylesXml: tplStyles, sourceStylesXml: '<w:styles/>',
  referencedIn: '<w:tblStyle w:val="MissingStyle"/>',
});
ok(imp3.missing.includes('MissingStyle'), '定義が見つからないスタイルを報告する（→ W32）');

console.log('\n【5】所属テキストボックス');
const aff = replaceAffiliation(manifest.affiliation.runXml, {
  received: '受付：2026年8月16日',
  affiliations: [{ mark: '2', text: '人間工学大学' }, { mark: '3', text: '人間工学研究所' }],
}, manifest.geometry);
const txbx = [...aff.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)].map(m => m[1]);
ok(txbx.length === 2, 'txbxContent が2箇所ある（mc:Choice と mc:Fallback）');
ok(txbx[0] === txbx[1], '両方に同じ内容が入っている（片方だけだと古いWordで不整合）');
ok(txbx.every(t => t.includes('人間工学研究所')), '所属テキストが両方に入っている');
ok(!aff.includes('人間工学大学人間工学学部'), 'テンプレの見本所属が残っていない');

const pv = firstElement(aff, 'wp:positionV');
ok(attrOf(pv, 'relativeFrom') === 'page', 'アンカーがページ基準（本文の長さに依存しない）');
const expectTop = (manifest.geometry.pageHeightTwips - manifest.geometry.marginTwips.bottom) * 635
                - Number(attrOf(firstElement(firstElement(aff, 'wp:anchor'), 'wp:extent'), 'cy'));
ok(aff.includes(`<wp:posOffset>${expectTop}</wp:posOffset>`),
   `オフセットが本文エリア下端と一致: ${expectTop} EMU`);
ok(/mso-position-vertical-relative:page/.test(aff), 'VML側（Word 2007互換）も同じ基準に揃えた');

console.log('\n【6】通し変換');
const res = await convert({
  templateBytes: u('../template.docx'),
  sourceBytes: u('../fixture-source.docx'),
  manifest,
  meta: {
    japaneseTitle: 'テスト表題', titleFootnote: '1',
    japaneseAuthors: [{ name: '青木　友里', affiliation: '2' }],
    englishTitle: 'A Test Title', englishAuthors: ['Yuri AOKI'],
    japaneseAbstract: 'あ'.repeat(400), englishAbstract: 'word '.repeat(180),
    keywords: ['着物', '着付け', '腰紐', '荷重流路', '静力学'],
    received: '受付：2026年8月16日',
    affiliations: [{ mark: '2', text: '人間工学大学' }],
  },
  autoFixIds: ['W01', 'W02', 'W15'],
});

const outZip = await JSZip.loadAsync(res.bytes);
const doc = await outZip.file('word/document.xml').async('string');

ok(doc.includes(manifest.sections.section2.sectPr), 'セクション2の sectPr が保たれている（2段組・行番号）');
ok(doc.includes('<w:lnNumType'), '査読用行番号が生きている');
ok(/<w:cols w:num="2"/.test(doc), '2段組が生きている');
ok(!doc.includes('タイトル１'), 'テンプレの見本テキストが残っていない');
ok(doc.includes('テスト表題'), '入力した表題が入っている');
ok((doc.match(/<w:drawing>/g) || []).length >= 2, '画像2枚が w:drawing として入った');
ok(doc.includes('<w:tbl>'), '表が運ばれている');

const outCt = await outZip.file('[Content_Types].xml').async('string');
ok(/Extension="png"/.test(outCt), 'png が Content_Types に登録された');

const outRels = await outZip.file('word/_rels/document.xml.rels').async('string');
const rIds = [...outRels.matchAll(/Id="(rId\d+)"/g)].map(m => m[1]);
ok(new Set(rIds).size === rIds.length, `rId に重複がない（全${rIds.length}件）`);

const docPrIds = [...doc.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)].map(m => m[1]);
ok(new Set(docPrIds).size === docPrIds.length, `docPr id に重複がない（全${docPrIds.length}件）`);

const media = Object.keys(outZip.files).filter(n => n.startsWith('word/media/') && !outZip.files[n].dir);
ok(media.length === 3, `media は テンプレ1枚 + 原稿2枚 = 3枚: ${media.length}`);

const srcImg = await (await JSZip.loadAsync(u('../fixture-source.docx')))
  .file('word/media/image1.png').async('uint8array');
const outImg = await outZip.file('word/media/image2.png').async('uint8array');
ok(outImg.length === srcImg.length && outImg.every((b, i) => b === srcImg[i]),
   '画像バイナリが1バイトも変わっていない（再エンコードなし＝劣化ゼロ）');

const outStyles = await outZip.file('word/styles.xml').async('string');
ok(outStyles.includes('w:styleId="TableGrid"'), '表スタイルが運び込まれている（罫線が消えない）');

console.log('\n【7】自動修正の反映');
ok(!doc.includes('。'), '句点「。」が本文から消えている（W01適用）');
ok(!doc.includes('、'), '読点「、」が本文から消えている（W02適用）');
ok(doc.includes('32 kHz'), '単位前の半角スペースが入っている（W15適用）');
ok(res.report.appliedFixes > 0, `自動修正 ${res.report.appliedFixes}件 を適用`);

console.log('\n【8】検出された警告');
const ids = new Set(res.warnings.map(w => w.id));
for (const expected of ['W03', 'W04', 'W05', 'W06', 'W07', 'W12']) {
  ok(ids.has(expected), `${expected} を検出`);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
