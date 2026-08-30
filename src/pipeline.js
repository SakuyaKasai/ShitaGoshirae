/**
 * pipeline.js — 変換の一本道。
 *
 *   テンプレ.docx ─┐
 *   原稿.docx    ─┴→ 解析 → チェック → ハンコ押し → 再パッケージ → 出力.docx + 警告
 *
 * ここが唯一「順序」を知っている場所である。
 * 個々のモジュールは互いを知らない（テストしやすさのため）。
 */

import JSZip from 'jszip';
import { parseSourceDocx, blocksToLines } from './source-parse.js';
import { composeBody, composeSection1, replaceAffiliation, buildDocumentXml } from './compose.js';
import { RIdAllocator, DocPrIdAllocator, COLUMN_WIDTH } from './image-transfer.js';
import { mergeNumbering, remapNumPr, collectUsedNumIds } from './numbering-merge.js';
import { runChecks, applyFixesById } from './checker.js';
import { importStyles } from './style-import.js';
import { analyzeHeadings } from './heading-detect.js';

/** テンプレ由来の必須パート。1つでも欠けたらテンプレが壊れている */
const REQUIRED_PARTS = [
  '[Content_Types].xml',
  'word/document.xml',
  'word/_rels/document.xml.rels',
  'word/styles.xml',
];

/**
 * @param {object} input
 *   input.templateBytes  ArrayBuffer|Uint8Array  テンプレ .docx
 *   input.sourceBytes    ArrayBuffer|Uint8Array  原稿 .docx
 *   input.manifest       manifest.json をパースしたもの
 *   input.meta           フォーム入力（表題・著者・抄録・キーワード・所属）
 *   input.autoFixIds     自動修正を適用する警告ID（['W01','W02'] など）
 *   input.bodyStart      本文の開始ブロック番号。これより前（表題・抄録・所属）は
 *                        フォームから組むので、本文へ二重に流し込まない
 * @returns {Promise<{bytes:Uint8Array, warnings:Array, report:object}>}
 */
