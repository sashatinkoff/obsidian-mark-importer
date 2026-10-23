'use strict';

/** Вкладка «Статистика и журнал» (макет «Статистика импорта и журнал хранилища»). */

const { Notice, TFile, Menu } = require('obsidian');
const D = require('./dom');
const U = require('../util');
const { SOURCE_LABELS, BLOCK_LABELS, BLOCK_ICONS } = require('../constants');

const TYPE_ICONS = { pdf: 'file-type-2', web: 'globe', telegram: 'send', clipboard: 'clipboard-paste', docx: 'file-text', text: 'file', markdown: 'file-pen', html: 'file-code' };
const CHANNEL_COLORS = ['var(--mi-accent)', 'var(--mi-cyan)', 'var(--mi-amber)', 'var(--mi-violet)', 'var(--mi-rose)'];

function renderStats(view, root) {
  const st = view.statsState;
  const journal = view.core.journal;
  const agg = journal.aggregate(st.range);

  D.div(root, 'mi-glow mi-glow-wide').setAttr('aria-hidden', 'true');

  // шапка
  const head = D.div(root, 'mi-stats-head');
  const left = D.div(head, 'mi-stats-titles');
  const crumbs = D.div(left, 'mi-crumbs');
  D.chip(crumbs, 'ЖУРНАЛ И ТЕЛЕМЕТРИЯ', 'mi-chip-mono mi-chip-accent');
  D.el(crumbs, 'span', 'mi-label', `/ ${view.app.vault.getName()}`);
  crumbs.createSpan({ cls: 'mi-dot' });
  D.el(left, 'h1', 'mi-h1', 'Статистика импорта и журнал хранилища');
  D.el(left, 'p', 'mi-sub', 'Сводка по преобразованию источников в Markdown: PDF, сайты, Telegram, документы и буфер обмена.');
  const right = D.div(head, 'mi-stats-actions');
  D.button(right, { icon: 'refresh-cw', text: 'Обновить', cls: 'mi-btn-outline', onClick: () => view.render() });
  D.button(right, {
    icon: 'download',
    text: 'Экспорт журнала',
    cls: 'mi-btn-primary',
    onClick: (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('CSV в буфер обмена').setIcon('table').onClick(() => copy(journal.toCsv(), 'CSV скопирован')));
      menu.addItem((i) => i.setTitle('Заметка-журнал в хранилище').setIcon('file-plus').onClick(() => exportNote(view)));
      menu.showAtMouseEvent(e);
    },
  });

  if (!agg.total) {
    const empty = D.div(root, 'mi-card mi-empty');
    const ic = D.div(empty, 'mi-icon-box mi-icon-box-lg');
    D.icon(ic, 'bar-chart-3');
    D.el(empty, 'h3', 'mi-h3', 'Журнал пока пуст');
    D.el(empty, 'p', 'mi-sub', 'После первого импорта здесь появятся счётчики, график по дням, распределение блоков и история заметок.');
    D.button(empty, { icon: 'download', text: 'Импортировать', cls: 'mi-btn-primary', onClick: () => view.switchTab('sources') });
    return;
  }

  // карточки
  const cards = D.div(root, 'mi-kpis');
  const kpi = (iconName, badge, value, label, footL, footR, extra) => {
    const c = D.div(cards, 'mi-card mi-kpi');
    const top = D.div(c, 'mi-kpi-top');
    const ib = D.div(top, 'mi-icon-box');
    D.icon(ib, iconName);
    if (badge) D.chip(top, badge, 'mi-chip-mono' + (badge.startsWith('+') ? ' mi-chip-accent' : ''));
    const v = D.div(c, 'mi-kpi-value');
    if (typeof value === 'function') value(v);
    else v.setText(value);
    D.div(c, 'mi-kpi-label', label);
    if (extra) extra(c);
    if (footL) {
      const f = D.div(c, 'mi-kpi-foot');
      D.el(f, 'span', '', footL);
      D.el(f, 'span', 'mi-accent', footR);
    }
  };
  kpi('file-text', `+${agg.lastWeek} за неделю`, U.formatNumber(agg.total), 'Всего импортировано заметок', 'Блоков всего', U.formatNumber(agg.blocks));
  kpi('book-open', agg.pdfPages ? `${U.formatNumber(agg.pdfPages)} стр. PDF` : null, U.formatNumber(agg.words), 'Обработано слов', 'Средняя длина заметки', `${U.formatNumber(agg.avgWords)} слов`);
  kpi(
    'zap',
    'оценка',
    agg.hours >= 1 ? `~${agg.hours.toFixed(1).replace('.', ',')} ч` : `~${Math.round(agg.hours * 60)} мин`,
    'Экономия времени на вёрстке',
    'Норма ручного переноса',
    '40 слов/мин'
  );
  const types = Object.entries(agg.byType).sort((a, b) => b[1] - a[1]);
  const topType = types[0];
  kpi(
    'pie-chart',
    `${types.length} ${U.plural(types.length, 'канал', 'канала', 'каналов')} данных`,
    (v) => {
      v.appendText(`${Math.round((topType[1] / agg.total) * 100)}%`);
      D.el(v, 'span', 'mi-kpi-unit', ` ${SOURCE_LABELS[topType[0]] || topType[0]}`);
    },
    'Основной источник',
    null,
    null,
    (c) => {
      const bar = D.div(c, 'mi-tri-bar');
      types.forEach(([, n], i) => {
        const seg = D.div(bar, 'mi-tri-seg');
        seg.style.flex = String(n);
        seg.style.background = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
      });
      const legend = D.div(c, 'mi-legend');
      types.slice(0, 4).forEach(([t, n], i) => {
        const l = D.div(legend, 'mi-legend-item');
        const dot = l.createSpan({ cls: 'mi-legend-dot' });
        dot.style.background = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
        l.createSpan({ text: `${Math.round((n / agg.total) * 100)}% ${SOURCE_LABELS[t] || t}` });
      });
    }
  );

  // график + структура
  const grid = D.div(root, 'mi-stats-grid');
  const chartCard = D.div(grid, 'mi-card mi-chart-card');
  const ch = D.div(chartCard, 'mi-chart-head');
  const cht = D.div(ch, '');
  D.div(cht, 'mi-label mi-accent', 'ОБЪЁМ ПОТОКА');
  D.el(cht, 'h3', 'mi-h3', `Динамика импорта по дням${st.range ? ` за ${st.range} дн.` : ''}`);
  D.segmented(ch, {
    cls: 'mi-seg-sm',
    options: [
      { value: 30, label: '30 дней' },
      { value: 14, label: '14 дней' },
      { value: 0, label: 'Всё время' },
    ],
    value: st.range,
    onChange: (v) => {
      st.range = v;
      view.render();
    },
  });
  drawChart(D.div(chartCard, 'mi-chart'), agg.series);
  const peak = agg.series.reduce((m, p) => (p.notes > (m ? m.notes : 0) ? p : m), null);
  const cf = D.div(chartCard, 'mi-chart-foot');
  D.el(cf, 'span', '', U.humanDate(agg.series[0].date, false));
  if (peak) {
    const pk = D.el(cf, 'span', 'mi-accent');
    pk.createSpan({ cls: 'mi-dot' });
    pk.appendText(` Пик: ${U.humanDate(peak.date, false)} (${peak.notes} ${U.plural(peak.notes, 'заметка', 'заметки', 'заметок')} / ${peak.blocks} блоков)`);
  }
  D.el(cf, 'span', '', `${U.humanDate(new Date(), false)} (сегодня)`);

  const side = D.div(grid, 'mi-stats-side');
  const struct = D.div(side, 'mi-card');
  const sh = D.div(struct, 'mi-chart-head');
  const sht = D.div(sh, '');
  D.div(sht, 'mi-label mi-accent', 'СТРУКТУРА ДАННЫХ');
  D.el(sht, 'h3', 'mi-h3', 'Распределение типов блоков');
  D.icon(sh, 'braces', 'mi-icon mi-accent');
  const totalBlocks = Object.values(agg.blockTypes).reduce((a, b) => a + b, 0) || 1;
  for (const [type, n] of Object.entries(agg.blockTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)) {
    const row = D.div(struct, 'mi-dist-row');
    const rl = D.div(row, 'mi-dist-label');
    D.icon(rl, BLOCK_ICONS[type] || 'square');
    rl.createSpan({ text: BLOCK_LABELS[type] || type });
    D.el(row, 'span', 'mi-dist-val', `${Math.round((n / totalBlocks) * 100)}% (${U.formatNumber(n)})`);
    const bar = D.div(row, 'mi-dist-bar');
    D.div(bar, 'mi-dist-fill').style.width = `${Math.max(2, (n / totalBlocks) * 100)}%`;
  }

  const tagsCard = D.div(side, 'mi-card');
  const th = D.div(tagsCard, 'mi-chart-head');
  const tht = D.div(th, '');
  D.div(tht, 'mi-label mi-accent', 'ТАКСОНОМИЯ');
  D.el(tht, 'h3', 'mi-h3', 'Популярные теги импорта');
  const tagList = Object.entries(agg.tags).sort((a, b) => b[1] - a[1]);
  D.chip(th, `${tagList.length} активных`, 'mi-chip-mono');
  const tagsWrap = D.div(tagsCard, 'mi-tags');
  for (const [t, n] of tagList.slice(0, 12)) {
    const c = tagsWrap.createEl('button', { cls: 'mi-tag' });
    c.createSpan({ text: `# ${t}` });
    c.createSpan({ cls: 'mi-tag-count', text: String(n) });
    c.addEventListener('click', () => {
      st.query = t;
      st.page = 1;
      view.render();
    });
  }

  renderJournal(view, root);
}

