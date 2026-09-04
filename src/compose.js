/**
 * compose.js — ブロック列 + テンプレのハンコ → word/document.xml
 *
 * 本モジュールの責務は「ハンコを押す」ことだけである。
 *   - 段落の中身（テキスト・表XML・数式XML）は source-parse が運んできたものを使う
 *   - 書式（pPr/rPr）は manifest が持つテンプレ実測値をそのまま貼る
 *   - どちらも「作らない」
 *
 * 唯一の例外が画像の w:drawing で、これは器を組み立てる必要がある。
 * ただし中身（バイナリ）は再エンコードせず運んでいるため、劣化はしない。
 */

import {
  escapeXml, textRun, paragraph, firstElement, allElements, attrOf, withAttr,
  stripInvalidXmlChars,
} from './xml-util.js';
import { detectHeading, formatNumber, applyKintouWariduke } from './heading-detect.js';
import { transferImage, buildInlineDrawingXml, COLUMN_WIDTH } from './image-transfer.js';
import { REFERENCE_MARKER_RE } from './reference-format.js';

/* ============================================================
 * 段落記号の rPr を pPr から剥がす
 *   manifest の pPr には <w:rPr>（段落記号の書式）が同梱されている。
 *   そのまま使って問題ないが、numPr を差し替える等の操作をするので
 *   pPr を組み替えるヘルパを用意する。
 * ========================================================== */

/** pPr の中身だけ取り出す（<w:pPr> ... </w:pPr> の中） */
function pPrInner(pPr) {
  if (!pPr || pPr === '<w:pPr/>') return '';
  const gt = pPr.indexOf('>');
  if (pPr[gt - 1] === '/') return '';
  return pPr.slice(gt + 1, pPr.lastIndexOf('</w:pPr>'));
}

/** pPr に子要素を先頭追加した新しい pPr を返す */
function pPrWith(pPr, extraFirst = '', extraLast = '') {
  const inner = pPrInner(pPr);
  if (!extraFirst && !extraLast && !inner) return '<w:pPr/>';
  return `<w:pPr>${extraFirst}${inner}${extraLast}</w:pPr>`;
}

/* ============================================================
 * 1. 見出し・本文のハンコ押し
 * ========================================================== */

const STAMP_BY_LEVEL = { 1: 'heading1', 2: 'heading2', 3: 'heading3' };

/**
 * 1ブロックを段落XMLへ。
 * @returns {string} <w:p>...</w:p>
 */
function composeParagraph(block, stamps, opts = {}) {
  const { forceStamp = null, headingLevel = null, normalizeNumbers = true } = opts;

  const key = forceStamp
    ?? (headingLevel ? (STAMP_BY_LEVEL[headingLevel] ?? 'heading3') : 'body');
  const stamp = stamps[key] ?? stamps.body;

  let text = block.text;

  // 見出しなら番号表記をテンプレの流儀（"1. " / "2-1. "）へ正規化し、
  // 2文字見出しには均等割付の全角スペースを入れる。
  if (headingLevel && normalizeNumbers && block.heading) {
    text = formatNumber(block.heading.parts) + applyKintouWariduke(block.heading.title);
  } else if (forceStamp === 'headingPlain') {
    text = applyKintouWariduke(text);
  }

  if (!text) return paragraph(stamp.pPr, '');
  return paragraph(stamp.pPr, textRun(stamp.rPr, stripInvalidXmlChars(text)));
}

/* ============================================================
 * 2. 表の運搬
 *    w:tbl は丸ごと運ぶが、幅だけはテンプレの段幅に合わせる。
 *    原稿がA4全幅(9000twips前後)で作った表を2段組へ入れると必ずはみ出すため。
 * ========================================================== */

/**
 * 表の幅を段幅へ収める。
 * 列幅の比率は保ったまま、合計が maxTwips を超える場合だけ縮小する。
 */
