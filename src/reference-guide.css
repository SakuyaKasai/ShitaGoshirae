/**
 * reference-guide.js — 参考文献のガイド編集モーダル
 *
 *   app.js の内部に依存しない。openReferenceGuide() を呼ぶと画面に出て、
 *   「この文字列にする」を押すと onApply(text) が返る。それだけ。
 *
 * ------------------------------------------------------------------
 * 画面の考え方
 * ------------------------------------------------------------------
 *   フォームを空欄から埋めさせない。かといって推測で分割もしない（外すと
 *   ラベル付きの箱に収まって見逃されるため）。
 *
 *   代わりに「残り」という枠を置く。ここには、書式から機械的に判別できな
 *   かった文字がそのまま入っている。ユーザーはこれをドラッグで選び、各欄の
 *   「取り込む」を押す。切るのは人間、運ぶのがアプリ。
 *
 *   取り込んだ文字は残りから消える。減っていって空になれば完成、という
 *   進み具合がそのまま目に見える。チェックリストを別に持たなくてよい。
 */

import { prepareGuide, buildReference } from './reference-format.js';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const CONF_LABEL = { high: '確度が高い推定', medium: '推定', low: '手がかりが弱い推定' };

/**
 * @param {object}   opts
 * @param {string}   opts.line        元の1行（番号は含まない）
 * @param {number}   opts.lineNo      表示用の文献番号（1始まり）
 * @param {object}   opts.references  manifest.references
 * @param {function} opts.onApply     (text: string) => void
 */
