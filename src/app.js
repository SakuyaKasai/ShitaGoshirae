/**
 * app.js — 画面。
 *
 * 設計の中心にある考え:
 *   全文を確認させない。推定して、間違いだけ直させる。
 *   そのため画面は「校正刷り（ゲラ）」の見立てになっている。
 *   左端に行番号、指摘のある行の見出しに朱の傍線。
 *   これは日本語の組版と校正の作法そのもので、対象読者が既に知っている記号体系である。
 */

import JSZip from 'jszip';
import { parseSourceDocx, blocksToLines } from './source-parse.js';
import { extractMeta, reviewMeta } from './extract-meta.js';
import { convert } from './pipeline.js';
import { runChecks } from './checker.js';
import { analyzeHeadings, detectHeading } from './heading-detect.js';
import { runChecks, findReferenceSection } from './checker.js';
import { openReferenceGuide } from './reference-guide.js';

/* ============================================================
 * 状態
 * ========================================================== */

const state = {
  manifest: null,
  templateBytes: null,
  sourceBytes: null,
  sourceName: '',
  blocks: null,
  lines: [],
  bodyStart: 0,
  meta: {},
  confidence: {},
  warnings: [],
  outline: [],
  lineIssues: new Map(),   // 行番号 → 警告の配列
  referenceEdits: new Map(),
  autoFix: new Set(['W01', 'W02', 'W15', 'W22']),
  step: 1,
};

/* 前回値の記憶。著者名・所属はほぼ不変なので、これだけで入力の大半が消える。
   保存できない環境（サンドボックス等）では黙ってメモリ上だけで動く。 */
const memory = (() => {
  const KEY = 'jes-formatter/last-meta';
  let fallback = null;
  return {
    load() {
      try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); }
      catch { return fallback; }
    },
    save(v) {
      fallback = v;
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* 保存できなくても動く */ }
    },
  };
})();

/* ============================================================
 * 小道具
 * ========================================================== */

const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const LEVEL_LABEL = { stop: '停止', warn: '要対応', info: '参考' };

/* ============================================================
 * 起動
 * ========================================================== */

window.boot = boot;
export async function boot({ manifest, templateBase64 }) {
  state.manifest = manifest;
  state.templateBytes = base64ToBytes(templateBase64);
  renderShell();
  setStep(1);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ============================================================
 * 画面の骨格
 * ========================================================== */

function renderShell() {
  $('#app').replaceChildren(
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'brand-mark' }, '技'),
        el('div', {},
          el('h1', {}, '原稿したごしらえ'),
          el('p', { class: 'brand-sub' }, '日本人間工学会『人間工学』誌　技術報告テンプレート'))),
      el('nav', { class: 'steps', id: 'steps' },
        stepChip(1, '原稿を読む'),
        stepChip(2, '書誌情報'),
        stepChip(3, 'ゲラを確認'))),
    el('main', { class: 'stage', id: 'stage' }),
  );
}

function stepChip(n, label) {
  return el('button', {
    class: 'step', 'data-step': n, disabled: true,
    onclick: () => { if (n <= state.step) setStep(n); },
  }, el('span', { class: 'step-n' }, String(n)), label);
}

function setStep(n) {
  state.step = Math.max(state.step, n);
  for (const b of document.querySelectorAll('.step')) {
    const s = Number(b.dataset.step);
    b.classList.toggle('is-current', s === n);
    b.classList.toggle('is-done', s < n);
    b.disabled = s > state.step;
  }
  if (n === 1) renderDrop();
  if (n === 2) renderForm();
  if (n === 3) renderGalley();
}

/* ============================================================
 * 1. 原稿を読む
 * ========================================================== */

function renderDrop() {
  const zone = el('label', { class: 'drop', for: 'file' },
    el('div', { class: 'drop-rule' }),
    el('div', { class: 'drop-body' },
      el('p', { class: 'drop-lead' }, 'Word 原稿をここに置いてください'),
      el('p', { class: 'drop-sub' }, '.docx のみ。Google ドキュメントは「ファイル → ダウンロード → Word」で書き出したものを使います'),
      el('span', { class: 'btn btn-ghost' }, 'ファイルを選ぶ')),
    el('div', { class: 'drop-rule' }),
    el('input', { type: 'file', id: 'file', accept: '.docx', hidden: true,
      onchange: e => e.target.files[0] && loadSource(e.target.files[0]) }));

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('is-over');
    const f = e.dataTransfer.files[0];
    if (f) loadSource(f);
  });

  $('#stage').replaceChildren(
    el('section', { class: 'pane pane-solo' },
      zone,
      el('div', { class: 'notice', id: 'drop-notice' }),
      el('details', { class: 'primer' },
        el('summary', {}, '原稿を書くときに守っていただきたいこと'),
        el('ol', { class: 'primer-list' },
          ...[
            ['見出しに番号を付ける', '「1.」「2-1.」のように。番号がない行は本文と区別できません'],
            ['数式は Word の数式ツールで書く', 'ᵢ や ∫ を文字として打つと、環境によって化けます'],
            ['図は画像として貼る', 'Word の図形や SmartArt は、ファイルの中に画像として残らないため運べません'],
            ['表題・著者名・抄録は本文に混ぜない', 'この後の画面で入力します。原稿の冒頭にあれば読み取ります'],
            ['参考文献は「文献」見出しの後にまとめる', '本文中の引用番号と突き合わせます'],
          ].map(([t, d]) => el('li', {}, el('b', {}, t), el('span', {}, d)))))),
  );
}

