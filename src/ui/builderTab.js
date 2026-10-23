'use strict';

/** Вкладка «Конструктор и предпросмотр» (макет «Предпросмотр и конструктор»). */

const { MarkdownRenderer, Component, Notice, setIcon } = require('obsidian');
const D = require('./dom');
const U = require('../util');
const { BLOCK_LABELS, BLOCK_ICONS } = require('../constants');
const { FolderSuggest } = require('../settings');
const { renderPageToCanvas } = require('../convert/pdf');

const KIND_ICONS = { pdf: 'file-type-2', web: 'globe', telegram: 'send', clipboard: 'clipboard-paste', docx: 'file-text', text: 'file', markdown: 'file-pen', html: 'file-code' };

function renderBuilder(view, root) {
  const sess = view.session;
  if (!sess) return renderEmpty(view, root);
  const ctx = { view, sess, refs: {} };
  renderHeader(ctx, root);
  renderStatsStrip(ctx, root);
  renderPanes(ctx, root);
  renderFooter(ctx, root);
  refresh(ctx);
}

function renderEmpty(view, root) {
  const card = D.div(root, 'mi-card mi-empty');
  const ic = D.div(card, 'mi-icon-box mi-icon-box-lg');
  D.icon(ic, 'layout-panel-left');
  D.el(card, 'h3', 'mi-h3', 'Нет разобранного источника');
  D.el(card, 'p', 'mi-sub', 'Выберите файл, ссылку, пост Telegram или вставьте содержимое буфера — здесь появится предпросмотр «оригинал | результат» и конструктор блоков.');
  D.button(card, { icon: 'download', text: 'К источникам', cls: 'mi-btn-primary', onClick: () => view.switchTab('sources') });
}

// ───────────── шапка ─────────────

function renderHeader(ctx, root) {
  const { view, sess } = ctx;
  const card = D.div(root, 'mi-card mi-builder-head');
  const top = D.div(card, 'mi-bh-top');
  const ic = D.div(top, 'mi-icon-box mi-icon-box-lg');
  D.icon(ic, KIND_ICONS[sess.kind] || 'file');

  const titles = D.div(top, 'mi-bh-titles');
  const titleRow = D.div(titles, 'mi-title-row');
  const titleInput = titleRow.createEl('input', { type: 'text', cls: 'mi-title-input' });
  titleInput.value = sess.title;
  titleInput.setAttr('aria-label', 'Название заметки');
  titleInput.addEventListener('input', () => {
    sess.title = titleInput.value;
    refreshDebounced(ctx);
  });
  D.chip(titleRow, sess.rawOverride !== null ? 'ПРАВКА ВРУЧНУЮ' : 'ГОТОВО', 'mi-chip-mono mi-chip-ok');
  const sub = D.div(titles, 'mi-bh-sub');
  D.chip(sub, `${sess.label} · ${sess.meta.site || sess.fileName || 'источник'}`, 'mi-chip-mono mi-chip-accent');
  ctx.refs.metaLine = D.div(titles, 'mi-bh-meta');

  const actions = D.div(top, 'mi-bh-actions');
  const folderWrap = D.div(actions, 'mi-folder');
  D.icon(folderWrap, 'folder');
  D.el(folderWrap, 'span', 'mi-folder-label', 'Папка:');
  const folderInput = folderWrap.createEl('input', { type: 'text', cls: 'mi-folder-input' });
  folderInput.value = sess.folder || '';
  folderInput.placeholder = '/ (корень)';
  folderInput.addEventListener('input', () => (sess.folder = folderInput.value.trim()));
  new FolderSuggest(view.app, folderInput, (v) => (sess.folder = v));
  const create = D.button(actions, {
    icon: 'save',
    text: sess.options.split && sess.hasGroups ? `Создать заметки (${Object.keys(sess.groupMeta).length})` : 'Создать заметку в Vault',
    cls: 'mi-btn-primary',
    onClick: () => view.createNote(),
    disabled: !!view.busy,
  });
  ctx.refs.createBtn = create;

  // режимы
  const modes = D.div(card, 'mi-mode-cards');
  const modeCard = (value, iconName, title, hint) => {
    const b = modes.createEl('button', { cls: 'mi-mode-card' + (sess.options.mode === value ? ' is-active' : '') });
    const ib = D.div(b, 'mi-icon-box mi-icon-box-sm');
    D.icon(ib, iconName);
    const t = D.div(b, 'mi-mode-text');
    D.div(t, 'mi-mode-title', title);
    D.div(t, 'mi-mode-hint', hint);
    if (sess.options.mode === value) D.icon(b, 'check-circle-2', 'mi-icon mi-mode-check');
    b.addEventListener('click', () => {
      sess.options.mode = value;
      if (value === 'builder' && view.ui.view === 'original') view.ui.view = 'split';
      view.render();
    });
  };
  modeCard('flat', 'file-text', 'Без вёрстки', 'Чистый raw-текст, flat');
  modeCard('layout', 'wand-2', 'С вёрсткой оригинала', 'Таблицы, LaTeX, callouts');
  modeCard('builder', 'sliders-horizontal', 'Конструктор блоков', 'Фильтры и порядок');

  const viewRow = D.div(card, 'mi-view-row');
  D.segmented(viewRow, {
    cls: 'mi-seg-sm',
    options: [
      { value: 'original', label: 'Оригинал', icon: 'eye' },
      { value: 'split', label: 'Рядом (Split)', icon: 'columns-2' },
      { value: 'result', label: 'Результат', icon: 'file-check-2' },
    ],
    value: view.ui.view,
    onChange: (v) => {
      view.ui.view = v;
      view.render();
    },
  });
  D.div(viewRow, 'mi-topbar-spacer');
  D.button(viewRow, { icon: 'refresh-cw', text: 'Разобрать заново', cls: 'mi-btn-ghost', onClick: () => rebuild(ctx) });
  D.button(viewRow, { icon: 'x', text: 'Отменить', cls: 'mi-btn-ghost', onClick: () => view.discardSession() });
}