export function fitTableWidth(tblXml, maxTwips) {
  const grid = firstElement(tblXml, 'w:tblGrid');
  if (!grid) return { xml: tblXml, scaled: false };

  const cols = allElements(grid, 'w:gridCol');
  const widths = cols.map(c => Number(attrOf(c, 'w:w')) || 0);
  const total = widths.reduce((a, b) => a + b, 0);
  if (!total || total <= maxTwips) return { xml: tblXml, scaled: false, total };

  const ratio = maxTwips / total;
  let out = tblXml;

  // gridCol
  let newGrid = grid;
  cols.forEach((c, i) => {
    newGrid = newGrid.replace(c, withAttr(c, 'w:w', String(Math.floor(widths[i] * ratio))));
  });
  out = out.replace(grid, newGrid);

  // 各セルの tcW も同じ比率で縮める（gridCol だけ直すと Word が食い違いを起こす）
  for (const tcW of allElements(out, 'w:tcW')) {
    if (attrOf(tcW, 'w:type') !== 'dxa') continue;
    const w = Number(attrOf(tcW, 'w:w')) || 0;
    out = out.replace(tcW, withAttr(tcW, 'w:w', String(Math.floor(w * ratio))));
  }

  // 表全体の幅指定
  const tblW = firstElement(out, 'w:tblW');
  if (tblW && attrOf(tblW, 'w:type') === 'dxa' && Number(attrOf(tblW, 'w:w')) > 0) {
    out = out.replace(tblW, withAttr(tblW, 'w:w', String(maxTwips)));
  }

  return { xml: out, scaled: true, total, ratio };
}

/**
 * 表のセル内の文字書式をテンプレのハンコへ揃える。
 *
 * 原稿の表はセルに rPr を持たないことが多く、その場合 docDefaults の
 * Century / ＭＳ明朝 10.5pt が出る。「フォントを揃えたい」という依頼の
 * 取りこぼしになるため、本文と同じ 10pt / Times New Roman + ＭＳ明朝 に揃える。
 *
 * 罫線・セル結合・列幅といった「構造」には一切触れない。触るのは文字書式だけ。
 */
export function stampTableFonts(tblXml, rPr) {
  if (!rPr) return tblXml;

  // 既存の rPr は落として置き換える。太字などの強調は原稿の意図なので残したいが、
  // フォント指定だけ差し替えるより、フォント系の要素を注入するほうが安全。
  const fontEls = (firstElement(rPr, 'w:rFonts') ?? '') +
                  (firstElement(rPr, 'w:sz') ?? '') +
                  (firstElement(rPr, 'w:szCs') ?? '');
  if (!fontEls) return tblXml;

  let out = '';
  let i = 0;
  for (const run of allElements(tblXml, 'w:r')) {
    const at = tblXml.indexOf(run, i);
    out += tblXml.slice(i, at);
    const existing = firstElement(run, 'w:rPr');
    if (existing) {
      // 既存 rPr から古いフォント指定を抜き、テンプレの指定を先頭に入れる
      const cleaned = existing
        .replace(/<w:rFonts\b[^>]*\/>/g, '')
        .replace(/<w:rFonts\b[^>]*>[\s\S]*?<\/w:rFonts>/g, '')
        .replace(/<w:sz\b[^>]*\/>/g, '')
        .replace(/<w:szCs\b[^>]*\/>/g, '')
        .replace('<w:rPr>', `<w:rPr>${fontEls}`);
      out += run.replace(existing, cleaned === '<w:rPr/>' ? `<w:rPr>${fontEls}</w:rPr>` : cleaned);
    } else {
      out += run.replace(/^<w:r(\s[^>]*)?>/, m => `${m}<w:rPr>${fontEls}</w:rPr>`);
    }
    i = at + run.length;
  }
  out += tblXml.slice(i);
  return out;
}

/* ============================================================
 * 3. 図表番号の見つけ方
 * ========================================================== */

const CAPTION_RE = /^\s*(図|表|Fig\.?|Table)\s*([0-9０-９]+)\s*[．.、,:：]?\s*(.*)$/;