function drawChart(el, series) {
  const W = 640;
  const H = 260;
  const pad = { l: 8, r: 8, t: 16, b: 10 };
  const max = Math.max(1, ...series.map((p) => p.notes));
  const n = series.length;
  const step = (W - pad.l - pad.r) / n;
  const bw = Math.max(2, step * 0.55);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'mi-chart-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML =
    '<linearGradient id="mi-bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--mi-accent)" stop-opacity="0.9"/><stop offset="1" stop-color="var(--mi-accent)" stop-opacity="0.15"/></linearGradient>';
  svg.appendChild(defs);
  for (let i = 1; i <= 3; i++) {
    const g = document.createElementNS(ns, 'line');
    const gy = pad.t + ((H - pad.t - pad.b) * i) / 4;
    g.setAttribute('x1', pad.l);
    g.setAttribute('x2', W - pad.r);
    g.setAttribute('y1', gy);
    g.setAttribute('y2', gy);
    g.setAttribute('class', 'mi-grid-line');
    svg.appendChild(g);
  }
  const pts = [];
  series.forEach((p, i) => {
    const x = pad.l + step * i + (step - bw) / 2;
    const r = document.createElementNS(ns, 'rect');
    const top = y(p.notes);
    r.setAttribute('x', x);
    r.setAttribute('y', p.notes ? top : H - pad.b - 2);
    r.setAttribute('width', bw);
    r.setAttribute('height', p.notes ? H - pad.b - top : 2);
    r.setAttribute('rx', Math.min(3, bw / 2));
    r.setAttribute('class', p.notes ? 'mi-bar' : 'mi-bar-empty');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${U.humanDate(p.date, false)}: ${p.notes} заметок, ${p.blocks} блоков`;
    r.appendChild(title);
    svg.appendChild(r);
    pts.push([x + bw / 2, y(p.notes)]);
  });
  // сглаженная линия (скользящее среднее по 3 дням)
  const smooth = pts.map((pt, i) => {
    const a = pts[Math.max(0, i - 1)][1];
    const b = pt[1];
    const c = pts[Math.min(pts.length - 1, i + 1)][1];
    return [pt[0], (a + b * 2 + c) / 4];
  });
  if (smooth.length > 1) {
    let d = `M${smooth[0][0]},${smooth[0][1]}`;
    for (let i = 1; i < smooth.length; i++) {
      const [x0, y0] = smooth[i - 1];
      const [x1, y1] = smooth[i];
      const cx = (x0 + x1) / 2;
      d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'mi-line');
    svg.appendChild(path);
    const last = smooth[smooth.length - 1];
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', last[0]);
    dot.setAttribute('cy', last[1]);
    dot.setAttribute('r', 4);
    dot.setAttribute('class', 'mi-line-dot');
    svg.appendChild(dot);
  }
  el.appendChild(svg);
}

function renderJournal(view, root) {
  const st = view.statsState;
  const journal = view.core.journal;
  const card = D.div(root, 'mi-card mi-journal');
  const head = D.div(card, 'mi-journal-head');
  const hl = D.div(head, 'mi-journal-title');
  const ib = D.div(hl, 'mi-icon-box');
  D.icon(ib, 'history');
  const ht = D.div(hl, '');
  D.el(ht, 'h3', 'mi-h3', 'Журнал недавних импортов');
  D.el(ht, 'p', 'mi-sub', 'Летопись разобранных материалов и путей в хранилище');
  const controls = D.div(head, 'mi-journal-controls');
  const search = D.div(controls, 'mi-input-wrap mi-search');
  D.icon(search, 'search');
  const input = search.createEl('input', { type: 'text', cls: 'mi-input', placeholder: 'Поиск по названию, пути или тегу…' });
  input.value = st.query;
  input.addEventListener(
    'input',
    U.debounce(() => {
      st.query = input.value;
      st.page = 1;
      const pos = input.selectionStart;
      view.render();
      const again = view.contentEl.querySelector('.mi-search input');
      if (again) {
        again.focus();
        again.setSelectionRange(pos, pos);
      }
    }, 250)
  );
  const present = [...new Set(journal.entries.map((e) => e.type))];
  D.segmented(controls, {
    cls: 'mi-seg-sm',
    options: [{ value: 'all', label: 'Все' }, ...present.map((t) => ({ value: t, label: SOURCE_LABELS[t] || t }))],
    value: st.filter,
    onChange: (v) => {
      st.filter = v;
      st.page = 1;
      view.render();
    },
  });

  const q = st.query.trim().toLowerCase();
  const rows = journal.entries.filter(
    (e) =>
      (st.filter === 'all' || e.type === st.filter) &&
      (!q || `${e.title} ${e.path} ${e.source} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q))
  );

  const table = D.div(card, 'mi-table');
  const hdr = D.div(table, 'mi-tr mi-th');
  ['Исходный документ', 'Тип и размер', 'Блоков', 'Статус в хранилище', 'Дата импорта', ''].forEach((t) => D.div(hdr, 'mi-td', t));
  const pages = Math.max(1, Math.ceil(rows.length / st.perPage));
  st.page = Math.min(st.page, pages);
  const slice = rows.slice((st.page - 1) * st.perPage, st.page * st.perPage);
  if (!slice.length) D.div(table, 'mi-tr mi-tr-empty', 'Ничего не найдено');
  for (const e of slice) {
    const tr = D.div(table, 'mi-tr');
    const c1 = D.div(tr, 'mi-td mi-doc');
    const ic = D.div(c1, `mi-icon-box mi-icon-box-sm t-${e.type}`);
    D.icon(ic, TYPE_ICONS[e.type] || 'file');
    const dt = D.div(c1, '');
    D.div(dt, 'mi-doc-title', e.title);
    const sub = D.div(dt, 'mi-doc-sub');
    D.el(sub, 'span', 'mi-accent', (e.tags || []).slice(0, 3).map((t) => `#${t}`).join(' '));
    if (e.source) D.el(sub, 'span', '', ` · ${shortSource(e.source)}`);
    const c2 = D.div(tr, 'mi-td');
    D.chip(c2, SOURCE_LABELS[e.type] || e.type, `mi-chip-mono t-${e.type}`);
    D.el(c2, 'span', 'mi-td-sub', e.type === 'pdf' && e.pages ? ` ${e.pages} стр.` : ` ${U.formatBytes(e.size)}`);
    const c3 = D.div(tr, 'mi-td');
    D.el(c3, 'span', 'mi-accent', String(e.blocks || 0));
    D.el(c3, 'span', 'mi-td-sub', ` ${U.plural(e.blocks || 0, 'блок', 'блока', 'блоков')}`);
    const c4 = D.div(tr, 'mi-td mi-status-cell');
    const exists = view.app.vault.getAbstractFileByPath(e.path) instanceof TFile;
    const dot = c4.createSpan({ cls: `mi-dot ${!exists ? 'is-missing' : e.status === 'ok' ? '' : 'is-warn'}` });
    void dot;
    const sc = D.div(c4, '');
    const link = D.el(sc, 'a', 'mi-path', `/${e.path}`);
    link.addEventListener('click', () => openPath(view, e.path));
    D.div(
      sc,
      'mi-td-sub',
      !exists
        ? 'Заметка удалена или перемещена'
        : e.status === 'partial'
        ? `Частичный импорт: ${e.excluded} блоков отфильтровано`
        : e.status === 'edited'
        ? 'Отредактировано вручную перед созданием'
        : `Синхронизировано${e.images ? ` · ${e.images} вложений` : ''}`
    );
    D.div(tr, 'mi-td mi-td-date', U.humanDate(e.date));
    const c6 = D.div(tr, 'mi-td mi-td-actions');
    D.button(c6, {
      icon: 'more-horizontal',
      cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs',
      onClick: (evt) => {
        const menu = new Menu();
        if (exists) menu.addItem((i) => i.setTitle('Открыть заметку').setIcon('file').onClick(() => openPath(view, e.path)));
        if (/^https?:/.test(e.source)) {
          menu.addItem((i) => i.setTitle('Открыть источник').setIcon('external-link').onClick(() => window.open(e.source)));
          menu.addItem((i) =>
            i
              .setTitle('Импортировать заново')
              .setIcon('refresh-cw')
              .onClick(() => (e.type === 'telegram' ? view.importTelegram(e.source) : view.importUrl(e.source)))
          );
        }
        menu.addItem((i) =>
          i
            .setTitle('Удалить из журнала')
            .setIcon('trash-2')
            .onClick(async () => {
              await journal.remove(e.id);
              view.render();
            })
        );
        menu.showAtMouseEvent(evt);
      },
    });
  }

  const foot = D.div(card, 'mi-journal-foot');
  D.el(foot, 'span', 'mi-label', `Показано ${slice.length} из ${rows.length} ${U.plural(rows.length, 'записи', 'записей', 'записей')}`);
  D.el(foot, 'span', 'mi-label mi-sep', '|');
  D.el(foot, 'span', 'mi-label', 'Строк на странице:');
  const sel = foot.createEl('select', { cls: 'dropdown mi-per-page' });
  for (const n of [10, 25, 50]) {
    const o = sel.createEl('option', { text: String(n), value: String(n) });
    if (n === st.perPage) o.selected = true;
  }
  sel.addEventListener('change', () => {
    st.perPage = +sel.value;
    st.page = 1;
    view.render();
  });
  D.div(foot, 'mi-topbar-spacer');
  const pager = D.div(foot, 'mi-pager');
  D.button(pager, { icon: 'chevron-left', cls: 'mi-btn-ghost mi-btn-icon', disabled: st.page <= 1, onClick: () => ((st.page -= 1), view.render()) });
  for (const p of pageList(st.page, pages)) {
    if (p === '…') D.el(pager, 'span', 'mi-label', '…');
    else
      D.button(pager, {
        text: String(p),
        cls: 'mi-page-btn' + (p === st.page ? ' is-active' : ''),
        onClick: () => ((st.page = p), view.render()),
      });
  }
  D.button(pager, { icon: 'chevron-right', cls: 'mi-btn-ghost mi-btn-icon', disabled: st.page >= pages, onClick: () => ((st.page += 1), view.render()) });
}

