/**
 * extract-meta.js — 原稿の冒頭から表題・著者・抄録・キーワードを推定する。
 *
 * 方針（handoff 8章）:
 *   最終的な入力はフォームである。ここでやるのは「候補のプリセット」であって
 *   自動確定ではない。空欄を埋めるより、間違いを直すほうが速いから推定する。
 *
 * 決め手は4つ: ASCII比率 / 文字数 / 出現順序 / アンカー文字列。
 *
 * この案件の面白いところは **規定そのものが判定器になる** ことである。
 * 「英文氏名は姓のみ全て大文字」という規定があるおかげで、
 * `Yuri AOKI` から姓を機械的に取り出せる。
 */

const asciiRatio = s => (s.length
  ? [...s].filter(ch => ch.charCodeAt(0) < 128).length / s.length
  : 0);

const wordCount = s => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** 本文の開始位置＝最初の番号付き見出し。ここより前がセクション1の材料 */
const NUMBERED_HEADING = /^[\s\u3000]*[0-9０-９]+\s*[.．\-－]/;

/** 所属らしさ */
const AFFILIATION_HINT = /大学|学部|学院|研究所|研究科|株式会社|有限会社|センター|病院|機構|College|University|Institute|School|Faculty|Laboratory|Inc\.|Ltd\./;

/**
 * @param {string[]} lines 原稿の行（ブロック列から起こしたもの）
 * @returns {{meta:object, confidence:object, bodyStart:number}}
 */
