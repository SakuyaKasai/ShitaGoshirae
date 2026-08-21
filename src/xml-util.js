/**
 * xml-util.js — OOXML を文字列のまま安全に扱うための最小限の道具箱。
 *
 * なぜ DOMParser を使わないのか:
 *   1. ブラウザの XMLSerializer は名前空間宣言を勝手に付け直す。
 *      mc:AlternateContent を含む run を再直列化すると Word が開けなくなることがある。
 *   2. 原稿の w:tbl / m:oMath / w:drawing は「一字一句そのまま運ぶ」のが本設計の原則。
 *      パースして組み直した時点で「運んだ」ではなく「作った」になる。
 *   3. Node とブラウザで同じコードを動かしたい（テストのため）。
 *
 * したがって、切り出しは文字列走査、書き換えは対象を限定した置換で行う。
 */

/* ============================================================
 * タグ走査
 * ========================================================== */

/**
 * 開始位置 `from` にある要素の終端インデックス（`>` の次）を返す。
 * 同名タグの入れ子と自己終了タグを正しく扱う。
 *
 * @param {string} xml
 * @param {number} from `<` の位置
 * @returns {number} 要素直後のインデックス
 */
export function elementEnd(xml, from) {
  const m = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(from, from + 64));
  if (!m) throw new Error(`XML: 位置${from}は要素の開始ではありません`);
  const tag = m[1];

  const open = xml.indexOf('>', from);
  if (open === -1) throw new Error(`XML: <${tag}> が閉じていません`);
  if (xml[open - 1] === '/') return open + 1;          // 自己終了

  let depth = 1;
  let i = open + 1;
  const re = new RegExp(`</?${escapeRe(tag)}(?=[\\s>/])`, 'g');
  re.lastIndex = i;

  for (let m2; (m2 = re.exec(xml)) !== null; ) {
    const gt = xml.indexOf('>', m2.index);
    if (gt === -1) break;
    if (xml[m2.index + 1] === '/') {
      if (--depth === 0) return gt + 1;
    } else if (xml[gt - 1] !== '/') {
      depth++;
    }
    re.lastIndex = gt + 1;
  }
  throw new Error(`XML: </${tag}> が見つかりません`);
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 文字列の直下にある要素を順に切り出す。
 * body 直下の w:p / w:tbl / w:sectPr を列挙するのに使う。
 *
 * @param {string} xml
 * @returns {Array<{tag:string, start:number, end:number, xml:string}>}
 */
export function topLevelChildren(xml) {
  const out = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    // コメント・処理命令は読み飛ばす
    if (xml.startsWith('<!--', lt)) { i = xml.indexOf('-->', lt) + 3; continue; }
    if (xml.startsWith('<?', lt)) { i = xml.indexOf('?>', lt) + 2; continue; }
    const m = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(lt, lt + 64));
    if (!m) { i = lt + 1; continue; }
    const end = elementEnd(xml, lt);
    out.push({ tag: m[1], start: lt, end, xml: xml.slice(lt, end) });
    i = end;
  }
  return out;
}

/**
 * xml の中から最初に現れる `tag` 要素を丸ごと返す（入れ子対応）。
 * @returns {string|null}
 */
export function firstElement(xml, tag) {
  const re = new RegExp(`<${escapeRe(tag)}(?=[\\s>/])`);
  const m = re.exec(xml);
  if (!m) return null;
  return xml.slice(m.index, elementEnd(xml, m.index));
}

/** xml の中の `tag` 要素をすべて返す（入れ子の外側のみ） */
export function allElements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${escapeRe(tag)}(?=[\\s>/])`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const end = elementEnd(xml, m.index);
    out.push(xml.slice(m.index, end));
    re.lastIndex = end;
  }
  return out;
}

/** 要素の中身（開始タグと終了タグの間）を返す。自己終了なら空文字 */
export function innerXml(element) {
  const open = element.indexOf('>');
  if (open === -1) return '';
  if (element[open - 1] === '/') return '';
  return element.slice(open + 1, element.lastIndexOf('<'));
}

/** 属性値を取り出す。無ければ null */
export function attrOf(element, name) {
  if (!element) return null;
  const open = element.slice(0, element.indexOf('>') + 1);
  const m = new RegExp(`\\s${escapeRe(name)}="([^"]*)"`).exec(open);
  return m ? m[1] : null;
}

/** 属性を設定した要素を返す（開始タグのみ書き換え） */
export function withAttr(element, name, value) {
  const gt = element.indexOf('>');
  let open = element.slice(0, gt);
  const re = new RegExp(`\\s${escapeRe(name)}="[^"]*"`);
  open = re.test(open)
    ? open.replace(re, ` ${name}="${escapeXml(value)}"`)
    : `${open} ${name}="${escapeXml(value)}"`;
  return open + element.slice(gt);
}

/* ============================================================
 * テキスト
 * ========================================================== */

/**
 * w:t / w:delText を連結して段落のプレーンテキストを得る。
 * w:tab は全角スペース、w:br は改行とみなす。
 */
export function textOf(xml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:noBreakHyphen\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else if (m[0] === '<w:br/>') out += '\n';
    else out += '-';
  }
  return out;
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * w:t を組み立てる。前後の空白を保持するため xml:space="preserve" を常に付ける。
 * OOXML は既定で空白を畳むため、これが無いと「図 1」の空白が消える。
 */
export function textRun(rPr, text) {
  return `<w:r>${rPr ?? ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** 段落を組み立てる */
export function paragraph(pPr, inner) {
  return `<w:p>${pPr ?? ''}${inner}</w:p>`;
}

/* ============================================================
 * 制御文字の除去
 * ========================================================== */

/**
 * XML 1.0 で許されない制御文字を落とす。
 * Googleドキュメント由来の原稿に 0x0B（垂直タブ）が混ざることがあり、
 * これが1文字あるだけで Word は「読み取り不能」と言って開かない。
 */
export function stripInvalidXmlChars(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}
