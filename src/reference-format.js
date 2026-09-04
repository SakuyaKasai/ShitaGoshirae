/**
 * reference-format.js — 参考文献の組み立てと、既存文字列からの取り出し
 *
 *   書式定義そのものは manifest.references に入っている（tools/reference-types.mjs の生成物）。
 *   このモジュールは「定義を使って組み立てる」「既存の1行から拾えるものだけ拾う」を担う。
 *
 * ------------------------------------------------------------------
 * 方針: 推測で分割しない
 * ------------------------------------------------------------------
 *   parseReference() は 著者名・論文名・誌名を切り分けない。
 *   区切り記号で機械的に分けることは可能だが、整形が要る原稿は
 *   そもそも区切りが規定どおりでないため、当たる保証がない。
 *
 *   外した推測は「空欄」より質が悪い。空欄なら人は埋めるが、
 *   それらしい誤りはラベル付きの箱に収まって見逃される。
 *
 *   したがって拾うのは、書式そのものが判別根拠になるものだけ:
 *     DOI / URL / 出版年 / 巻(号) / ページ / 参照日
 *   残りは rest として丸ごと返し、UI 側でドラッグ選択して各欄へ送り込ませる。
 *   切るのは人間、運ぶのがアプリ。
 *
 * ------------------------------------------------------------------
 * 組み立てモデル（tools/reference-types.mjs の説明と対）
 * ------------------------------------------------------------------
 *   1フィールドの出力 = prefix + 値 + suffix
 *   値が空ならフィールドごと消える（区切りも残らない）。required でも同じ。
 *   出力に ［出版者］ のような穴埋め記号は入れない。
 *
 *   区切りは「直前に出力されたフィールドの follow」を使い、
 *   後続側が lead を持つ場合はそちらが優先される。
 *   末尾に type.terminal を付ける。ただし最後のフィールドが
 *   suppressTerminal を持つ場合は付けない（URL の直後を避ける）。
 */

/* ================================================================
 * 1. 組み立て
 * ================================================================ */

/** 値の末尾に付いた区切り記号を落とす。
 *  半角ピリオドは落とさない — "1st ed." "et al." "J." のように
 *  略記や頭文字の一部であることが多く、機械的に区別できないため。
 *  テンプレ例示も "1st ed., Ergonomics Press" と両方を並べている。 */
const trimTail = (v, keep) => keep ? v : v.replace(/[．，、。,;；\s\u3000]+$/, '');

/** prefix を二重に付けない（DOI を URL ごと貼られた場合） */
const applyPrefix = (prefix, v) => (!prefix || v.startsWith(prefix)) ? v : prefix + v;

/** 半角の記号で終わっているか（この直後に全角の区切りが来ると重なる） */
const HALF_TAIL = /[.,;:]$/;

/**
 * フィールド値から規定準拠の1行を組み立てる。
 *
 * @param {object} type        manifest.references.types[] の1件
 * @param {object} delimiters  manifest.references.delimiters
 * @param {object} values      { fieldKey: string }
 * @returns {{ text: string, notices: Notice[] }}
 *
 * Notice = {
 *   id: 'R01'|'R02', level: 'warn'|'info',
 *   field, fieldLabel, message, suggestion,
 *   at?, length?, excerpt?     ← R02 のみ。text 内の位置。UI はここを光らせる
 * }
 */
export function formatReference(type, delimiters, values) {
  const emitted = [];
  const notices = [];

  for (const f of type.fields) {
    const raw = String(values?.[f.key] ?? '').trim();
    if (!raw) {
      // 空欄はフィールドごと消す。穴埋め記号は出さない。
      if (f.required) {
        notices.push({
          id: 'R01', level: 'warn', field: f.key, fieldLabel: f.label,
          message: `${f.label}が未入力です`,
          suggestion: '規定ではこの型に必要な項目です。原著をご確認ください',
        });
      }
      continue;
    }
    const isUrl = f.autofill === 'url' || f.autofill === 'doi';
    emitted.push({
      f,
      text: applyPrefix(f.prefix ?? '', trimTail(raw, isUrl)) + (f.suffix ?? ''),
    });
  }
  if (!emitted.length) return { text: '', notices };

  let text = emitted[0].text;
  for (let i = 1; i < emitted.length; i++) {
    const key = emitted[i].f.lead ?? emitted[i - 1].f.follow;
    const delim = delimiters[key] ?? '';
    pushCollision(notices, emitted[i - 1].f, text, delim, emitted[i].text);
    text += delim + emitted[i].text;
  }

  const last = emitted[emitted.length - 1].f;
  if (!last.suppressTerminal && type.terminal) {
    const delim = delimiters[type.terminal] ?? '';
    pushCollision(notices, last, text, delim, '');
    text += delim;
  }
  return { text, notices };
}