async function loadSource(file) {
  const notice = $('#drop-notice');
  notice.replaceChildren(el('p', { class: 'notice-work' }, `${file.name} を読んでいます…`));

  if (!/\.docx$/i.test(file.name)) {
    notice.replaceChildren(problem(
      'この形式は読めません',
      'PDF や .doc では段落の区切りが失われます。Word または Google ドキュメントの原本を .docx で書き出してお使いください。'));
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const parsed = await parseSourceDocx(zip);

    state.sourceBytes = bytes;
    state.sourceName = file.name;
    state.blocks = parsed.blocks;
    state.lines = blocksToLines(parsed.blocks);

    const ex = extractMeta(state.lines);
    state.bodyStart = ex.bodyStart;
    state.meta = { ...(memory.load() ?? {}), ...stripEmpty(ex.meta) };
    state.confidence = ex.confidence;
    state.sourceWarnings = parsed.warnings;

    notice.replaceChildren(el('div', { class: 'stat-row' },
      stat(parsed.stats.paragraphs, '段落'),
      stat(parsed.stats.chars.toLocaleString(), '文字'),
      stat(parsed.stats.images, '画像'),
      stat(parsed.stats.tables, '表'),
      stat(parsed.stats.maths, '数式')));

    setStep(2);
  } catch (err) {
    notice.replaceChildren(problem('原稿を開けませんでした', String(err.message ?? err)));
  }
}

const stripEmpty = o => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '' &&
    !(Array.isArray(v) && v.length === 0)));

const stat = (v, label) => el('div', { class: 'stat' },
  el('b', {}, String(v)), el('span', {}, label));

const problem = (title, detail) => el('div', { class: 'problem' },
  el('b', {}, title), el('p', {}, detail));

/* ============================================================
 * 2. 書誌情報
 * ========================================================== */

const FIELDS = [
  { key: 'japaneseTitle', label: '和文表題', type: 'text' },
  { key: 'englishTitle', label: '英文表題', type: 'text',
    hint: '各単語の頭文字を大文字に。冠詞・接続詞・前置詞は小文字（先頭語は除く）' },
  { key: 'japaneseAuthors', label: '和文著者名', type: 'authors' },
  { key: 'englishAuthors', label: '英文著者名', type: 'list',
    hint: '姓のみ全て大文字で書きます（例: Yuri AOKI）' },
  { key: 'japaneseAbstract', label: '和文抄録', type: 'area', counter: 'chars' },
  { key: 'englishAbstract', label: '英文抄録', type: 'area', counter: 'words' },
  { key: 'keywords', label: 'キーワード', type: 'list' },
  { key: 'affiliations', label: '所属', type: 'affiliations' },
  { key: 'titleFootnote', label: '表題の脚注番号', type: 'text',
    hint: '和文表題の右肩に付ける番号。受付日の注に対応します' },
  { key: 'received', label: '受付日', type: 'text', hint: '例: 受付：2026年8月16日' },
];

function renderForm() {
  const notes = reviewMeta(state.meta, state.manifest.limits);
  const noteFor = f => notes.filter(n => n.field === f);

  const form = el('div', { class: 'form' },
    ...FIELDS.map(f => fieldRow(f, noteFor(f.key))));

  $('#stage').replaceChildren(
    el('section', { class: 'pane' },
      el('div', { class: 'pane-head' },
        el('h2', {}, '書誌情報'),
        el('p', { class: 'pane-sub' },
          '原稿の冒頭から読み取った候補です。中身を確かめて、違うところだけ直してください')),
      el('p', { class: 'legend' },
        badge('high', '読み取り済み'), badge('medium', '要確認'), badge('none', '未入力')),
      form,
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn-primary', onclick: () => { collectForm(); memory.save(state.meta); setStep(3); } },
          'ゲラを確認する'))),
  );
}