export function extractMeta(lines) {
  const meta = {};
  const confidence = {};

  /* ---------- 本文の開始位置 ---------- */
  // 「文献」より前にある最初の番号付き見出しを本文の頭とみなす。
  // 見つからなければ、キーワード行の次の行から本文とする。
  let bodyStart = lines.findIndex(l => NUMBERED_HEADING.test(l) && l.trim().length > 3);
  if (bodyStart === -1) bodyStart = 0;

  const head = lines.slice(0, bodyStart > 0 ? bodyStart : Math.min(lines.length, 40));

  /* ---------- キーワード（最も確実） ---------- */
  const kwIndex = head.findIndex(l => /キーワード|Keywords?/i.test(l));
  if (kwIndex !== -1) {
    const m = /(?:キーワード|Keywords?)\s*[：:]\s*(.+?)[）)]?\s*$/i.exec(head[kwIndex]);
    if (m) {
      meta.keywords = m[1].split(/[，,、]/).map(s => s.trim()).filter(Boolean);
      confidence.keywords = 'high';
    }
  }

  /* ---------- 英文タイトル・著者名 ---------- */
  // アンカーは ", by "。テンプレの見本がこの形なので、
  // 見本を上書きして書いた原稿なら必ず残っている。
  const byIndex = head.findIndex(l => /,\s*by\s/i.test(l) && asciiRatio(l) > 0.6);
  if (byIndex !== -1) {
    const line = head[byIndex]
      .replace(/^.*?<\s*Technical report\s*>\s*/i, '')
      .replace(/^\s*■.*?■\s*/, '');
    const [titlePart, authorPart] = line.split(/,\s*by\s+/i);
    meta.englishTitle = titlePart.trim();
    confidence.englishTitle = 'high';
    if (authorPart) {
      meta.englishAuthors = authorPart
        .split(/\s*(?:&|and)\s*|\s*,\s*(?![A-Z]\.)/i)
        .map(s => s.trim().replace(/[.．]$/, ''))
        .filter(Boolean);
      confidence.englishAuthors = 'high';
    }
  } else {
    // ", by" が無い場合: 冒頭付近で ASCII比率が高く 5語以上の行をタイトル候補にする
    const cand = head.findIndex(l =>
      asciiRatio(l) > 0.8 && wordCount(l) >= 5 && wordCount(l) <= 30 && !/^\s*[（(]/.test(l));
    if (cand !== -1) {
      meta.englishTitle = head[cand].trim();
      confidence.englishTitle = 'medium';
    }
  }

  /* ---------- 姓の判定（規定が判定器） ---------- */
  if (meta.englishAuthors?.length) {
    meta.englishSurnames = meta.englishAuthors.map(name => {
      const upper = name.split(/\s+/).filter(w => w.length > 1 && w === w.toUpperCase());
      return upper.length ? upper.join(' ') : null;
    });
    // 全員分の姓が取れたときだけ「高」
    confidence.englishAuthors = meta.englishSurnames.every(Boolean) ? 'high' : 'medium';
  }

  /* ---------- 英文抄録 ---------- */
  const absIndex = head.findIndex((l, i) =>
    i !== byIndex && asciiRatio(l) > 0.85 && wordCount(l) >= 80 && wordCount(l) <= 400);
  if (absIndex !== -1) {
    meta.englishAbstract = head[absIndex].trim();
    confidence.englishAbstract = 'high';
  }

  /* ---------- 和文抄録 ---------- */
  // キーワード行の直前にある、300〜500字の和文ブロック。
  const jaAbsSearchEnd = kwIndex !== -1 ? kwIndex : head.length;
  let jaAbsIndex = -1;
  for (let i = jaAbsSearchEnd - 1; i >= 0; i--) {
    const l = head[i].trim();
    if (asciiRatio(l) < 0.4 && l.length >= 150) { jaAbsIndex = i; break; }
  }
  if (jaAbsIndex !== -1) {
    meta.japaneseAbstract = head[jaAbsIndex].trim();
    confidence.japaneseAbstract = head[jaAbsIndex].length >= 300 && head[jaAbsIndex].length <= 520
      ? 'high' : 'medium';
  }

  /* ---------- 和文タイトル ---------- */
  // 冒頭付近・和文・句点で終わらない・6〜45字。
  // 「句点で終わらない」が効く。本文の1文目はほぼ必ず「．」で終わる。
  const jaTitleIndex = head.findIndex((l, i) => {
    const t = l.trim();
    if (!t || i === byIndex || i === kwIndex || i === jaAbsIndex || i === absIndex) return false;
    if (asciiRatio(t) > 0.3) return false;
    if (/[．。]$/.test(t)) return false;
    if (AFFILIATION_HINT.test(t)) return false;
    return t.length >= 6 && t.length <= 45;
  });
  if (jaTitleIndex !== -1) {
    const raw = head[jaTitleIndex].trim();
    // 末尾の数字は所属を指す脚注番号（テンプレの見本が「タイトル１」の形）。
    // 表題そのものから外して、別のフィールドとして持つ。
    const foot = /([0-9０-９]+)$/.exec(raw);
    meta.japaneseTitle = raw.replace(/[0-9０-９]+$/, '').trim();
    if (foot) meta.titleFootnote = foot[1];
    confidence.japaneseTitle = 'medium';
  }

  /* ---------- 和文著者名 ---------- */
  // タイトルの直後で、全角スペースまたは「，」区切りの短い語が並ぶ行。
  if (jaTitleIndex !== -1) {
    for (let i = jaTitleIndex + 1; i < Math.min(jaTitleIndex + 4, head.length); i++) {
      const t = head[i].trim();
      if (!t || asciiRatio(t) > 0.3) continue;
      if (AFFILIATION_HINT.test(t)) continue;
      const names = t.split(/[，,]/).map(s => s.trim()).filter(Boolean);
      const looksLikeNames = names.length >= 1 && names.length <= 6 &&
        names.every(n => n.replace(/[\u3000\s0-9０-９]/g, '').length >= 2 &&
                         n.replace(/[\u3000\s0-9０-９]/g, '').length <= 8);
      if (looksLikeNames) {
        meta.japaneseAuthors = names.map(n => {
          const mark = /([0-9０-９]+)\s*$/.exec(n);
          return {
            name: n.replace(/[0-9０-９]+\s*$/, '').trim(),
            affiliation: mark ? mark[1] : '',
          };
        });
        confidence.japaneseAuthors = 'medium';
        break;
      }
    }
  }

  /* ---------- 所属 ---------- */
  const affs = head
    .map((l, i) => ({ l: l.trim(), i }))
    .filter(({ l, i }) => l && i !== jaTitleIndex && AFFILIATION_HINT.test(l) && l.length < 120);
  if (affs.length) {
    meta.affiliations = affs.map(({ l }) => {
      const mark = /^\s*[*＊]*\s*([0-9０-９]+)/.exec(l);
      return {
        mark: mark ? mark[1] : '',
        text: l.replace(/^\s*[*＊]*\s*[0-9０-９]+\s*/, '').trim(),
      };
    });
    confidence.affiliations = 'medium';
  }

  return { meta, confidence, bodyStart };
}

/**
 * 抽出結果に対する軽い妥当性チェック。
 * ここでは直さない。フォームに出して人間に判断させるための材料を作るだけ。
 */
export function reviewMeta(meta, limits) {
  const notes = [];
  const w = wordCount(meta.englishAbstract ?? '');
  if (w && w > limits.englishAbstractWords) {
    notes.push({
      id: 'W09', level: 'info', field: 'englishAbstract',
      message: `英文抄録が ${w} words です（規定は約${limits.englishAbstractWords} words）`,
    });
  }
  const jl = (meta.japaneseAbstract ?? '').length;
  if (jl && (jl < limits.japaneseAbstractChars * 0.7 || jl > limits.japaneseAbstractChars * 1.3)) {
    notes.push({
      id: 'W09', level: 'info', field: 'japaneseAbstract',
      message: `和文抄録が ${jl}字 です（規定は${limits.japaneseAbstractChars}字程度）`,
    });
  }
  const k = (meta.keywords ?? []).length;
  if (k && k !== limits.keywords) {
    notes.push({
      id: 'W10', level: 'info', field: 'keywords',
      message: `キーワードが ${k}個 です（テンプレートの見本は${limits.keywords}個）`,
    });
  }
  return notes;
}