/** 半角記号の直後に全角の区切りが来る場合を、位置つきで報告する。
 *  文章で場所を説明せず、UI がプレビュー中の該当2文字を光らせる。 */
function pushCollision(notices, field, textSoFar, delim, nextText) {
  if (!delim || !HALF_TAIL.test(textSoFar)) return;
  const tail = textSoFar.slice(-1);
  const at = textSoFar.length - 1;
  notices.push({
    id: 'R02', level: 'info', field: field.key, fieldLabel: field.label,
    at, length: 2,
    excerpt: textSoFar.slice(Math.max(0, at - 8)) + delim + nextText.slice(0, 8),
    message: `${field.label}の末尾の「${tail}」と、区切りの「${delim}」が並んでいます`,
    suggestion: `${field.label}の末尾から「${tail}」を消すと「${tail}${delim}」が「${delim}」になります`,
  });
}

/* ================================================================
 * 2. 高信頼フィールドの取り出し
 * ================================================================
 *   書式そのものが判別根拠になるものだけを拾う。
 *   拾えたぶんは元の文字列から取り除き、残りを rest として返す。
 *   取り除く順序は「長く特徴的なもの → 短いもの」。
 *   先に出版年を取ると DOI の中の数字やページ範囲を壊すため。
 */

/**
 * 行頭の文献番号（`1) ` `2．` `3.` など）。
 *
 * **`compose.js` が剥がすのと同じ形でなければならない。** 出力時、文献段落は
 * テンプレの `numId=17` で自動採番されるため、compose は手打ちの番号を剥がす。
 * ここで別の形（`[1]` など）まで番号扱いすると、compose が剥がせずに
 * 「自動番号 + 手打ち番号」の二重になる。広げるときは両方そろえること。
 */
export const REFERENCE_MARKER_RE = /^\s*[0-9０-９]+\s*[)）.．]\s*/;

/**
 * 行頭の文献番号を切り離す。
 * @returns {{ marker: string, body: string }} marker は原文のまま（付け直しに使う）
 */
export function splitMarker(line) {
  const s = String(line ?? '');
  const m = REFERENCE_MARKER_RE.exec(s);
  return m ? { marker: m[0].trimEnd() + ' ', body: s.slice(m[0].length) }
           : { marker: '', body: s };
}

/** https://doi.org/10.xxxx/... または 素の 10.xxxx/... */
const RE_DOI = /(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s，,、。．]+)/i;
/** doi.org 以外の URL */
const RE_URL = /https?:\/\/[^\s，,、。]+/i;
/** (参照 2021-04-01) / (参照2021-04-01) / (accessed 2021-04-01) */
const RE_ACCESS = /[(（]\s*(?:参照|accessed)\s*[:：]?\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*[)）]/i;
/** 50(1) / 50 (1) / 第50巻第1号 */
const RE_VOLUME = /(\d{1,4})\s*[(（]\s*(\d{1,4})\s*[)）]/;
const RE_VOLUME_JA = /第\s*(\d{1,4})\s*巻\s*(?:第\s*(\d{1,4})\s*号)?/;
/** p. 1-10 / pp.1–10 / p.S8-S9 */
const RE_PAGES = /p{1,2}\s*[.．]?\s*([A-Za-z]?\d+)\s*[-–—~〜]\s*([A-Za-z]?\d+)/i;
/** p. を伴わない 45-52。区切りに挟まれた数字範囲のときだけ。
 *  会議開催期間 2014-06-05/06 を拾わないよう、桁数と直後の形を絞る。 */