function pageList(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set([1, 2, cur - 1, cur, cur + 1, total - 1, total].filter((p) => p >= 1 && p <= total));
  const arr = [...set].sort((a, b) => a - b);
  const out = [];
  arr.forEach((p, i) => {
    if (i && p - arr[i - 1] > 1) out.push('…');
    out.push(p);
  });
  return out;
}

function shortSource(s) {
  try {
    if (/^https?:/.test(s)) {
      const u = new URL(s);
      return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname.slice(0, 24) + (u.pathname.length > 24 ? '…' : '') : '');
    }
  } catch (e) {
    /* ignore */
  }
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

async function openPath(view, path) {
  const f = view.app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) await view.app.workspace.getLeaf('tab').openFile(f);
  else new Notice('Заметка не найдена');
}

async function copy(text, msg) {
  await navigator.clipboard.writeText(text);
  new Notice(msg);
}

async function exportNote(view) {
  const entries = view.core.journal.entries;
  const lines = [
    '| Дата | Заметка | Тип | Источник | Слов | Блоков |',
    '| --- | --- | --- | --- | ---: | ---: |',
    ...entries.map(
      (e) =>
        `| ${U.isoLocal(new Date(e.date)).slice(0, 16).replace('T', ' ')} | [[${e.path.replace(/\.md$/, '')}\\|${e.title.replace(/\|/g, '/')}]] | ${SOURCE_LABELS[e.type] || e.type} | ${
          /^https?:/.test(e.source) ? `[ссылка](${e.source})` : (e.source || '').replace(/\|/g, '/')
        } | ${e.words || 0} | ${e.blocks || 0} |`
    ),
  ];
  const folder = view.core.settings.folder || '';
  await U.ensureFolder(view.app, folder);
  const path = U.availablePath(view.app, folder, `Журнал импорта ${U.dateKey(new Date())}`, 'md');
  const file = await view.app.vault.create(path, `# Журнал импорта MarkImporter\n\n${lines.join('\n')}\n`);
  await view.app.workspace.getLeaf('tab').openFile(file);
}

module.exports = { renderStats };