export function parseCaption(text) {
  const m = CAPTION_RE.exec(text);
  if (!m) return null;
  const kindRaw = m[1];
  const kind = /図|Fig/.test(kindRaw) ? 'figure' : 'table';
  const num = Number(m[2].replace(/[０-９]/g, d => '０１２３４５６７８９'.indexOf(d)));
  const lang = /^(図|表)$/.test(kindRaw) ? 'ja' : 'en';
  return { kind, num, lang, title: m[3].trim(), raw: text };
}

/* ============================================================
 * 4. 本体
 * ========================================================== */

/**
 * セクション2（本文エリア）の中身を組み立てる。
 *
 * @param {Array} blocks   source-parse のブロック列
 * @param {object} manifest
 * @param {object} ctx     image-transfer の転送コンテキスト
 * @returns {{xml:string, warnings:Array, outline:Array}}
 */
export function composeBody(blocks, manifest, ctx) {
  const { stamps, geometry } = manifest;
  const warnings = [];
  const outline = [];
  const parts = [];
  const tableXmls = [];   // 運んだ表。参照スタイルの取り込みに使う

  const singleTwips = geometry.singleWidthTwips;

  // --- 見出し判定はブロック列全体を見てから行う（文献セクション以降で停止するため）---
  const lines = blocks.map(b => (b.kind === 'paragraph' || b.kind === 'math') ? b.text : '');
  let referenceAt = null;
  lines.forEach((l, i) => {
    if (referenceAt === null && /^[\s\u3000]*(文[\s\u3000]*献|参考文献|References?)[\s\u3000]*$/.test(l)) {
      referenceAt = i;
    }
  });

  const PLAIN_HEADING_RE = /^[\s\u3000]*(文[\s\u3000]*献|参考文献|References?|謝[\s\u3000]*辞|付[\s\u3000]*記|利益相反|著者貢献|補[\s\u3000]*足)[\s\u3000]*$/;

  blocks.forEach((block, i) => {
    switch (block.kind) {

      /* ---------- 段落 ---------- */
      case 'paragraph': {
        if (!block.text) { parts.push(paragraph(stamps.empty.pPr, '')); return; }

        // 参考文献セクションの中身
        if (referenceAt !== null && i > referenceAt) {
          // 先頭の "1) " は numPr の自動採番に任せるので剥がす。
          // ここは「作る」ではなく「重複を外す」処理である。
          // 判定は reference-format.js と共有する。別々に持つと、片方だけ
          // 広げたときに「自動番号 + 手打ち番号」の二重になる。
          const stripped = block.text.replace(REFERENCE_MARKER_RE, '');
          parts.push(paragraph(stamps.reference.pPr, textRun(stamps.reference.rPr, stripped)));
          return;
        }

        // 番号なし見出し（文献・謝辞・利益相反 …）
        if (PLAIN_HEADING_RE.test(block.text)) {
          parts.push(composeParagraph(block, stamps, { forceStamp: 'headingPlain' }));
          outline.push({ index: i, level: 0, text: block.text.trim(), kind: 'plain' });
          return;
        }

        // 番号付き見出し
        const h = (referenceAt === null || i < referenceAt) ? detectHeading(block.text) : { isHeading: false };
        if (h.isHeading) {
          const b2 = { ...block, heading: h };
          parts.push(composeParagraph(b2, stamps, { headingLevel: h.level }));
          outline.push({ index: i, level: h.level, number: h.number, text: h.title, confidence: h.confidence });
          return;
        }

        // 図表キャプション
        const cap = parseCaption(block.text);
        if (cap) {
          parts.push(composeParagraph(block, stamps, { forceStamp: 'caption' }));
          return;
        }

        // 箇条書き（「・」「-」で始まる行）は字下げを外した本文として運ぶ。
        // 番号を振り直すと原稿の意図（本文からの参照）を壊すため、記号は残す。
        if (/^[\s\u3000]*[・･\-—–●○◆■]\s?/.test(block.text)) {
          parts.push(paragraph(pPrWith('<w:pPr/>'), textRun(stamps.body.rPr, block.text)));
          return;
        }

        parts.push(composeParagraph(block, stamps));
        return;
      }

      /* ---------- 表 ---------- */
      case 'table': {
        const fit = fitTableWidth(block.xml, singleTwips);
        if (fit.scaled) {
          warnings.push({
            id: 'W28', level: 'info',
            message: `表の幅が段幅を超えていたため ${Math.round(fit.ratio * 100)}% に縮小しました（${fit.total} → ${singleTwips} twips）。` +
                     `段抜きにしたい場合は出力後に手動で調整してください`,
          });
        }
        // 表の前後には空段落が要る。
        // 直前が段落でない（表が連続する / 先頭）場合、Word は表を結合してしまう。
        const prev = parts[parts.length - 1];
        if (!prev || prev.startsWith('<w:tbl')) parts.push(paragraph(stamps.empty.pPr, ''));

        parts.push(stampTableFonts(fit.xml, stamps.body.rPr));
        tableXmls.push(block.xml);   // 参照スタイルの取り込み判定に使う

        // 表の直後の空段落は必須（無いと後続の表と結合される）
        parts.push(paragraph(stamps.empty.pPr, ''));
        return;
      }

      /* ---------- 数式 ---------- */
      case 'math': {
        // m:oMath を丸ごと運ぶ。中身には一切触れない。
        parts.push(paragraph('<w:pPr><w:jc w:val="center"/></w:pPr>', block.xml));
        return;
      }

      /* ---------- 画像 ---------- */
      case 'image': {
        if (block.missing || !block.bytes) return;
        const placed = transferImage(ctx, {
          bytes: block.bytes,
          srcExtent: block.srcExtent,
          width: block.width ?? 'single',
          name: block.name || `図（${i + 1}番目のブロック）`,
        });
        if (!placed) return;
        // w:drawing は段落直下には置けない。必ず w:r で包む。
        // noProof を付けないと Word がスペルチェック対象とみなして赤波線を引く。
        parts.push(paragraph(
          '<w:pPr><w:jc w:val="center"/></w:pPr>',
          `<w:r><w:rPr><w:noProof/></w:rPr>` +
          buildInlineDrawingXml({
            rId: placed.rId, docPrId: placed.docPrId,
            cx: placed.cx, cy: placed.cy,
            name: block.name || `image${placed.docPrId}`,
          }) +
          `</w:r>`,
        ));
        return;
      }

      /* ---------- 運べない図 ---------- */
      case 'drawing': {
        // プレースホルダを置く。黙って消すと、あとで「図が消えた」と言われる。
        parts.push(paragraph(
          '<w:pPr><w:jc w:val="center"/></w:pPr>',
          textRun(stamps.body.rPr, `［ここに ${block.variety} で描かれた図がありました。画像として貼り直してください］`),
        ));
        return;
      }

      default:
        return;
    }
  });

  return { xml: parts.join(''), warnings, outline, tableXmls };
}

