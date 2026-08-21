/**
 * build-manifest.mjs — テンプレ .docx から manifest.json を機械抽出する。
 *
 *   node tools/build-manifest.mjs template.docx src/manifest.json
 *
 * 設計意図:
 *   テンプレ固有の値（ハンコXML・セクション境界・numId）をコードに埋め込むと、
 *   学会がテンプレを改訂したときにコード修正が必要になる。
 *   すべてを manifest.json に外出しし、本ツールの再実行だけで追随できるようにする。
 *
 *   「作らない、運ぶ、警告する」— ここで作るのは値ではなく、値の写しである。
 */
import fs from 'fs';
import JSZip from 'jszip';
import { topLevelChildren, innerXml, firstElement, allElements, textOf, attrOf } from '../src/xml-util.js';

/**
 * 段落直下の run を取り出す。
 * 正規表現の非貪欲マッチ（<w:r>...</w:r>）は使えない。
 * 所属テキストボックスのように w:r の中に w:txbxContent → w:r が入れ子になる場合、
 * 最初の </w:r> で切れてしまい、run が途中で千切れる。
 */
const runsOf = xml => allElements(xml, 'w:r');

const [, , docxPath = 'template.docx', outPath = 'src/manifest.json'] = process.argv;

const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
const read = async n => zip.file(n)?.async('string') ?? null;

const documentXml = await read('word/document.xml');
const numberingXml = await read('word/numbering.xml');

/* ============================================================
 * 1. w:document のルート属性（名前空間宣言）
 *    出力XMLを組み立てる際、これを丸ごと引き継がないと
 *    mc:/wp:/w14: 等が未定義になり Word が開けなくなる。
 * ========================================================== */
const rootOpen = documentXml.slice(
  documentXml.indexOf('<w:document'),
  documentXml.indexOf('>', documentXml.indexOf('<w:document')) + 1,
);

const bodyStart = documentXml.indexOf('<w:body>') + '<w:body>'.length;
const bodyEnd = documentXml.lastIndexOf('</w:body>');
const body = documentXml.slice(bodyStart, bodyEnd);
const afterBody = documentXml.slice(bodyEnd + '</w:body>'.length);

const children = topLevelChildren(body);

/* ============================================================
 * 2. セクション境界を「見つける」
 *    段落の pPr 内に sectPr を持つものがセクション1の最終段落。
 *    インデックス 14 を決め打ちしない — テンプレ改訂で動くため。
 * ========================================================== */
let sec1EndIndex = -1;
children.forEach((c, i) => {
  if (c.tag === 'w:p' && /<w:pPr>[\s\S]*?<w:sectPr[\s\S]*?<\/w:sectPr>[\s\S]*?<\/w:pPr>/.test(c.xml)) {
    if (sec1EndIndex === -1) sec1EndIndex = i;
  }
});
if (sec1EndIndex === -1) throw new Error('E02: セクション区切りが見つかりません');

const sec1Children = children.slice(0, sec1EndIndex + 1);
const sec2Children = children.slice(sec1EndIndex + 1);

const sec1SectPr = firstElement(sec1Children[sec1EndIndex].xml, 'w:sectPr');
const finalSectPr = children.find(c => c.tag === 'w:sectPr')?.xml ?? null;
if (!finalSectPr) throw new Error('E02: 末尾 sectPr が見つかりません');

/* ============================================================
 * 3. セクション2のハンコを拾う
 *    「テキストが○○の段落」で引くのではなく、
 *    段落の形（pPr の署名）と rPr の多数決で決める。
 * ========================================================== */
const paras = sec2Children.filter(c => c.tag === 'w:p').map(c => ({
  xml: c.xml,
  pPr: firstElement(c.xml, 'w:pPr') ?? '<w:pPr/>',
  text: textOf(c.xml),
  runs: runsOf(c.xml),
}));