// ───────────── полоса статистики ─────────────

function renderStatsStrip(ctx, root) {
  const strip = D.div(root, 'mi-card mi-strip');
  ctx.refs.strip = D.div(strip, 'mi-strip-items');
  const live = D.div(strip, 'mi-live');
  live.createSpan({ cls: 'mi-dot' });
  live.appendText(' Live Preview');
}

function updateStrip(ctx, stats) {
  const el = ctx.refs.strip;
  if (!el) return;
  el.empty();
  const item = (ic, label, value) => {
    const s = D.div(el, 'mi-strip-item');
    D.icon(s, ic);
    D.el(s, 'span', 'mi-strip-label', `${label}:`);
    D.el(s, 'span', 'mi-strip-value', value);
  };
  item('braces', 'Размер заметки', U.formatBytes(stats.bytes));
  item('align-left', 'Слов', U.formatNumber(stats.words));
  item('link', 'Внутренних ссылок', `${stats.links} ([[Wikilinks]])`);
  item('table', 'Таблиц', String(stats.tables));
  item('sigma', 'Формул', String(stats.formulas));
  item('image', 'Изображений', String(stats.images));
  item('blocks', 'Блоков', `${stats.blocks} из ${ctx.sess.blocks.length}`);
}

function updateMetaLine(ctx, stats) {
  const el = ctx.refs.metaLine;
  if (!el) return;
  const { sess } = ctx;
  el.empty();
  const parts = [];
  if (sess.kind === 'pdf') parts.push(`${sess.pages} ${U.plural(sess.pages, 'страница', 'страницы', 'страниц')}`);
  if (sess.hasGroups) parts.push(`${Object.keys(sess.groupMeta).length} постов`);
  parts.push(`Распознано ${U.formatNumber(stats.words)} слов`);
  if (stats.formulas) parts.push(`${stats.formulas} формул LaTeX`);
  if (stats.tables) parts.push(`${stats.tables} ${U.plural(stats.tables, 'таблица', 'таблицы', 'таблиц')}`);
  parts.push(U.formatBytes(sess.size));
  if (sess.meta.author) parts.push(sess.meta.author);
  parts.forEach((p, i) => {
    if (i) D.el(el, 'span', 'mi-sep', '•');
    D.el(el, 'span', '', p);
  });
}

// ───────────── панели ─────────────