const RE_PAGES_BARE = /(?<=[，,、．.\s]|^)(\d{1,5})\s*[-–—~〜]\s*(\d{1,5})(?=[，,、．.\s]|$)/;
/** 139p. / 200 p */
const RE_TOTAL_PAGES = /(\d{1,5})\s*p[.．]?(?=\s|$|[，,、。．])/i;
/** 1900-2099 の4桁。前後が数字やハイフンでないもの */
const RE_YEAR = /(?<![\d-])((?:19|20)\d{2})(?![\d-])/;
/** 2014-06-05/06 のような会議開催期間 */
const RE_PERIOD = /((?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s*\/\s*\d{1,2}(?:[-/.]\d{1,2})?)/;
/** ISO 9241-210:2010 / JIS Z 8530:2019 */
const RE_STANDARD = /^\s*((?:ISO|IEC|JIS|ANSI|EN|DIN)[\s\/A-Z]*[\d][\d\-.:\s]*?)[:：]\s*((?:19|20)\d{2})/i;

/**
 * 1行から拾えるものだけ拾う。著者名・論文名・誌名は切り分けない。
 *
 * @param {string} line
 * @returns {{ fields: object, rest: string, found: string[] }}
 *   fields …… 拾えた高信頼フィールド
 *   rest   …… 拾ったぶんを取り除いた残り。UI がここをドラッグ対象として見せる
 *   found  …… 拾えたフィールド名。UI が「自動で入れました」と示すため
 */
export function extractFields(line) {
  let s = String(line ?? '');
  const fields = {};
  const found = [];

  const take = (re, handler) => {
    const m = re.exec(s);
    if (!m) return;
    if (handler(m) === false) return;
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length));
  };

  // 規格は行頭の形が決定的なので最初に見る
  take(RE_STANDARD, m => {
    fields.standardNo = m[1].trim().replace(/[\s]+$/, '');
    fields.year = m[2];
    found.push('standardNo', 'year');
  });

  take(RE_ACCESS, m => { fields.accessDate = normalizeDate(m[1]); found.push('accessDate'); });
  take(RE_PERIOD, m => { fields.period = m[1].replace(/\s+/g, ''); found.push('period'); });
  take(RE_DOI,    m => { fields.doi = m[1].replace(/[.．。]+$/, ''); found.push('doi'); });
  take(RE_URL,    m => { fields.url = m[0].replace(/[.．。，,]+$/, ''); found.push('url'); });

  take(RE_PAGES, m => { fields.pages = `${m[1]}-${m[2]}`; found.push('pages'); });
  take(RE_TOTAL_PAGES, m => { fields.totalPages = m[1]; found.push('totalPages'); });
  if (!fields.pages) {
    take(RE_PAGES_BARE, m => { fields.pages = `${m[1]}-${m[2]}`; found.push('pages'); });
  }

  if (!fields.volume) {
    take(RE_VOLUME, m => { fields.volume = `${m[1]}(${m[2]})`; found.push('volume'); });
  }
  if (!fields.volume) {
    take(RE_VOLUME_JA, m => {
      fields.volume = m[2] ? `${m[1]}(${m[2]})` : m[1];
      found.push('volume');
    });
  }

  if (!fields.year) {
    take(RE_YEAR, m => { fields.year = m[1]; found.push('year'); });
  }

  // 抜いた跡に残った「，  ，  .」のような区切りだけの並びを畳む。
  // ドラッグ選択の対象として見せるので、読めない残骸は邪魔になる。
  const rest = s
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:[，,、．.;；:：]\s*){2,}/g, ' ')
    .replace(/\s*[，,、．.;；:：]\s*$/, '')
    .replace(/^\s*[，,、．.;；:：]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { fields, rest, found };
}

/** 2021/4/1 や 2021.4.1 を 2021-04-01 に揃える */
function normalizeDate(v) {
  const p = v.split(/[-/.]/);
  if (p.length !== 3) return v;
  return `${p[0]}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')}`;
}