/* ============================================================
 * 5. セクション1（表題・抄録エリア）
 * ========================================================== */

/**
 * 英文見出し行を組み立てる。
 * 「■技術報告■ <tab><tab> <Technical report> English Title, by A & B」という構造。
 * タブ位置 4820 twips でテンプレが左右に振り分けている。
 */
function composeEnglishHead(meta, slot) {
  const rPrJa = '<w:rPr><w:rFonts w:ascii="ＭＳ ゴシック" w:eastAsia="ＭＳ ゴシック" w:hAnsi="ＭＳ ゴシック" w:hint="eastAsia"/></w:rPr>';
  const rPrEn = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';
  const rPrTitle = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';

  const authors = (meta.englishAuthors ?? []).join(' & ');
  const inner =
    `<w:r>${rPrJa}<w:t>■技術報告■</w:t></w:r>` +
    `<w:r>${rPrEn}<w:tab/><w:tab/></w:r>` +
    `<w:r>${rPrEn}<w:t xml:space="preserve">&lt;Technical report&gt; </w:t></w:r>` +
    `<w:r>${rPrTitle}<w:t xml:space="preserve">${escapeXml(meta.englishTitle ?? '')}</w:t></w:r>` +
    (authors ? `<w:r>${rPrEn}<w:t xml:space="preserve">, by ${escapeXml(authors)}</w:t></w:r>` : '');
  return paragraph(slot.pPr, inner);
}