/** rPr の多数決。rsid 属性は揺れるので落とす */
function majorityRPr(candidates) {
  const tally = new Map();
  for (const r of candidates) {
    const rPr = firstElement(r, 'w:rPr');
    if (!rPr) continue;
    const key = rPr.replace(/\s*w:rsid[A-Za-z]*="[^"]*"/g, '');
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  let best = null, n = 0;
  for (const [k, v] of tally) if (v > n) { best = k; n = v; }
  return { rPr: best, count: n, variants: tally.size };
}

/** 指定テキストで始まる段落を探す（ハンコの標本を採る目的） */
const findPara = pred => paras.find(p => pred(p.text.trim(), p));

// --- 見出し1: 「N. 」で始まり sz=22 を含む
const h1 = findPara(t => /^\d+\.\s/.test(t)) ;
// --- 見出し2: 「N-N. 」で始まる
const h2 = findPara(t => /^\d+-\d+\.\s/.test(t));
// --- 番号なし見出し: pPr が空で 太字 sz=20、かつ本文より極端に短い
const hp = findPara((t, p) => /^(文\u3000献|謝\u3000辞|利益相反)$/.test(t));
// --- 本文: firstLineChars を持つ段落
const bodyParas = paras.filter(p => /w:firstLineChars="100"/.test(p.pPr) && p.text.trim().length > 20);
// --- 参考文献リスト
//     numPr を持つ段落は他にもある（「1) 新しい発見または知見の提示」等の箇条書き）。
//     「文　献」見出しより後ろにある numPr 段落だけが参考文献リストである。
const refHeadingAt = paras.findIndex(p => /^(文\u3000?献|参考文献|References?)$/.test(p.text.trim()));
if (refHeadingAt === -1) throw new Error('E02: 「文　献」見出しが見つかりません');

const refParas = paras.slice(refHeadingAt).filter(p => /<w:numPr>/.test(p.pPr));
const refNumId = refParas.length
  ? Number(attrOf(firstElement(refParas[0].pPr, 'w:numId') ?? '', 'w:val'))
  : null;

// 参考文献以外で numPr を使っている段落（＝箇条書き）の numId も記録しておく。
// 出力時にテンプレ側の例示リストを消す必要があるため。
const otherNumIds = [...new Set(
  paras.slice(0, refHeadingAt)
    .filter(p => /<w:numPr>/.test(p.pPr))
    .map(p => Number(attrOf(firstElement(p.pPr, 'w:numId') ?? '', 'w:val'))),
)];

/** 見出しは番号 run と文字 run で rPr が割れている（テンプレの指定漏れ）。
 *  ＭＳゴシック指定を持つ run を正とする。 */
function headingRPr(p, sz) {
  const gothic = p.runs.filter(r => /ＭＳ ゴシック|w:eastAsia="ＭＳ ゴシック"/.test(r));
  const pick = majorityRPr(gothic.length ? gothic : p.runs);
  return pick.rPr;
}

const stamps = {
  heading1: {
    pPr: h1.pPr,
    rPr: headingRPr(h1),
    note: '11pt ＭＳゴシック太字。テンプレは番号runのascii未指定でCenturyになる不具合があるため統一版を採用',
  },
  heading2: {
    pPr: h2.pPr,
    rPr: majorityRPr(h2.runs).rPr,
    note: '10pt 欧文TimesNewRoman/和文ＭＳゴシック太字。和欧混植が正しく効く形',
  },
  heading3: {
    pPr: h2.pPr,
    rPr: majorityRPr(h2.runs).rPr,
    note: '3階層目はテンプレに実例がないため見出し2と同一のハンコを流用する',
  },
  headingPlain: {
    pPr: hp.pPr,
    rPr: headingRPr(hp),
    note: '番号なし見出し（文献・謝辞・利益相反）。spacingを持たない',
  },
  body: {
    pPr: bodyParas[0].pPr,
    rPr: majorityRPr(bodyParas.flatMap(p => p.runs)).rPr,
    note: '10pt 欧文TimesNewRoman/和文はeastAsia未指定でdocDefaultsのＭＳ明朝を継承',
  },
  reference: {
    pPr: refParas.length ? refParas[0].pPr : null,
    rPr: refParas.length ? majorityRPr(refParas.flatMap(p => p.runs)).rPr : null,
    numId: refNumId,
    note: 'numPr による自動採番。"1)" の手打ちは不要でぶら下げインデントも定義済み',
  },
  caption: {
    pPr: '<w:pPr><w:jc w:val="center"/></w:pPr>',
    rPr: majorityRPr(bodyParas.flatMap(p => p.runs)).rPr,
    note: 'テンプレに図表キャプションの実例がないため、本文ハンコ＋中央揃えで代用する（handoff 参照）',
  },
  empty: {
    pPr: '<w:pPr/>',
    rPr: majorityRPr(bodyParas.flatMap(p => p.runs)).rPr,
    note: '空段落',
  },
};

/* ============================================================
 * 4. セクション1のスロット
 *    どの body index が何のフィールドかを、テキストの特徴から同定する。
 * ========================================================== */
/**
 * セクション1のスロット同定。
 *
 * 本文テキストで引くと壊れる。和文抄録の本文には「キーワード」という語が
 * 含まれており、素朴な部分一致だとキーワード欄と取り違える。
 * したがって判定は「書式の signal」を主、テキストを従とする。
 *
 *   和文タイトル  … メイリオ 14pt（sz=28）— セクション1で唯一
 *   和文著者名    … jc=right — セクション1で唯一
 *   英文見出し    … タブ位置 4820 かつ ", by " を含む
 *   キーワード    … 行頭が「（キーワード」
 *   英文抄録      … 残りのうち ASCII比率が高いもの
 *   和文抄録      … 残り
 */
const asciiRatio = s => s.length ? [...s].filter(ch => ch.charCodeAt(0) < 128).length / s.length : 0;

function classifySec1(c, i) {
  const text = textOf(c.xml).trim();
  const pPr = firstElement(c.xml, 'w:pPr') ?? '<w:pPr/>';
  const rPrs = runsOf(c.xml).map(r => firstElement(r, 'w:rPr') ?? '').join('');

  if (c.tag !== 'w:p') return { index: i, field: null, keep: 'raw', tag: c.tag };
  if (/<w:sectPr/.test(pPr)) return { index: i, field: null, keep: 'raw', note: 'セクション区切り' };
  if (!text) return { index: i, field: null, keep: 'raw', note: 'レイアウト調整用の空段落' };

  if (/,\s*by\s/.test(text)) return { index: i, field: 'englishHead', keep: 'rebuild' };
  if (/^[（(]\s*キーワード/.test(text)) return { index: i, field: 'keywords', keep: 'rebuild' };
  if (/w:sz w:val="28"/.test(rPrs)) return { index: i, field: 'japaneseTitle', keep: 'rebuild' };
  if (/w:jc w:val="right"/.test(pPr)) return { index: i, field: 'japaneseAuthors', keep: 'rebuild' };
  if (asciiRatio(text) > 0.85) return { index: i, field: 'englishAbstract', keep: 'rebuild' };
  return { index: i, field: 'japaneseAbstract', keep: 'rebuild' };
}

const section1 = sec1Children.map((c, i) => {
  const slot = classifySec1(c, i);
  return {
    ...slot,
    tag: c.tag,
    pPr: c.tag === 'w:p' ? (firstElement(c.xml, 'w:pPr') ?? '<w:pPr/>') : null,
    // rebuild 対象は rPr も保存する（ハンコとして使う）
    rPr: slot.keep === 'rebuild'
      ? majorityRPr(runsOf(c.xml)).rPr
      : null,
    raw: slot.keep === 'raw' ? c.xml : null,
    sample: textOf(c.xml).trim().slice(0, 40),
  };
});

/* ============================================================
 * 5. 所属テキストボックス
 *    脚注ではなく、セクション2の本文段落にアンカーされた浮動図形の中にある。
 *    mc:Choice と mc:Fallback に同じテキストが二重に存在するため、
 *    「run 丸ごと」を持ち回り、中のテキストだけ両方書き換える。
 * ========================================================== */
let affiliation = null;
for (const c of sec2Children) {
  if (c.tag !== 'w:p') continue;
  if (!/mc:AlternateContent/.test(c.xml)) continue;
  const runs = runsOf(c.xml);
  const drawingRun = runs.find(r => /mc:AlternateContent/.test(r));
  if (!drawingRun) continue;
  const txbx = [...drawingRun.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)];
  affiliation = {
    runXml: drawingRun,
    txbxCount: txbx.length,
    note: 'mc:Choice と mc:Fallback に同一テキストが重複。片方だけ書き換えると不整合になる',
  };
  break;
}

/* ============================================================
 * 6. 出力
 * ========================================================== */
const manifest = {
  $schema: 'jes-formatter/manifest@1',
  generatedFrom: docxPath,
  generatedAt: new Date().toISOString().slice(0, 10),
  document: { rootOpen, afterBody },
  sections: {
    section1: { endIndex: sec1EndIndex, sectPr: sec1SectPr, slots: section1 },
    section2: { sectPr: finalSectPr },
  },
  geometry: (() => {
    const g = s => Number(attrOf(firstElement(finalSectPr, 'w:pgSz') ?? '', s));
    const m = s => Number(attrOf(firstElement(finalSectPr, 'w:pgMar') ?? '', s));
    const cols = firstElement(finalSectPr, 'w:cols') ?? '';
    const colSpace = Number(attrOf(cols, 'w:space') ?? 0);
    const colNum = Number(attrOf(cols, 'w:num') ?? 1);
    const span = g('w:w') - m('w:left') - m('w:right');
    return {
      pageWidthTwips: g('w:w'), pageHeightTwips: g('w:h'),
      marginTwips: { top: m('w:top'), right: m('w:right'), bottom: m('w:bottom'), left: m('w:left') },
      columns: { num: colNum, spaceTwips: colSpace },
      spanWidthTwips: span,
      singleWidthTwips: (span - colSpace) / colNum,
      columnHeightTwips: g('w:h') - m('w:top') - m('w:bottom'),
    };
  })(),
  stamps,
  affiliation,
  numbering: {
    referenceNumId: refNumId,
    templateExampleCount: refParas.length,
    bulletNumIds: otherNumIds,
  },
  limits: {
    bodyChars: 12000, englishAbstractWords: 200,
    japaneseAbstractChars: 400, keywords: 5, pages: 6,
  },
};

fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 1));

console.log(`✅ ${outPath} を生成しました`);
console.log(`   セクション1: body[0..${sec1EndIndex}] (${sec1Children.length}要素)`);
console.log(`   セクション2: ${sec2Children.length}要素 / 段落${paras.length}`);
console.log(`   本文ハンコの母集団: ${bodyParas.length}段落`);
console.log(`   参考文献 numId: ${refNumId} (テンプレ例示 ${refParas.length}件)`);
console.log(`   所属テキストボックス: ${affiliation ? `検出（txbx ${affiliation.txbxCount}箇所）` : '未検出'}`);
console.log(`   片段: ${manifest.geometry.singleWidthTwips} twips / 段抜き: ${manifest.geometry.spanWidthTwips} twips`);
for (const [k, v] of Object.entries(stamps)) {
  if (!v.rPr) { console.log(`   ⚠️ ${k}: rPr を抽出できませんでした`); continue; }
  const sz = /w:sz w:val="(\d+)"/.exec(v.rPr)?.[1];
  console.log(`   ${k.padEnd(13)} sz=${sz ?? '?'} ${/<w:b\/>/.test(v.rPr) ? 'bold' : '    '}`);
}