function renderPanes(ctx, root) {
  const { view, sess } = ctx;
  const mode = view.ui.view;
  const builder = sess.options.mode === 'builder';
  const panes = D.div(root, `mi-panes is-${mode}${builder ? ' is-builder' : ''}`);
  if (mode === 'original') return renderOriginalPane(ctx, panes);
  if (mode === 'split') {
    if (builder) renderBlocksPane(ctx, panes);
    else renderOriginalPane(ctx, panes);
  }
  renderResultPane(ctx, panes);
}

function paneShell(parent, cls) {
  const pane = D.div(parent, `mi-pane ${cls || ''}`.trim());
  const head = D.div(pane, 'mi-pane-head');
  const body = D.div(pane, 'mi-pane-body');
  return { pane, head, body };
}

function renderOriginalPane(ctx, parent) {
  const { view, sess } = ctx;
  const o = sess.original || { type: 'text', text: '' };
  const { head, body } = paneShell(parent, 'mi-pane-original');
  D.icon(head, 'scan-line', 'mi-icon mi-accent');
  const title = D.el(head, 'span', 'mi-pane-title');
  D.div(head, 'mi-topbar-spacer');

  if (o.type === 'pdf') {
    title.setText(`СКАН ИСТОЧНИКА · СТР. 1 ИЗ ${o.pageCount}`);
    const zoomOut = D.button(head, { icon: 'zoom-out', cls: 'mi-btn-ghost mi-btn-icon', title: 'Уменьшить' });
    const zoomLabel = D.el(head, 'span', 'mi-zoom', `${Math.round(view.ui.zoom * 100)}%`);
    const zoomIn = D.button(head, { icon: 'zoom-in', cls: 'mi-btn-ghost mi-btn-icon', title: 'Увеличить' });
    const fit = D.button(head, { icon: 'scan', cls: 'mi-btn-ghost mi-btn-icon is-accent', title: 'По ширине' });
    const setZoom = (z) => {
      view.ui.zoom = Math.max(0.4, Math.min(3, z));
      zoomLabel.setText(`${Math.round(view.ui.zoom * 100)}%`);
      renderPdfPages(ctx, body, o, title);
    };
    zoomOut.onclick = () => setZoom(view.ui.zoom - 0.15);
    zoomIn.onclick = () => setZoom(view.ui.zoom + 0.15);
    fit.onclick = () => setZoom(1);
    body.addClass('mi-pdf-scroll');
    renderPdfPages(ctx, body, o, title);
    return;
  }
  if (o.type === 'html') {
    let host = '';
    try {
      host = o.baseUrl ? new URL(o.baseUrl).hostname : '';
    } catch (e) {
      host = '';
    }
    title.setText(`ОРИГИНАЛ${host ? ' · ' + host : ''}`);
    if (o.baseUrl) {
      D.button(head, {
        icon: 'external-link',
        cls: 'mi-btn-ghost mi-btn-icon',
        title: 'Открыть в браузере',
        onClick: () => window.open(o.baseUrl),
      });
    }
    const frame = body.createEl('iframe', { cls: 'mi-frame' });
    frame.setAttr('sandbox', 'allow-same-origin allow-popups');
    frame.setAttr('referrerpolicy', 'no-referrer');
    frame.srcdoc = o.html || '<p style="font-family:sans-serif;color:#888">Нет HTML-исходника</p>';
    return;
  }
  title.setText('ОРИГИНАЛ · ТЕКСТ');
  D.el(body, 'pre', 'mi-orig-text', o.text || '');
}