const badge = (level, text) => el('span', { class: `badge badge-${level}` }, text);

function fieldRow(f, notes) {
  const conf = state.confidence[f.key] ?? (state.meta[f.key] ? 'high' : 'none');
  const body = {
    text: () => el('input', { type: 'text', id: `f-${f.key}`, value: state.meta[f.key] ?? '' }),
    area: () => el('textarea', { id: `f-${f.key}`, rows: f.key === 'englishAbstract' ? 6 : 6 },
      state.meta[f.key] ?? ''),
    list: () => el('input', { type: 'text', id: `f-${f.key}`,
      value: (state.meta[f.key] ?? []).join('，') }),
    authors: () => el('input', { type: 'text', id: `f-${f.key}`,
      value: (state.meta[f.key] ?? []).map(a => `${a.name}${a.affiliation ?? ''}`).join('，') }),
    affiliations: () => el('textarea', { id: `f-${f.key}`, rows: 3 },
      (state.meta[f.key] ?? []).map(a => `${a.mark}\t${a.text}`).join('\n')),
  }[f.type]();

  const counter = el('span', { class: 'counter' });
  const updateCounter = () => {
    if (!f.counter) return;
    const v = body.value ?? '';
    if (f.counter === 'chars') {
      const n = v.length;
      counter.textContent = `${n}字 / 目安 ${state.manifest.limits.japaneseAbstractChars}字`;
      counter.classList.toggle('is-over', n > state.manifest.limits.japaneseAbstractChars * 1.3);
    } else {
      const n = v.trim() ? v.trim().split(/\s+/).length : 0;
      counter.textContent = `${n} words / 規定 ${state.manifest.limits.englishAbstractWords} words`;
      counter.classList.toggle('is-over', n > state.manifest.limits.englishAbstractWords);
    }
  };
  body.addEventListener('input', updateCounter);
  updateCounter();

  return el('div', { class: `field field-${conf}` },
    el('div', { class: 'field-head' },
      el('label', { for: `f-${f.key}` }, f.label),
      badge(conf, conf === 'high' ? '読み取り済み' : conf === 'medium' ? '要確認' : '未入力'),
      counter),
    body,
    f.hint ? el('p', { class: 'field-hint' }, f.hint) : null,
    ...notes.map(n => el('p', { class: 'field-note' }, n.message)));
}

function collectForm() {
  const get = k => $(`#f-${k}`)?.value ?? '';
  state.meta = {
    ...state.meta,
    japaneseTitle: get('japaneseTitle').trim(),
    titleFootnote: get('titleFootnote').trim(),
    englishTitle: get('englishTitle').trim(),
    received: get('received').trim(),
    japaneseAbstract: get('japaneseAbstract').trim(),
    englishAbstract: get('englishAbstract').trim(),
    keywords: splitList(get('keywords')),
    englishAuthors: splitList(get('englishAuthors')),
    japaneseAuthors: splitList(get('japaneseAuthors')).map(s => {
      const m = /([0-9０-９]+)\s*$/.exec(s);
      return { name: s.replace(/[0-9０-９]+\s*$/, '').trim(), affiliation: m ? m[1] : '' };
    }),
    affiliations: get('affiliations').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [mark, ...rest] = l.split(/\t|\s{2,}|\u3000/);
      return rest.length ? { mark: mark.trim(), text: rest.join(' ').trim() } : { mark: '', text: l };
    }),
  };
}

const splitList = s => s.split(/[，,]/).map(x => x.trim()).filter(Boolean);

/* ============================================================
 * 3. ゲラ
 * ========================================================== */