export function openReferenceGuide({ line, lineNo, references, onApply }) {
  document.querySelector('.rg-back')?.remove();
  const original = String(line ?? '').trim();
  let guide = prepareGuide(original, references);
  let values = { ...guide.fields };
  let rest = guide.rest;
  // 行頭の文献番号は整形の対象ではなく、そのまま運ぶもの。
  // 組み立てた文字列の先頭へ付け直す（付け直さないと、整形した行だけ番号が消える）。
  const marker = guide.marker;

  const root = el('div', { class: 'rg-back', onclick: e => { if (e.target === root) close(); } });
  const box = el('div', {
    class: 'rg', role: 'dialog', 'aria-modal': 'true', 'aria-label': '参考文献のガイド編集',
  });
  root.append(box);

  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    root.remove();
  }

  /* ---- 種別 ---- */
  const typeSel = el('select', {
    class: 'rg-type',
    onchange: e => {
      // 型を変えても、いま入っている値と残りは保つ。作り直すのは欄の並びだけ。
      guide = prepareGuide(original, references, e.target.value);
      for (const k of Object.keys(values)) {
        if (!currentType()?.fields.some(f => f.key === k)) delete values[k];
      }
      render();
    },
  },
    el('option', { value: '' }, '— 種別を選んでください —'),
    ...references.types.map(t => el('option', { value: t.id }, t.label)));
  typeSel.value = guide.typeId ?? '';

  const currentType = () => references.types.find(t => t.id === typeSel.value);

  /* ---- 残り（ドラッグ元） ---- */
  const restBox = el('textarea', { class: 'rg-rest', rows: '2', spellcheck: 'false' });

  /** 選択範囲を欄へ移す。移した分は残りから消える。 */
  function take(key) {
    const a = restBox.selectionStart, b = restBox.selectionEnd;
    if (a === b) { flash(restBox); return; }
    const picked = restBox.value.slice(a, b).trim();
    if (!picked) { flash(restBox); return; }
    values[key] = values[key] ? `${values[key]} ${picked}` : picked;
    rest = (restBox.value.slice(0, a) + ' ' + restBox.value.slice(b))
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s，,、．.：:；;]+|[\s，,、．.：:；;]+$/g, '');
    render();
  }
  const flash = n => { n.classList.add('rg-flash'); setTimeout(() => n.classList.remove('rg-flash'), 400); };

  const fieldsWrap = el('div', { class: 'rg-fields' });
  const previewWrap = el('div', { class: 'rg-preview' });
  const noticeWrap = el('div', { class: 'rg-notices' });
  const guessNote = el('p', { class: 'rg-guess' });

  /* ---- 組み立て直し ---- */
  function render() {
    const type = currentType();
    guessNote.textContent = guide.typeId && typeSel.value === guide.typeId
      ? `${CONF_LABEL[guide.confidence] ?? '推定'}：${guide.reason}`
      : '';

    restBox.value = rest;
    restBox.placeholder = '（すべて取り込みました）';
    restBox.classList.toggle('is-done', !rest);

    fieldsWrap.replaceChildren();
    if (!type) {
      fieldsWrap.append(el('p', { class: 'rg-empty' }, '種別を選ぶと入力欄が出ます'));
      previewWrap.replaceChildren();
      noticeWrap.replaceChildren();
      return;
    }

    for (const f of type.fields) {
      const input = el('input', {
        type: 'text', class: 'rg-in', id: `rg-f-${f.key}`,
        value: values[f.key] ?? '',
        oninput: e => { values[f.key] = e.target.value; renderPreview(); },
      });
      const auto = guide.found.includes(f.key) && values[f.key] === guide.fields[f.key];
      fieldsWrap.append(el('div', { class: 'rg-row' },
        el('label', { class: 'rg-lb', for: `rg-f-${f.key}` },
          f.label,
          f.required ? el('span', { class: 'rg-req' }, '必須') : null,
          auto ? el('span', { class: 'rg-auto' }, '自動') : null),
        el('div', { class: 'rg-ctl' },
          input,
          el('button', {
            class: 'rg-take', type: 'button', title: '「残り」で選んだ文字をここへ移す',
            onclick: () => take(f.key),
          }, '取り込む')),
        f.hint ? el('p', { class: 'rg-hint' }, f.hint) : null));
    }
    renderPreview();
  }

  /* ---- プレビューと指摘 ---- */
  function renderPreview() {
    const type = currentType();
    if (!type) return;
    const { text, notices } = buildReference(references, type.id, values);

    // R02（記号の重なり）は位置を持っている。文章で場所を説明せず、ここを光らせる。
    const marks = notices.filter(n => n.id === 'R02' && n.at != null)
      .sort((a, b) => a.at - b.at);
    const parts = [];
    let cur = 0;
    for (const m of marks) {
      if (m.at > cur) parts.push(text.slice(cur, m.at));
      parts.push(el('mark', { class: 'rg-hit' }, text.slice(m.at, m.at + (m.length ?? 2))));
      cur = m.at + (m.length ?? 2);
    }
    parts.push(text.slice(cur));

    previewWrap.replaceChildren(
      el('p', { class: 'rg-cap' }, 'できあがり'),
      el('p', { class: 'rg-out' },
        text && marker ? el('span', { class: 'rg-num', title: '原稿にあった文献番号です。そのまま残します' }, marker) : null,
        ...(text ? parts : [el('span', { class: 'rg-empty' }, '（まだ何も入っていません）')])));

    noticeWrap.replaceChildren(...notices.map(n => {
      const card = el('div', { class: `rg-note rg-note-${n.level}` },
        el('span', { class: 'rg-note-id' }, n.id),
        el('span', {},
          el('b', {}, n.message),
          n.suggestion ? el('span', { class: 'rg-note-sub' }, n.suggestion) : null));
      card.addEventListener('click', () => {
        const f = document.getElementById(`rg-f-${n.field}`);
        if (f) { f.focus(); flash(f); }
      });
      return card;
    }));

    // 未入力の欄を赤くする。出力には穴埋め記号を入れないので、印はここだけ。
    for (const f of type.fields) {
      const node = document.getElementById(`rg-f-${f.key}`);
      if (node) node.classList.toggle('is-missing', !!f.required && !String(values[f.key] ?? '').trim());
    }
  }

  /* ---- 組み立て ---- */
  box.append(
    el('div', { class: 'rg-head' },
      el('h2', {}, lineNo ? `参考文献 ${lineNo}) のガイド編集` : '参考文献のガイド編集'),
      el('button', { class: 'rg-x', type: 'button', title: '閉じる', onclick: close }, '×')),

    el('div', { class: 'rg-body' },
      el('div', { class: 'rg-block' },
        el('p', { class: 'rg-cap' }, '種別'),
        typeSel, guessNote),

      el('div', { class: 'rg-block' },
        el('p', { class: 'rg-cap' }, '残り'),
        el('p', { class: 'rg-lead' },
          'ここから文字を選んで、下の欄の「取り込む」を押してください。取り込んだ分は消えます'),
        restBox,
        el('button', {
          class: 'rg-reset', type: 'button',
          onclick: () => { guide = prepareGuide(original, references, typeSel.value || undefined);
                           values = { ...guide.fields }; rest = guide.rest; render(); },
        }, '最初からやり直す')),

      fieldsWrap,
      previewWrap,
      noticeWrap),

    el('div', { class: 'rg-foot' },
      el('p', { class: 'rg-orig' }, `元：${original}`),
      el('div', { class: 'rg-btns' },
        el('button', { class: 'btn', type: 'button', onclick: close }, 'やめる'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => {
            const type = currentType();
            if (!type) { flash(typeSel); return; }
            const { text } = buildReference(references, type.id, values);
            if (!text) { flash(typeSel); return; }
            onApply?.(marker + text);
            close();
          },
        }, 'この文字列にする'))));

  render();
  document.body.append(root);
  typeSel.focus();
  return { close };
}