/* ================================================================
 * 3. 種別の推定
 * ================================================================
 *   外してもプルダウン1回で直せるので、積極的に当てにいってよい領域。
 *   ただし根拠のない推定はしない。手がかりが無ければ null を返し、
 *   UI は「種別を選んでください」と出す。
 */

/**
 * @returns {{ id: string|null, confidence: 'high'|'medium'|'low', reason: string }}
 */
export function guessType(line) {
  const s = String(line ?? '');
  const has = re => re.test(s);

  if (RE_STANDARD.test(s)) {
    return { id: 'standard', confidence: 'high', reason: '行頭が規格番号の形（ISO/JIS等）です' };
  }
  if (has(RE_ACCESS) || (has(RE_URL) && !has(RE_DOI))) {
    return { id: 'online', confidence: 'high', reason: '入手先URLまたは参照日があります' };
  }
  if (has(RE_PERIOD)) {
    return { id: 'proceedings', confidence: 'medium', reason: '会議開催期間らしい日付範囲があります' };
  }
  if (has(/[“"”].+[”"“]/) && has(/(会議|Proceedings|Congress|Conference|講演|大会)/i)) {
    return { id: 'proceedings', confidence: 'medium', reason: '引用符と会議名らしい語があります' };
  }
  if (has(RE_TOTAL_PAGES) && !has(RE_PAGES)) {
    return { id: 'book', confidence: 'medium', reason: '総ページ数の表記（139p. など）があります' };
  }
  if (has(/[“"”].+[”"“]/) && has(/(編|eds?\.|editor)/i)) {
    return { id: 'bookChapter', confidence: 'medium', reason: '引用符と編者らしい語があります' };
  }
  if (has(RE_VOLUME) || has(RE_VOLUME_JA)) {
    return { id: 'journal', confidence: 'medium', reason: '巻(号)の表記があります' };
  }
  if (has(RE_PAGES) && has(RE_YEAR)) {
    return { id: 'journal', confidence: 'low', reason: 'ページと出版年がありますが、決め手はありません' };
  }
  return { id: null, confidence: 'low', reason: '手がかりが見つかりませんでした' };
}

/* ================================================================
 * 4. 入り口
 * ================================================================ */

/**
 * ガイド編集モーダルを開くときの初期状態を作る。
 *
 * @param {string} line              既存の参考文献1行（番号は含まない）
 * @param {object} references        manifest.references
 * @param {string} [forcedTypeId]    ユーザーが種別を選び直した場合
 * @returns {{
 *   typeId, confidence, reason,
 *   fields, rest, found,
 *   original
 * }}
 *   rest は「まだどのフィールドにも割り当てられていない文字列」。
 *   UI はこれを選択可能なテキストとして見せ、ドラッグ→ボタンで各欄へ送り込む。
 */
export function prepareGuide(line, references, forcedTypeId) {
  const original = String(line ?? '').trim();

  // 行頭の文献番号は「運ぶ」もので、整形の対象ではない。
  // ここで外しておかないと「残り」に居座り、利用者が毎回よけることになる。
  // 組み立て後に marker を付け直す（→ reference-guide.js）。
  const { marker, body } = splitMarker(original);

  const guess = forcedTypeId
    ? { id: forcedTypeId, confidence: 'high', reason: '種別を選択しました' }
    : guessType(body);

  const { fields, rest, found } = extractFields(body);

  // 選ばれた型に無いフィールドは持ち越さない
  const type = references?.types?.find(t => t.id === guess.id);
  const kept = {};
  if (type) {
    for (const f of type.fields) if (fields[f.key] != null) kept[f.key] = fields[f.key];
  }

  return {
    typeId: guess.id,
    confidence: guess.confidence,
    reason: guess.reason,
    fields: type ? kept : fields,
    rest,
    found: type ? found.filter(k => type.fields.some(f => f.key === k)) : found,
    marker,     // 行頭の文献番号（`2) `）。無ければ空文字
    original,   // marker を含む原文
  };
}

/** UI から呼ぶ薄いラッパ。manifest を渡すだけで組み立てられるようにする。 */
export function buildReference(references, typeId, values) {
  const type = references?.types?.find(t => t.id === typeId);
  if (!type) return { text: '', notices: [] };
  return formatReference(type, references.delimiters, values);
}
