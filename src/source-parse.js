/**
 * source-parse.js — 原稿 .docx を「ブロックの列」へ分解する。
 *
 * mammoth.js を使わない理由:
 *   mammoth は docx → HTML の変換器である。HTML に落とした時点で
 *   w:tbl の罫線定義、m:oMath の数式XML、wp:extent の配置寸法が失われる。
 *   本アプリの原則は「運ぶ」であって「変換する」ではないため、
 *   運ぶべき対象（表・数式・画像）は生XMLのまま抱えたまま持ち回る必要がある。
 *
 * 出力するブロックの種類:
 *   { kind:'paragraph', text, runsXml, listRef }   … テキスト段落
 *   { kind:'table',     xml, text }                … w:tbl を丸ごと
 *   { kind:'math',      xml, text }                … m:oMath / m:oMathPara を含む段落
 *   { kind:'image',     bytes, srcExtent, ... }    … 画像1枚
 *   { kind:'drawing',   name }                     … 図形/SmartArt（運べない → W14）
 */

import {
  topLevelChildren, firstElement, allElements, attrOf, textOf, stripInvalidXmlChars,
} from './xml-util.js';

const REL_TYPE_IMAGE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/* ============================================================
 * リレーション表
 * ========================================================== */

/**
 * word/_rels/document.xml.rels から rId → { type, target } の表を作る。
 * 画像 run の r:embed から実ファイルを引くために使う。
 */
export function parseRels(relsXml) {
  const map = new Map();
  if (!relsXml) return map;
  for (const rel of allElements(relsXml, 'Relationship')) {
    const id = attrOf(rel, 'Id');
    if (!id) continue;
    map.set(id, {
      type: attrOf(rel, 'Type'),
      target: attrOf(rel, 'Target'),
      mode: attrOf(rel, 'TargetMode'),
    });
  }
  return map;
}

/* ============================================================
 * 画像参照の抽出
 * ========================================================== */

/**
 * w:drawing 1個から画像参照を取り出す。
 *
 * 縦横比の算出元として wp:extent を最優先する。
 * トリミングされた画像は「実ピクセル比 ≠ 表示比」になるため、
 * 実ピクセルから比率を取ると図が伸びる。
 */
function readDrawing(drawingXml) {
  const blip = firstElement(drawingXml, 'a:blip');
  const embed = blip ? attrOf(blip, 'r:embed') : null;
  const extentEl = firstElement(drawingXml, 'wp:extent');
  const cx = extentEl ? Number(attrOf(extentEl, 'cx')) : 0;
  const cy = extentEl ? Number(attrOf(extentEl, 'cy')) : 0;
  const docPr = firstElement(drawingXml, 'wp:docPr');
  return {
    embed,
    srcExtent: cx > 0 && cy > 0 ? { cx, cy } : null,
    name: (docPr && attrOf(docPr, 'descr')) || (docPr && attrOf(docPr, 'name')) || null,
    floating: /<wp:anchor/.test(drawingXml),
  };
}

/**
 * 段落から「運べない図」を探す。
 * Word の図形・SmartArt・グラフは media/ にファイルを持たず、
 * DrawingML として描画されるためコピーできない。→ W14
 */
function detectUnportableGraphics(xml) {
  const out = [];
  if (/<a:graphicData\s[^>]*uri="[^"]*diagram"/.test(xml)) out.push('SmartArt');
  if (/<a:graphicData\s[^>]*uri="[^"]*chart"/.test(xml)) out.push('グラフ');
  // wps:wsp = 図形。ただしテキストボックスも同じ要素を使うため、
  // 中に txbxContent があるものは「図形で描いた図」ではないと判断する。
  for (const wsp of allElements(xml, 'wps:wsp')) {
    if (!/<w:txbxContent>/.test(wsp)) { out.push('図形'); break; }
  }
  if (/<v:shape|<v:group|<v:rect|<v:oval/.test(xml) && !/<w:txbxContent>/.test(xml)) {
    out.push('図形(VML)');
  }
  return [...new Set(out)];
}

/* ============================================================
 * 段落の解析
 * ========================================================== */

/**
 * 段落1個を1ブロックへ。
 * 画像を含む場合は、画像を別ブロックとして切り出したうえで
 * 残りのテキストを段落ブロックにする（＝図とキャプションを分離できる）。
 */