function renderPdfPages(ctx, body, o, titleEl) {
  const { view, sess } = ctx;
  body.empty();
  const cache = sess._canvasCache || (sess._canvasCache = new Map());
  const pages = (sess.analysis && sess.analysis.pages) || [];
  const zoom = view.ui.zoom;
  const width = Math.max(260, (body.clientWidth || 560) - 40) * zoom;
  const wrap = D.div(body, 'mi-pdf-pages');
  const holders = [];
  for (let i = 0; i < o.pageCount; i++) {
    const p = pages[i] || { width: 595, height: 842 };
    const h = D.div(wrap, 'mi-pdf-page');
    h.style.width = `${width}px`;
    h.style.height = `${(width * p.height) / p.width}px`;
    h.dataset.page = String(i + 1);
    D.el(h, 'span', 'mi-pdf-num', String(i + 1));
    holders.push(h);
  }
  const renderOne = async (h) => {
    if (h.dataset.done) return;
    h.dataset.done = '1';
    const num = +h.dataset.page;
    const key = `${num}@${zoom.toFixed(2)}@${Math.round(width)}`;
    let canvas = cache.get(key);
    if (!canvas) {
      canvas = document.createElement('canvas');
      const p = pages[num - 1] || { width: 595 };
      const scale = (width / p.width) * (window.devicePixelRatio || 1);
      try {
        await renderPageToCanvas(o.doc, num, scale, canvas);
        cache.set(key, canvas);
      } catch (e) {
        h.dataset.done = '';
        return;
      }
    }
    canvas.addClass('mi-pdf-canvas');
    h.appendChild(canvas);
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) renderOne(e.target);
    },
    { root: body, rootMargin: '600px 0px' }
  );
  holders.forEach((h) => io.observe(h));
  body.onscroll = () => {
    const mid = body.scrollTop + body.clientHeight / 3;
    let cur = 1;
    for (const h of holders) if (h.offsetTop <= mid) cur = +h.dataset.page;
    titleEl.setText(`СКАН ИСТОЧНИКА · СТР. ${cur} ИЗ ${o.pageCount}`);
  };
  // первая страница — сразу, даже если IntersectionObserver ещё не сработал
  if (holders[0]) renderOne(holders[0]);
}

function renderResultPane(ctx, parent) {
  const { view, sess } = ctx;
  const { head, body } = paneShell(parent, 'mi-pane-result');
  D.icon(head, 'file-pen-line', 'mi-icon mi-accent');
  D.el(head, 'span', 'mi-pane-title', view.ui.resultMode === 'raw' ? 'ИСХОДНИК MARKDOWN · РЕДАКТИРОВАНИЕ' : 'OBSIDIAN LIVE PREVIEW · РЕЖИМ ЧТЕНИЯ');
  D.div(head, 'mi-topbar-spacer');
  D.button(head, {
    icon: 'copy',
    text: 'Копировать MD',
    cls: 'mi-btn-outline mi-btn-sm',
    onClick: async () => {
      const { md } = sess.compose();
      await navigator.clipboard.writeText(sess.assets.resolveForClipboard(md));
      new Notice('Markdown скопирован');
    },
  });
  D.button(head, {
    icon: view.ui.resultMode === 'raw' ? 'eye' : 'code-2',
    text: view.ui.resultMode === 'raw' ? 'Предпросмотр' : 'Исходник (Raw)',
    cls: 'mi-btn-outline mi-btn-sm' + (view.ui.resultMode === 'raw' ? ' is-active' : ''),
    onClick: () => {
      view.ui.resultMode = view.ui.resultMode === 'raw' ? 'preview' : 'raw';
      view.render();
    },
  });
  ctx.refs.result = body;
}

function renderBlocksPane(ctx, parent) {
  const { head, body } = paneShell(parent, 'mi-pane-blocks');
  D.icon(head, 'sliders-horizontal', 'mi-icon mi-accent');
  D.el(head, 'span', 'mi-pane-title', 'КОНСТРУКТОР БЛОКОВ · ПЕРЕТАСКИВАЙТЕ И ВЫКЛЮЧАЙТЕ');
  D.div(head, 'mi-topbar-spacer');
  D.button(head, {
    icon: 'check-check',
    text: 'Всё',
    cls: 'mi-btn-outline mi-btn-sm',
    onClick: () => {
      ctx.sess.disabled.clear();
      refresh(ctx);
    },
  });
  D.button(head, {
    icon: 'list-restart',
    text: 'Порядок',
    cls: 'mi-btn-outline mi-btn-sm',
    title: 'Исходный порядок',
    onClick: () => {
      ctx.sess.order = ctx.sess.blocks.map((b) => b.id);
      refresh(ctx);
    },
  });
  ctx.refs.blocks = body;
}

// ───────────── обновление ─────────────