/**
 * @param {object} meta フォーム入力
 * @param {object} manifest
 */
export function composeSection1(meta, manifest) {
  const slots = manifest.sections.section1.slots;
  const parts = [];

  for (const slot of slots) {
    if (slot.keep === 'raw') { parts.push(slot.raw); continue; }

    switch (slot.field) {
      case 'englishHead':
        parts.push(composeEnglishHead(meta, slot));
        break;

      case 'japaneseTitle': {
        // 所属の脚注番号は上付き・非太字。タイトル本体とは別 run にする。
        const rPrSup = slot.rPr.replace('</w:rPr>', '<w:vertAlign w:val="superscript"/></w:rPr>')
                               .replace('<w:b/>', '');
        parts.push(paragraph(
          slot.pPr,
          textRun(slot.rPr, meta.japaneseTitle ?? '') +
          (meta.titleFootnote ? textRun(rPrSup, String(meta.titleFootnote)) : ''),
        ));
        break;
      }

      case 'japaneseAuthors': {
        const rPrSup = slot.rPr.replace('</w:rPr>', '<w:vertAlign w:val="superscript"/></w:rPr>');
        const list = meta.japaneseAuthors ?? [];
        const inner = list.map((a, i) => {
          const name = typeof a === 'string' ? a : a.name;
          const mark = typeof a === 'string' ? '' : (a.affiliation ?? '');
          return (i ? textRun(slot.rPr, '，') : '') +
                 textRun(slot.rPr, name) +
                 (mark ? textRun(rPrSup, String(mark)) : '');
        }).join('');
        parts.push(paragraph(slot.pPr, inner));
        break;
      }

      case 'englishAbstract':
        parts.push(paragraph(slot.pPr, textRun(slot.rPr, meta.englishAbstract ?? '')));
        break;

      case 'japaneseAbstract':
        parts.push(paragraph(slot.pPr, textRun(slot.rPr, meta.japaneseAbstract ?? '')));
        break;

      case 'keywords': {
        const kw = (meta.keywords ?? []).join('，');
        parts.push(paragraph(slot.pPr, textRun(slot.rPr, `（キーワード：\u3000${kw}）`)));
        break;
      }

      default:
        parts.push(slot.raw ?? paragraph(slot.pPr, ''));
    }
  }

  return parts.join('');
}

/* ============================================================
 * 6. 所属テキストボックス
 * ========================================================== */

/**
 * 所属ブロックのテキストを差し替える。
 *
 * mc:Choice と mc:Fallback に同じ内容が二重に存在するため、
 * txbxContent を「すべて」置き換える必要がある。
 * 片方だけ直すと、Word 2007 で開いたときに古い所属が出る。
 */
export function replaceAffiliation(runXml, meta, geometry = null) {
  const lines = [];
  if (meta.received) lines.push({ mark: '', text: meta.received });
  for (const aff of meta.affiliations ?? []) {
    lines.push({ mark: String(aff.mark ?? ''), text: aff.text ?? '' });
  }
  if (!lines.length) return runXml;

  const rPr = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="ＭＳ Ｐ明朝" w:hAnsi="Times New Roman"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>';
  const rPrSup = rPr.replace('</w:rPr>', '<w:vertAlign w:val="superscript"/></w:rPr>');
  const pPr = '<w:pPr><w:tabs><w:tab w:val="left" w:pos="284"/></w:tabs><w:snapToGrid w:val="0"/></w:pPr>';

  const content = lines.map(l =>
    paragraph(pPr,
      (l.mark ? `<w:r>${rPrSup}<w:t>${escapeXml(l.mark)}</w:t></w:r><w:r>${rPr}<w:tab/></w:r>` : '') +
      textRun(rPr, l.text)),
  ).join('');

  // txbxContent を全部（Choice と Fallback の両方）差し替える
  let out = runXml.replace(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g,
    () => `<w:txbxContent>${content}</w:txbxContent>`);

  out = anchorToPageBottom(out, geometry);

  return out;
}