export async function convert({
  templateBytes, sourceBytes, manifest, meta = {}, autoFixIds = [], bodyStart = 0, referenceOverrides = null,
}) {
  const warnings = [];

  /* ---------- 1. テンプレを開く ---------- */
  const tpl = await JSZip.loadAsync(templateBytes);
  for (const part of REQUIRED_PARTS) {
    if (!tpl.file(part)) {
      throw Object.assign(
        new Error(`テンプレートに ${part} がありません。学会配布の最新版をご確認ください`),
        { code: 'E02' },
      );
    }
  }

  /* ---------- 2. 原稿を開いて解析 ---------- */
  const srcZip = await JSZip.loadAsync(sourceBytes);
  if (!srcZip.file('word/document.xml')) {
    throw Object.assign(
      new Error('Wordファイル（.docx）として読めませんでした。PDFや古い .doc 形式は変換できません'),
      { code: 'E01' },
    );
  }
  const src = await parseSourceDocx(srcZip);
  warnings.push(...src.warnings);

  // 原稿の冒頭にある表題・著者・抄録・所属は、セクション1としてフォームから組む。
  // ここで切り落とさないと、同じ内容が本文の先頭にもう一度出てしまう。
  const headBlocks = src.blocks.slice(0, bodyStart);
  src.blocks = src.blocks.slice(bodyStart);

  // ただし切り落とした範囲に図・表があれば、それは本文の一部なので拾い直す。
  const strandedFigures = headBlocks.filter(b => b.kind === 'image' || b.kind === 'table');
  if (strandedFigures.length) {
    src.blocks = [...strandedFigures, ...src.blocks];
    warnings.push({
      id: 'W33', level: 'info',
      message: `表題まわりにあった図表 ${strandedFigures.length}件 を本文の先頭へ移しました。位置をご確認ください`,
    });
  }

  /* ---------- 3. チェッカーを回す ---------- */
  //     本文の実テキストに対して走らせる。修正は「本文の運搬前」に適用する。
  const lines = blocksToLines(src.blocks);
  const checkText = lines.join('\n');
  const checkResult = runChecks(checkText, {
    englishTitle: meta.englishTitle,
    englishAuthors: meta.englishAuthors,
    keywords: meta.keywords,
  });

  const headingInfo = analyzeHeadings(lines);
  warnings.push(...headingInfo.warnings);
  warnings.push(...checkResult.results);

  /* ---------- 4. 自動修正の適用 ---------- */
  //     行番号を保ったまま直したいので、行単位で再分割する。
  let fixedLines = lines;
  let appliedFixes = 0;
  if (autoFixIds.length) {
    const before = checkText;
    const after = applyFixesById(before, checkResult.results, autoFixIds);
    if (after !== before) {
      fixedLines = after.split('\n');
      appliedFixes = checkResult.results
        .filter(r => autoFixIds.includes(r.id))
        .reduce((n, r) => n + (r.count ?? (r.fixes?.length ?? 0)), 0);
    }
    // 行数が変わったら適用しない（安全側に倒す）
    if (fixedLines.length !== lines.length) {
      warnings.push({
        id: 'W31', level: 'warn',
        message: '自動修正で行の数が変わってしまったため、修正を適用しませんでした。手動で修正してください',
      });
      fixedLines = lines;
      appliedFixes = 0;
    }
  }

  /* ---------- 4-2. ガイド編集で確定した参考文献を差し替える ---------- */
  //     必ず自動修正の「あと」に置くこと。applyFixesById は本文全体の
  //     文字オフセットで動くため、先に行を差し替えるとオフセットが総崩れになる。
  //     行単位の上書きなので、ここでは行数が変わらない。
  //
  //     ここで入る文字列は人間が確定させたものなので、自動修正は当たらない
  //     （すでに適用済みの文字列を丸ごと置き換えるため）。「勝手に直さない」を守る。
  let overriddenRefs = 0;
  if (referenceOverrides) {
    const entries = referenceOverrides instanceof Map
      ? [...referenceOverrides.entries()]
      : Object.entries(referenceOverrides).map(([k, v]) => [Number(k), v]);
    fixedLines = [...fixedLines];
    for (const [i, text] of entries) {
      if (!Number.isInteger(i) || i < 0 || i >= fixedLines.length) continue;
      if (typeof text !== 'string' || !text.trim()) continue;
      fixedLines[i] = text;
      overriddenRefs++;
    }
  }
  
  const blocks = src.blocks.map((b, i) =>
    (b.kind === 'paragraph' || b.kind === 'math') ? { ...b, text: fixedLines[i] ?? b.text } : b);

  /* ---------- 5. 出力ZIPをテンプレの複製として作る ---------- */
  //     「テンプレを土台に、必要な部分だけ差し替える」— 消すより残すほうが安全。
  const out = new JSZip();
  const tplFiles = Object.keys(tpl.files).filter(n => !tpl.files[n].dir);
  for (const name of tplFiles) {
    if (name === 'word/document.xml') continue;              // あとで作る
    if (name === '[Content_Types].xml') continue;            // あとで作る
    if (name === 'word/_rels/document.xml.rels') continue;   // あとで作る
    if (name === 'word/numbering.xml') continue;             // あとで作る
    if (name === 'word/styles.xml') continue;                // あとで作る
    out.file(name, await tpl.file(name).async('uint8array'), { binary: true });
  }

  let contentTypesXml = await tpl.file('[Content_Types].xml').async('string');
  let relsXml = await tpl.file('word/_rels/document.xml.rels').async('string');
  const tplDocumentXml = await tpl.file('word/document.xml').async('string');
  const tplNumberingXml = (await tpl.file('word/numbering.xml')?.async('string')) ?? null;

  /* ---------- 6. numbering をマージ ---------- */
  let numberingXml = tplNumberingXml;
  let numIdMap = new Map();
  if (tplNumberingXml && src.numberingXml) {
    const srcDocXml = await srcZip.file('word/document.xml').async('string');
    const used = collectUsedNumIds(srcDocXml);
    const merged = mergeNumbering({
      templateXml: tplNumberingXml,
      sourceXml: src.numberingXml,
      usedNumIds: used,
    });
    numberingXml = merged.xml;
    numIdMap = merged.numIdMap ?? new Map();
  }
  if (numberingXml) out.file('word/numbering.xml', numberingXml);

  /* ---------- 7. 画像の移設コンテキスト ---------- */
  //     テンプレ側の media は既に out へコピー済みなので、
  //     連番は「テンプレの最大 + 1」から始める。
  const tplMediaMax = tplFiles
    .filter(n => /^word\/media\/image(\d+)\./.test(n))
    .reduce((m, n) => Math.max(m, Number(/image(\d+)\./.exec(n)[1])), 0);

  const ctx = {
    zipOut: out,
    contentTypesXml,
    relsXml,
    rIds: new RIdAllocator(relsXml),
    docPrIds: new DocPrIdAllocator([tplDocumentXml]),
    mediaSeq: { n: tplMediaMax + 1 },
    warnings,
  };

  /* ---------- 8. 本文を組み立てる ---------- */
  const bodyResult = composeBody(blocks, manifest, ctx);
  warnings.push(...bodyResult.warnings);

  // 運んだ表が参照しているスタイル定義を、原稿から出力側へ持ってくる。
  // これをしないと <w:tblStyle w:val="TableGrid"/> の参照先が解決できず
  // 罫線が黙って消える（Word はエラーを出さない）。
  let stylesXml = await tpl.file('word/styles.xml').async('string');
  if (bodyResult.tableXmls.length) {
    const srcStyles = (await srcZip.file('word/styles.xml')?.async('string')) ?? null;
    const imported = importStyles({
      templateStylesXml: stylesXml,
      sourceStylesXml: srcStyles,
      referencedIn: bodyResult.tableXmls.join(''),
    });
    stylesXml = imported.xml;
    if (imported.missing.length) {
      warnings.push({
        id: 'W32', level: 'warn',
        message: `表のスタイル「${imported.missing.join('，')}」の定義が原稿に見つかりませんでした。` +
                 `罫線が消えている可能性があります。出力後に確認してください`,
      });
    }
  }
  out.file('word/styles.xml', stylesXml);

  let section2Xml = bodyResult.xml;
  if (numIdMap.size) section2Xml = remapNumPr(section2Xml, numIdMap);

  /* ---------- 9. 所属テキストボックスを差し込む ---------- */
  //     所属は本文段落にアンカーされた浮動図形の中にある。
  //     本文を差し替えると消えるので、先頭段落へ改めて取り付ける。
  if (manifest.affiliation?.runXml) {
    const affRun = replaceAffiliation(manifest.affiliation.runXml, meta, manifest.geometry);
    const firstP = section2Xml.indexOf('<w:p>');
    if (firstP !== -1) {
      const insertAt = section2Xml.indexOf('>', section2Xml.indexOf('</w:pPr>', firstP)) + 1;
      const at = insertAt > 0 ? insertAt : section2Xml.indexOf('>', firstP) + 1;
      section2Xml = section2Xml.slice(0, at) + affRun + section2Xml.slice(at);
    } else {
      section2Xml = `<w:p>${affRun}</w:p>` + section2Xml;
    }
  }

  /* ---------- 10. セクション1 ---------- */
  const section1Xml = composeSection1(meta, manifest);

  /* ---------- 11. 書き出し ---------- */
  out.file('word/document.xml', buildDocumentXml({ manifest, section1Xml, section2Xml }));
  out.file('[Content_Types].xml', ctx.contentTypesXml);
  out.file('word/_rels/document.xml.rels', ctx.rIds.apply(ctx.relsXml));

  const bytes = await out.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  /* ---------- 12. 分量のチェック ---------- */
  const bodyChars = blocks
    .filter(b => b.kind === 'paragraph')
    .reduce((n, b) => n + b.text.length, 0);
  if (bodyChars > manifest.limits.bodyChars) {
    warnings.push({
      id: 'W08', level: 'warn',
      message: `本文が ${bodyChars.toLocaleString()}字 です。${manifest.limits.pages}ページ目安の` +
               `約${manifest.limits.bodyChars.toLocaleString()}字を超えています`,
    });
  }

  return {
    bytes,
    warnings: dedupeWarnings(warnings),
    report: {
      ...src.stats,
      bodyChars,
      headings: headingInfo.stats,
      outline: bodyResult.outline,
      appliedFixes,
      summary: summarize(warnings),
    },
  };
}

/** 同じ ID・同じ文面の警告が複数モジュールから出ることがあるため畳む */
function dedupeWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const w of list) {
    const key = `${w.id}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

function summarize(list) {
  const s = { stop: 0, warn: 0, info: 0, autoFixable: 0 };
  for (const w of dedupeWarnings(list)) {
    if (w.level === 'stop') s.stop++;
    else if (w.level === 'info') s.info++;
    else s.warn++;
    if (w.autoFix === true || (w.fixes && w.fixes.length)) s.autoFixable++;
  }
  return s;
}