function refresh(ctx) {
  const { sess, view } = ctx;
  const composed = sess.compose({ forPreview: true });
  updateStrip(ctx, composed.stats);
  updateMetaLine(ctx, composed.stats);
  if (ctx.refs.blocks) renderBlockList(ctx, ctx.refs.blocks);
  if (ctx.refs.result) {
    if (view.ui.resultMode === 'raw') renderRaw(ctx, ctx.refs.result, composed);
    else renderPreview(ctx, ctx.refs.result, composed);
  }
}

const refreshDebounced = U.debounce((ctx) => refresh(ctx), 250);

async function rebuild(ctx) {
  const { view, sess } = ctx;
  view.busy = { label: 'Пересобираю…', progress: 0.5 };
  try {
    await sess.rebuild();
  } catch (e) {
    new Notice(`Ошибка разбора: ${e.message}`);
  }
  view.busy = null;
  view.render();
}

function renderRaw(ctx, el, composed) {
  const { sess, view } = ctx;
  if (el.querySelector('textarea.mi-raw') && document.activeElement === el.querySelector('textarea.mi-raw')) return;
  el.empty();
  if (sess.rawOverride !== null) {
    const banner = D.div(el, 'mi-banner');
    D.icon(banner, 'pencil');
    banner.createSpan({ text: 'Текст изменён вручную — переключатели и конструктор не применяются.' });
    D.button(banner, {
      text: 'Сбросить правку',
      cls: 'mi-btn-link',
      onClick: () => {
        sess.rawOverride = null;
        view.render();
      },
    });
  }
  const ta = el.createEl('textarea', { cls: 'mi-raw' });
  ta.value = composed.md;
  ta.spellcheck = false;
  ta.addEventListener('input', () => {
    sess.rawOverride = ta.value;
    const stats = sess.stats(ta.value, sess.activeBlocks());
    updateStrip(ctx, stats);
  });
  D.div(el, 'mi-note', 'mi-asset://… — временные ссылки на вложения; при создании заметки они заменятся на ![[файлы]] в хранилище.');
}

async function renderPreview(ctx, el, composed) {
  const { sess, view } = ctx;
  const scrollTop = el.scrollTop;
  el.empty();
  let md = composed.md;
  if (sess.options.mode === 'flat') {
    const fm = /^---\n[\s\S]*?\n---\n/.exec(md);
    if (fm) renderFrontmatterCard(el, fm[0]);
    D.el(el, 'pre', 'mi-flat', fm ? md.slice(fm[0].length).trim() : md);
    el.scrollTop = scrollTop;
    return;
  }
  const fm = /^---\n[\s\S]*?\n---\n/.exec(md);
  if (fm) {
    renderFrontmatterCard(el, fm[0]);
    md = md.slice(fm[0].length);
  }
  D.el(el, 'h1', 'mi-preview-title', sess.title);
  const target = D.div(el, 'mi-md markdown-rendered markdown-preview-view');
  if (view.previewComponent) view.removeChild(view.previewComponent);
  const comp = new Component();
  view.previewComponent = comp;
  view.addChild(comp);
  const resolved = sess.assets.resolveForPreview(md);
  try {
    if (MarkdownRenderer.render) await MarkdownRenderer.render(view.app, resolved, target, '', comp);
    else await MarkdownRenderer.renderMarkdown(resolved, target, '', comp);
  } catch (e) {
    D.el(target, 'pre', '', resolved);
  }
  el.scrollTop = scrollTop;
}

function renderFrontmatterCard(el, fmText) {
  const card = D.div(el, 'mi-fm-card');
  const head = D.div(card, 'mi-fm-head');
  head.createSpan({ cls: 'mi-dot' });
  D.el(head, 'span', 'mi-label mi-accent', 'YAML FRONTMATTER');
  const lines = fmText.replace(/^---\n|\n---\n?$/g, '').split('\n');
  let current = null;
  for (const line of lines) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) {
      const row = D.div(card, 'mi-fm-row');
      D.el(row, 'span', 'mi-fm-key', `${m[1]}:`);
      current = D.el(row, 'span', 'mi-fm-val', m[2].replace(/^"|"$/g, ''));
      if (!m[2]) current.addClass('mi-fm-list');
    } else if (/^\s+-\s+/.test(line) && current) {
      D.chip(current, `#${line.replace(/^\s+-\s+/, '').replace(/^"|"$/g, '')}`, 'mi-chip-tag');
    }
  }
}