/**
 * 所属ブロックを「1ページ目の本文エリア下端」に固定する。
 *
 * テンプレの元の指定は positionV relativeFrom="paragraph" posOffset="379730"、
 * つまり「アンカー段落の10.5mm下」である。テンプレでは本文4段落目に
 * アンカーされているため結果的にページ下端に落ちるが、
 * 原稿を差し替えると本文の長さが変わり、所属が本文の途中に浮いてしまう。
 *
 * 所属は脚注の役割を持つ以上、置き場所は「ページ下端」であるべきなので、
 * ページ基準の絶対座標へ付け替えて本文の長さから独立させる。
 *
 * bottomMargin 基準は使わない。Word は解釈するが LibreOffice は
 * 図形グループの子要素を取りこぼし、テキストが消える（実測）。
 * page 基準は両者とも確実に解釈する。
 *
 * 箱の高さ（wp:extent/@cy）は書き換えない。
 * これはグループ図形の外形であって行数から決まる値ではなく、
 * 勝手に変えると中の区切り線と枠がずれる。
 */
function anchorToPageBottom(runXml, geometry) {
  const EMU_PER_TWIP = 635;
  const anchor = firstElement(runXml, 'wp:anchor');
  const extent = anchor ? firstElement(anchor, 'wp:extent') : null;
  const cy = extent ? Number(attrOf(extent, 'cy')) : 0;
  if (!cy || !geometry) return runXml;

  const pageH = geometry.pageHeightTwips * EMU_PER_TWIP;
  const marginB = geometry.marginTwips.bottom * EMU_PER_TWIP;
  const top = Math.max(0, pageH - marginB - cy);

  // DrawingML 側（Word 2010+）
  let out = runXml.replace(
    /<wp:positionV relativeFrom="[^"]*">[\s\S]*?<\/wp:positionV>/,
    `<wp:positionV relativeFrom="page"><wp:posOffset>${top}</wp:posOffset></wp:positionV>`,
  );

  // VML 側（mc:Fallback / Word 2007）。位置は style 属性の中に文字列で入っている。
  // 片方だけ直すと、古い Word で開いたときだけ位置がずれる。
  //
  // 注意: テンプレの VML には mso-position-vertical-relative が「そもそも無い」。
  // 既定は text（段落基準）なので、置換ではなく挿入しないと効かない。
  const topPt = (top / 12700).toFixed(2);
  out = out.replace(/style="([^"]*)"/g, (whole, style) => {
    if (!/position:absolute/.test(style)) return whole;
    let s = style;
    s = /margin-top:\s*-?[\d.]+pt/.test(s)
      ? s.replace(/margin-top:\s*-?[\d.]+pt/, `margin-top:${topPt}pt`)
      : `${s};margin-top:${topPt}pt`;
    s = /mso-position-vertical-relative:/.test(s)
      ? s.replace(/mso-position-vertical-relative:\s*[a-z-]+/, 'mso-position-vertical-relative:page')
      : `${s};mso-position-vertical-relative:page`;
    if (!/mso-position-vertical:/.test(s)) s = `${s};mso-position-vertical:absolute`;
    return `style="${s}"`;
  });

  return out;
}

/* ============================================================
 * 7. document.xml の組み立て
 * ========================================================== */

export function buildDocumentXml({ manifest, section1Xml, section2Xml }) {
  const { rootOpen, afterBody } = manifest.document;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    rootOpen +
    '<w:body>' + section1Xml + section2Xml + manifest.sections.section2.sectPr + '</w:body>' +
    afterBody;
}