function renderGalley() {
  // 本文だけを対象にチェックを走らせる（書誌情報の重複検出を避ける）
  const bodyLines = state.lines.slice(state.bodyStart);
  const checks = runChecks(bodyLines.join('\n'), {
    englishTitle: state.meta.englishTitle,
    englishAuthors: state.meta.englishAuthors,
    keywords: state.meta.keywords,
  });
  const headings = analyzeHeadings(bodyLines);

  // analyzeHeadings は runChecks の内側でも走るので、同じ指摘が二重に出る。
  // ID と文面が同じものは1件に畳む。
  const seen = new Set();
  state.warnings = [...(state.sourceWarnings ?? []), ...headings.warnings, ...checks.results]
    .filter(w => {
      const key = `${w.id}|${w.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  state.lineIssues = mapIssuesToLines(bodyLines, checks.results);

  $('#stage').replaceChildren(
    el('section', { class: 'pane pane-split' },
      galleyColumn(bodyLines, headings),
      sideColumn(headings)),
  );
}

/** 警告のオフセットを行番号へ落とす。ゲラの傍線を引く位置を決めるために要る */
function mapIssuesToLines(lines, results) {
  const starts = [];
  let acc = 0;
  for (const l of lines) { starts.push(acc); acc += l.length + 1; }

  const map = new Map();
  const push = (i, r) => {
    if (!map.has(i)) map.set(i, []);
    if (!map.get(i).some(x => x.id === r.id)) map.get(i).push(r);
  };

  const lineOf = offset => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  for (const r of results) {
    // 修正候補は文字オフセットを持つので、行へ落とす
    for (const fx of r.fixes ?? []) {
      if (typeof fx.start === 'number') push(lineOf(fx.start), r);
    }
    // W07 など、detail に「N行目:」の形で行を持つものを拾う
    for (const d of r.detail ?? []) {
      const m = /^(\d+)行目/.exec(String(d));
      if (m) push(Number(m[1]) - 1, r);
    }
  }
  return map;
}

function galleyColumn(lines, headings) {
  const headingAt = new Map(headings.headings.map(h => [h.index, h]));
  const refStart = findReferenceSection(lines);

  const rows = lines.map((text, i) => {
    const issues = state.lineIssues.get(i) ?? [];
    const h = headingAt.get(i);
    const worst = issues.some(x => x.level === 'warn') ? 'warn'
      : issues.length ? 'info' : null;

    // 「文献」見出しより後ろの、中身のある行だけがガイド編集の対象。
    // 見出しそのもの（refStart 行）は含めない。
    const isRef = refStart !== null && i > refStart && text.trim().length > 0;   
    const shown = state.referenceEdits.get(i) ?? text;                            

    return el('div', {
      class: `gl ${worst ? `gl-${worst}` : ''} ${h ? `gl-h gl-h${h.level}` : ''}`,
      id: `gl-${i}`, tabindex: 0,
    },
      el('span', { class: 'gl-n' }, String(i + 1)),
      el('span', { class: 'gl-mark', title: issues.map(x => x.id).join(' ') },
        issues.length ? issues.map(x => x.id).join(' ') : ''),
      el('span', { class: `gl-t${state.referenceEdits.has(i) ? ' is-edited' : ''}` },   
        h ? el('span', { class: 'gl-lv' }, `H${h.level}`) : null,
        text || el('span', { class: 'gl-empty' }, '（空行）'))),
      isRef ? el('button', {
        class: 'gl-guide', type: 'button', title: '規定の書式に整えます',
        onclick: e => { e.stopPropagation(); openGuideFor(i); },
      }, 'ガイド編集') : null);
  });

  return el('div', { class: 'galley' },
    el('div', { class: 'galley-head' },
      el('h2', {}, 'ゲラ'),
      el('p', { class: 'pane-sub' }, `本文 ${lines.length}行・見出し ${headings.stats.total}件`)),
    el('div', { class: 'galley-body' }, ...rows));
}

/** ガイド編集を開き、確定した文字列を持ち帰る。
 *  原文は書き換えず、行番号ひもづけで別に持つ。出力時にだけ差し替える。 */
function openGuideFor(i) {
  const references = state.manifest?.references;
  if (!references) {
    alert('この manifest には参考文献の書式定義が入っていません。テンプレートを取り込み直してください');
    return;
  }
  openReferenceGuide({
    line: state.referenceEdits.get(i) ?? state.lines[i],
    lineNo: i + 1,
    references,
    onApply: text => {
      state.referenceEdits.set(i, text);
      const node = document.querySelector(`#gl-${i} .gl-t`);
      if (node) {
        node.textContent = text;
        node.classList.add('is-edited');
      }
      const note = $('#out-note');
      if (note) note.textContent =
        `自動で直す項目: ${[...state.autoFix].join('・') || 'なし'}` +
        `／参考文献をガイド編集: ${state.referenceEdits.size}件`;
    },
  });
}