function parseParagraph(pXml, ctx) {
  const blocks = [];
  const pPr = firstElement(pXml, 'w:pPr') ?? '';
  const text = textOf(pXml).replace(/\t/g, ' ').trim();

  // --- 数式 ---
  const maths = [...allElements(pXml, 'm:oMathPara'), ...allElements(pXml, 'm:oMath')];
  if (maths.length) {
    // oMathPara の中に oMath があるので、外側だけを採る
    const outer = allElements(pXml, 'm:oMathPara').length
      ? allElements(pXml, 'm:oMathPara')
      : allElements(pXml, 'm:oMath');
    blocks.push({ kind: 'math', xml: outer.join(''), text, source: 'oMath' });
    return blocks;
  }

  // --- 画像 ---
  for (const drawing of allElements(pXml, 'w:drawing')) {
    const ref = readDrawing(drawing);
    if (!ref.embed) continue;
    const rel = ctx.rels.get(ref.embed);
    if (!rel || rel.type !== REL_TYPE_IMAGE) continue;
    const target = rel.target.replace(/^\.\.\//, '').replace(/^\/+/, '');
    const path = target.startsWith('word/') ? target : `word/${target}`;
    blocks.push({
      kind: 'image',
      path,
      srcExtent: ref.srcExtent,
      floating: ref.floating,
      name: ref.name,
    });
  }

  // --- 運べない図 ---
  const unportable = detectUnportableGraphics(pXml);
  if (unportable.length) {
    blocks.push({ kind: 'drawing', variety: unportable.join('・'), text });
  }

  // --- テキスト ---
  if (text) {
    const numPr = firstElement(pPr, 'w:numPr');
    blocks.push({
      kind: 'paragraph',
      text: stripInvalidXmlChars(text),
      listRef: numPr
        ? {
            numId: Number(attrOf(firstElement(numPr, 'w:numId') ?? '', 'w:val')),
            ilvl: Number(attrOf(firstElement(numPr, 'w:ilvl') ?? '', 'w:val') ?? 0),
          }
        : null,
      pageBreak: /<w:br\s[^>]*w:type="page"|<w:lastRenderedPageBreak/.test(pXml),
    });
  } else if (!blocks.length) {
    blocks.push({ kind: 'paragraph', text: '', listRef: null, pageBreak: false });
  }

  return blocks;
}

/* ============================================================
 * 入口
 * ========================================================== */

/**
 * @param {JSZip} zip 原稿 .docx を読み込んだ JSZip
 * @returns {Promise<{blocks:Array, numberingXml:string|null, warnings:Array, stats:object}>}
 */
export async function parseSourceDocx(zip) {
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) {
    throw Object.assign(new Error('word/document.xml がありません'), { code: 'E04' });
  }

  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  const numberingXml = (await zip.file('word/numbering.xml')?.async('string')) ?? null;
  const ctx = { rels: parseRels(relsXml) };

  const bodyStart = documentXml.indexOf('<w:body>');
  if (bodyStart === -1) {
    throw Object.assign(new Error('w:body がありません'), { code: 'E04' });
  }
  const body = documentXml.slice(
    bodyStart + '<w:body>'.length,
    documentXml.lastIndexOf('</w:body>'),
  );

  const blocks = [];
  const warnings = [];

  for (const child of topLevelChildren(body)) {
    if (child.tag === 'w:p') {
      blocks.push(...parseParagraph(child.xml, ctx));
    } else if (child.tag === 'w:tbl') {
      // 表は「丸ごと運ぶ」。中身を作り直さないので崩れようがない。
      blocks.push({ kind: 'table', xml: child.xml, text: textOf(child.xml).slice(0, 60) });
    } else if (child.tag === 'w:sdt') {
      // コンテンツコントロール（目次など）。中身の段落だけ取り出す。
      const content = firstElement(child.xml, 'w:sdtContent');
      if (content) {
        for (const c2 of topLevelChildren(content)) {
          if (c2.tag === 'w:p') blocks.push(...parseParagraph(c2.xml, ctx));
          else if (c2.tag === 'w:tbl') blocks.push({ kind: 'table', xml: c2.xml, text: '' });
        }
      }
    }
    // w:sectPr / w:bookmarkEnd 等は運ばない（テンプレ側の構成を使うため）
  }

  // --- 画像バイナリを読む ---
  //     文字列で読むと必ず壊れる。uint8array で読むこと。
  for (const b of blocks) {
    if (b.kind !== 'image') continue;
    const entry = zip.file(b.path);
    if (!entry) {
      warnings.push({
        id: 'W27', level: 'warn',
        message: `画像 ${b.path} が原稿ファイルの中に見つかりませんでした。貼り直してください`,
      });
      b.missing = true;
      continue;
    }
    b.bytes = await entry.async('uint8array');
  }

  // --- 運べない図の警告 ---
  const unportable = blocks.filter(b => b.kind === 'drawing');
  if (unportable.length) {
    warnings.push({
      id: 'W14', level: 'warn',
      count: unportable.length,
      message: `Wordの${[...new Set(unportable.map(u => u.variety))].join('・')}で描かれた図が ${unportable.length}件 あります。` +
               `画像（PNG/JPEG）として貼り直してください。図形のままでは移設できません`,
    });
  }

  // --- 数式の警告 ---
  const mathBlocks = blocks.filter(b => b.kind === 'math');

  return {
    blocks,
    numberingXml,
    warnings,
    stats: {
      paragraphs: blocks.filter(b => b.kind === 'paragraph').length,
      tables: blocks.filter(b => b.kind === 'table').length,
      images: blocks.filter(b => b.kind === 'image' && !b.missing).length,
      maths: mathBlocks.length,
      unportable: unportable.length,
      chars: blocks.filter(b => b.kind === 'paragraph').reduce((n, b) => n + b.text.length, 0),
    },
  };
}

/** ブロック列から、チェッカーへ渡す行配列を作る */
export function blocksToLines(blocks) {
  return blocks.map(b => {
    if (b.kind === 'paragraph') return b.text;
    if (b.kind === 'math') return b.text;
    return '';
  });
}