function renderBlockList(ctx, el) {
  const { sess } = ctx;
  const scrollTop = el.scrollTop;
  el.empty();
  // фильтры по типам
  const counts = {};
  for (const b of sess.blocks) counts[b.type] = (counts[b.type] || 0) + 1;
  const filters = D.div(el, 'mi-type-filters');
  for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const ids = sess.blocks.filter((b) => b.type === type).map((b) => b.id);
    const on = ids.filter((id) => !sess.disabled.has(id)).length;
    const chipEl = filters.createEl('button', { cls: 'mi-type-chip' + (on === 0 ? ' is-off' : on < ids.length ? ' is-partial' : '') });
    D.icon(chipEl, BLOCK_ICONS[type] || 'square');
    chipEl.createSpan({ text: `${BLOCK_LABELS[type] || type}` });
    chipEl.createSpan({ cls: 'mi-type-count', text: `${on}/${n}` });
    chipEl.setAttr('aria-label', on ? 'Выключить все блоки этого типа' : 'Включить все блоки этого типа');
    chipEl.addEventListener('click', () => {
      if (on) ids.forEach((id) => sess.disabled.add(id));
      else ids.forEach((id) => sess.disabled.delete(id));
      refresh(ctx);
    });
  }

  const list = D.div(el, 'mi-block-list');
  let dragId = null;
  let lastGroup = null;
  sess.order.forEach((id, idx) => {
    const b = sess.blockById(id);
    if (!b) return;
    if (sess.hasGroups && b.group !== lastGroup) {
      lastGroup = b.group;
      const gm = sess.groupMeta[b.group];
      if (gm) {
        const gIds = sess.blocks.filter((x) => x.group === b.group).map((x) => x.id);
        const gOn = gIds.some((x) => !sess.disabled.has(x));
        const gh = D.div(list, 'mi-group-head');
        const cb = gh.createEl('input', { type: 'checkbox' });
        cb.checked = gOn;
        cb.addEventListener('change', () => {
          gIds.forEach((x) => (cb.checked ? sess.disabled.delete(x) : sess.disabled.add(x)));
          refresh(ctx);
        });
        D.el(gh, 'span', 'mi-group-title', gm.title);
        if (gm.published) D.el(gh, 'span', 'mi-group-date', U.humanDate(gm.published));
      }
    }
    const row = D.div(list, 'mi-block' + (sess.disabled.has(id) ? ' is-off' : ''));
    row.draggable = true;
    row.dataset.id = id;
    D.icon(row, 'grip-vertical', 'mi-icon mi-grip');
    const cb = row.createEl('input', { type: 'checkbox', cls: 'mi-block-cb' });
    cb.checked = !sess.disabled.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) sess.disabled.delete(id);
      else sess.disabled.add(id);
      refresh(ctx);
    });
    const badge = D.div(row, `mi-block-badge t-${b.type}`);
    D.icon(badge, BLOCK_ICONS[b.type] || 'square');
    badge.createSpan({ text: b.type === 'heading' ? `H${b.level}` : (BLOCK_LABELS[b.type] || b.type).split(' ')[0] });
    const txt = D.div(row, 'mi-block-text');
    D.div(txt, 'mi-block-snippet', U.firstLine(b.text || U.stripMarkdown(b.md), 160) || '—');
    const meta = [];
    if (b.page) meta.push(`стр. ${b.page}`);
    if (b.lang) meta.push(b.lang);
    if (b.caption) meta.push('подпись');
    meta.push(`${U.formatNumber(U.countWords(b.text || ''))} сл.`);
    D.div(txt, 'mi-block-meta', meta.join(' · '));
    const btns = D.div(row, 'mi-block-btns');
    D.button(btns, {
      icon: 'chevron-up',
      cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs',
      title: 'Выше',
      disabled: idx === 0,
      onClick: () => move(ctx, idx, idx - 1),
    });
    D.button(btns, {
      icon: 'chevron-down',
      cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs',
      title: 'Ниже',
      disabled: idx === sess.order.length - 1,
      onClick: () => move(ctx, idx, idx + 1),
    });
    row.addEventListener('dragstart', (e) => {
      dragId = id;
      row.addClass('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    row.addEventListener('dragend', () => row.removeClass('is-dragging'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      row.toggleClass('drop-before', !after);
      row.toggleClass('drop-after', after);
    });
    row.addEventListener('dragleave', () => {
      row.removeClass('drop-before');
      row.removeClass('drop-after');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = row.hasClass('drop-after');
      row.removeClass('drop-before');
      row.removeClass('drop-after');
      if (!dragId || dragId === id) return;
      const from = sess.order.indexOf(dragId);
      sess.order.splice(from, 1);
      let to = sess.order.indexOf(id);
      if (after) to++;
      sess.order.splice(to, 0, dragId);
      refresh(ctx);
    });
  });
  el.scrollTop = scrollTop;
}