function sideColumn(headings) {
  const grouped = new Map();
  for (const w of state.warnings) {
    if (!grouped.has(w.id)) grouped.set(w.id, []);
    grouped.get(w.id).push(w);
  }

  const order = { warn: 0, stop: -1, info: 1 };
  const items = [...grouped.entries()]
    .sort((a, b) => (order[a[1][0].level] ?? 0) - (order[b[1][0].level] ?? 0))
    .map(([id, ws]) => warningCard(id, ws));

  const counts = state.warnings.reduce((a, w) => {
    a[w.level === 'info' ? 'info' : 'warn']++; return a;
  }, { warn: 0, info: 0 });

  return el('div', { class: 'side' },
    el('div', { class: 'side-head' },
      el('h2', {}, '指摘'),
      el('p', { class: 'pane-sub' }, `要対応 ${counts.warn}件・参考 ${counts.info}件`)),
    el('div', { class: 'side-body' }, items.length ? items : el('p', { class: 'ok' }, '指摘はありません')),
    el('div', { class: 'side-foot' },
      el('button', { class: 'btn btn-primary', id: 'go', onclick: doConvert }, 'Word 原稿を作る'),
      el('p', { class: 'side-note', id: 'out-note' },
        `自動で直す項目: ${[...state.autoFix].join('・') || 'なし'}`)));
}

function warningCard(id, ws) {
  const w = ws[0];
  const fixable = w.autoFix === true || (w.fixes && w.fixes.length);
  const total = ws.reduce((n, x) => n + (x.count ?? 1), 0);

  // この指摘が付いている行。全文を読ませず、指摘の場所へ直接連れて行く。
  const targets = [...state.lineIssues.entries()]
    .filter(([, list]) => list.some(x => x.id === id))
    .map(([i]) => i);

  const card = el('div', {
    class: `wcard wcard-${w.level ?? 'warn'}${targets.length ? ' is-linked' : ''}`,
    tabindex: targets.length ? 0 : null,
    onclick: targets.length ? () => jumpTo(targets, id) : null,
    onkeydown: targets.length
      ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpTo(targets, id); } }
      : null,
  },
    el('div', { class: 'wcard-head' },
      el('span', { class: 'wcard-id' }, id),
      el('span', { class: 'wcard-lv' }, LEVEL_LABEL[w.level] ?? '要対応'),
      total > 1 ? el('span', { class: 'wcard-count' }, `${total}件`) : null),
    ...ws.map(x => el('p', { class: 'wcard-msg' }, x.message)),
    targets.length
      ? el('p', { class: 'wcard-jump' },
          `${targets.slice(0, 6).map(i => `${i + 1}行`).join('・')}${targets.length > 6 ? ` ほか${targets.length - 6}件` : ''}`)
      : null,
    fixable ? el('label', { class: 'switch', onclick: e => e.stopPropagation() },
      el('input', {
        type: 'checkbox', checked: state.autoFix.has(id),
        onchange: e => {
          e.target.checked ? state.autoFix.add(id) : state.autoFix.delete(id);
          $('#out-note').textContent = `自動で直す項目: ${[...state.autoFix].join('・') || 'なし'}`;
        },
      }),
      el('span', {}, '出力時に直す')) : null);

  return card;
}

/** 指摘のある行へ送る。同じ指摘を続けて押すと次の行へ回る */
const jumpCursor = new Map();
function jumpTo(targets, id) {
  const k = jumpCursor.get(id) ?? 0;
  const line = targets[k % targets.length];
  jumpCursor.set(id, k + 1);

  const row = document.getElementById(`gl-${line}`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  for (const n of document.querySelectorAll('.is-lit')) n.classList.remove('is-lit');
  row.classList.add('is-lit');
  row.focus({ preventScroll: true });
}

/* ============================================================
 * 出力
 * ========================================================== */

async function doConvert() {
  const btn = $('#go');
  const note = $('#out-note');
  btn.disabled = true;
  btn.textContent = '組んでいます…';

  try {
    const res = await convert({
      templateBytes: state.templateBytes,
      sourceBytes: state.sourceBytes,
      manifest: state.manifest,
      meta: state.meta,
      autoFixIds: [...state.autoFix],
      bodyStart: state.bodyStart,
      referenceOverrides: Object.fromEntries(state.referenceEdits),
    });

    const blob = new Blob([res.bytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const url = URL.createObjectURL(blob);
    const name = state.sourceName.replace(/\.docx$/i, '') + '_人間工学誌.docx';

    // 自動クリックはサンドボックス環境で黙って失敗する。実リンクを押してもらう。
    note.replaceChildren(
      el('a', { class: 'btn btn-download', href: url, download: name }, `${name} を保存`),
      el('p', { class: 'side-note' },
        `自動修正 ${res.report.appliedFixes}件を適用しました。` +
        `Word で開いたあと、図表の位置と数式の表示をご確認ください`));
    btn.textContent = 'もう一度作る';
  } catch (err) {
    note.replaceChildren(problem('作れませんでした', String(err.message ?? err)));
    btn.textContent = 'Word 原稿を作る';
  } finally {
    btn.disabled = false;
  }
}