function move(ctx, from, to) {
  const order = ctx.sess.order;
  if (to < 0 || to >= order.length) return;
  const [x] = order.splice(from, 1);
  order.splice(to, 0, x);
  refresh(ctx);
}

// ───────────── футер ─────────────

function renderFooter(ctx, root) {
  const { view, sess } = ctx;
  const o = sess.options;
  const card = D.div(root, 'mi-card mi-builder-foot');
  const row = D.div(card, 'mi-foot-checks');
  const opt = (key, label, rebuildNeeded) =>
    D.checkbox(row, {
      label,
      checked: o[key],
      onChange: async (v) => {
        o[key] = v;
        if (rebuildNeeded || sess.needsRebuild(key)) await rebuild(ctx);
        else if (key === 'split') view.render();
        else refresh(ctx);
      },
    });
  opt('frontmatter', 'Генерировать YAML Frontmatter');
  opt('autoWikilinks', 'Автоматические [[Wikilinks]]');
  opt('latex', 'Конвертировать LaTeX в $$');
  if (sess.kind === 'pdf') opt('saveOriginalPdf', 'Сохранять исходный PDF в attachments/');
  if (sess.hasGroups) opt('split', 'Каждый пост — отдельной заметкой');

  const parse = D.div(card, 'mi-foot-parse');
  D.el(parse, 'span', 'mi-label', 'Разбор:');
  const toggle = (key, label) => {
    const b = parse.createEl('button', { cls: 'mi-toggle-chip' + (o[key] ? ' is-on' : '') });
    const i = b.createSpan({ cls: 'mi-icon' });
    setIcon(i, o[key] ? 'check' : 'plus');
    b.createSpan({ text: label });
    b.addEventListener('click', async () => {
      o[key] = !o[key];
      await rebuild(ctx);
    });
  };
  toggle('tablesMarkdown', 'Таблицы → MD');
  toggle('callouts', 'Callouts');
  toggle('preserveStyles', 'Оформление (HTML)');
  if (sess.kind === 'pdf') {
    toggle('removeHeaders', 'Без колонтитулов');
    toggle('extractImages', 'Иллюстрации');
    toggle('pageImages', 'Страницы картинками');
  }
  if (sess.kind === 'web') {
    const b = parse.createEl('button', { cls: 'mi-toggle-chip' + (o.extraction === 'full' ? ' is-on' : '') });
    const i = b.createSpan({ cls: 'mi-icon' });
    setIcon(i, o.extraction === 'full' ? 'check' : 'plus');
    b.createSpan({ text: 'Вся страница' });
    b.addEventListener('click', async () => {
      o.extraction = o.extraction === 'full' ? 'auto' : 'full';
      await rebuild(ctx);
    });
  }

  const bottom = D.div(card, 'mi-foot-bottom');
  D.div(bottom, 'mi-topbar-spacer');
  D.el(bottom, 'span', 'mi-kbd-hint', 'Ctrl + Enter — быстрый импорт');
  D.button(bottom, {
    icon: 'settings-2',
    text: 'Настройки парсера',
    cls: 'mi-btn-outline',
    onClick: () => {
      view.ui.settingsSection = 'parse';
      view.switchTab('settings');
    },
  });
  void refreshDebounced;
}

module.exports = { renderBuilder };
