'use strict';

/** Вкладка «Источники и импорт» (макет «Импорт источников PDF/TXT»). */

const { Notice } = require('obsidian');
const D = require('./dom');
const U = require('../util');
const { VERSION } = require('../constants');
const { ACCEPT } = require('../sources/file');

const MODES = [
  { value: 'file', label: 'Файл', hint: 'PDF, DOCX, TXT, HTML', icon: 'file-text' },
  { value: 'url', label: 'Ссылка', hint: 'сайт или PDF', icon: 'globe' },
  { value: 'telegram', label: 'Telegram', hint: 'пост или канал', icon: 'send' },
  { value: 'clipboard', label: 'Буфер обмена', hint: 'Ctrl/Cmd+V', icon: 'clipboard-paste' },
];

const FILE_ICONS = { pdf: 'file-type-2', docx: 'file-text', html: 'file-code', htm: 'file-code', md: 'file-pen', txt: 'file' };

function renderSources(view, root) {
  const src = view.src;
  const glow = D.div(root, 'mi-glow');
  glow.setAttr('aria-hidden', 'true');

  const card = D.div(root, 'mi-card mi-import-card');

  // шапка
  const head = D.div(card, 'mi-card-head');
  const hIcon = D.div(head, 'mi-icon-box');
  D.icon(hIcon, 'download');
  const hText = D.div(head, 'mi-card-titles');
  const titleRow = D.div(hText, 'mi-title-row');
  D.el(titleRow, 'h2', 'mi-h2', 'Импорт источников в Markdown');
  D.chip(titleRow, `MARKIMPORTER V${VERSION}`, 'mi-chip-mono');
  D.el(hText, 'p', 'mi-sub', 'Загрузите файл (PDF, DOCX, TXT), укажите ссылку на статью или пост Telegram, или вставьте содержимое из буфера — заметка сохранит вёрстку оригинала.');
  if (view.session) {
    D.button(head, {
      icon: 'arrow-right',
      cls: 'mi-btn-ghost mi-btn-icon',
      title: 'Вернуться к текущему разбору',
      onClick: () => view.switchTab('builder'),
    });
  }

  D.segmented(card, {
    cls: 'mi-source-seg',
    options: MODES,
    value: src.mode,
    onChange: (m) => {
      src.mode = m;
      view.render();
    },
  });

  const bodyEl = D.div(card, 'mi-source-body');
  if (src.mode === 'file') renderFileMode(view, bodyEl);
  else if (src.mode === 'url') renderUrlMode(view, bodyEl);
  else if (src.mode === 'telegram') renderTelegramMode(view, bodyEl);
  else renderClipboardMode(view, bodyEl);

  if (view.lastError) {
    const err = D.div(card, 'mi-error');
    D.icon(err, 'alert-triangle');
    err.createSpan({ text: view.lastError });
  }

  renderParams(view, card);

  // футер
  const foot = D.div(card, 'mi-card-foot');
  D.button(foot, {
    icon: 'rotate-ccw',
    text: 'Сбросить параметры',
    cls: 'mi-btn-link',
    onClick: () => {
      view.pendingOptions = view.defaultOptions();
      view.render();
    },
  });
  D.button(foot, {
    text: 'Отмена',
    cls: 'mi-btn-link',
    onClick: () => {
      src.file = null;
      src.url = '';
      src.tg = '';
      src.clip = null;
      view.lastError = '';
      view.render();
    },
  });
  D.div(foot, 'mi-topbar-spacer');
  const go = D.button(foot, {
    icon: 'zap',
    text: 'Разобрать и перейти в Конструктор',
    cls: 'mi-btn-primary mi-btn-lg',
    onClick: () => view.startFromSources(),
    disabled: !!view.busy,
  });
  D.icon(go, 'arrow-right');

  if (view.busy) {
    const ov = D.div(card, 'mi-busy');
    const box = D.div(ov, 'mi-busy-box');
    D.div(box, 'mi-spinner');
    D.div(box, 'mi-progress-label', view.busy.label);
    const bar = D.div(box, 'mi-progress');
    const fill = D.div(bar, 'mi-progress-fill');
    fill.style.width = `${Math.round((view.busy.progress || 0) * 100)}%`;
  }

  D.div(root, 'mi-hint-line', 'Подсказка: Ctrl/Cmd+V в этом окне — импорт из буфера, Ctrl/Cmd+Enter — разобрать. Закладка для браузера — в настройках плагина.');
}

// ───────────── режимы ─────────────

function renderFileMode(view, body) {
  const src = view.src;
  const input = body.createEl('input', { type: 'file', cls: 'mi-hidden' });
  input.accept = ACCEPT;
  const pick = async (file) => {
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) return new Notice('Файл больше 200 МБ');
    src.file = { name: file.name, size: file.size, buffer: await file.arrayBuffer() };
    view.lastError = '';
    view.render();
  };
  input.addEventListener('change', () => pick(input.files && input.files[0]));

  const drop = D.div(body, 'mi-drop');
  const dIcon = D.div(drop, 'mi-icon-box mi-icon-box-lg');
  D.icon(dIcon, 'upload-cloud');
  D.div(drop, 'mi-drop-title', 'Перетащите PDF, DOCX или TXT сюда, или нажмите для выбора');
  const hint = D.div(drop, 'mi-drop-hint');
  D.icon(hint, 'info');
  hint.createSpan({ text: 'Поддерживаются: PDF, DOCX, HTML, TXT, Markdown — до 200 МБ' });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.addClass('is-over');
  });
  drop.addEventListener('dragleave', () => drop.removeClass('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.removeClass('is-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pick(f);
    else {
      const text = e.dataTransfer.getData('text/plain');
      if (/^https?:\/\//.test(text)) view.importUrl(text.trim());
    }
  });

  if (src.file) {
    const f = src.file;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const card = D.div(body, 'mi-file-card');
    const ic = D.div(card, 'mi-icon-box');
    D.icon(ic, FILE_ICONS[ext] || 'file');
    const info = D.div(card, 'mi-file-info');
    D.div(info, 'mi-file-name', f.name);
    const metaRow = D.div(info, 'mi-file-meta');
    const metaItem = (v, l) => {
      const m = D.div(metaRow, 'mi-meta-item');
      D.div(m, 'mi-meta-value', v);
      D.div(m, 'mi-meta-label', l);
    };
    metaItem(U.formatBytes(f.size), 'размер');
    metaItem(ext.toUpperCase() || '—', 'формат');
    if (f.vaultPath) metaItem(f.vaultPath, 'из хранилища');
    const st = D.div(card, 'mi-status-pill');
    st.createSpan({ cls: 'mi-dot' });
    st.createSpan({ text: ext === 'pdf' ? 'Готов к разбору вёрстки и структуры' : 'Готов к разбору' });
    D.button(card, {
      icon: 'trash-2',
      cls: 'mi-btn-ghost mi-btn-icon',
      title: 'Убрать файл',
      onClick: () => {
        src.file = null;
        view.render();
      },
    });
  }

  renderQuickUrl(view, body, 'Быстрый захват по URL (сайты, arXiv, Habr, Medium, Substack, GitHub, t.me)');
}

function renderQuickUrl(view, body, label) {
  const src = view.src;
  const labelRow = D.div(body, 'mi-label-row');
  D.el(labelRow, 'span', 'mi-label', label);
  D.el(labelRow, 'span', 'mi-label mi-accent', 'READABILITY · PDF · TELEGRAM');
  const row = D.div(body, 'mi-url-row');
  const field = D.div(row, 'mi-input-wrap');
  D.icon(field, 'link');
  const input = field.createEl('input', { type: 'text', cls: 'mi-input', placeholder: 'https://arxiv.org/abs/1706.03762' });
  input.value = src.url;
  input.addEventListener('input', () => (src.url = input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (input.value.trim()) view.importUrl(input.value.trim());
    }
  });
  D.button(row, {
    icon: 'clipboard-paste',
    text: 'Вставить из буфера',
    cls: 'mi-btn-outline',
    onClick: async () => {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        input.value = t;
        src.url = t;
        if (src.mode === 'file' && /^https?:\/\//.test(t)) src.mode = 'url';
        view.render();
      } catch (e) {
        new Notice('Нет доступа к буферу — вставьте вручную');
      }
    },
  });
  return input;
}

function renderUrlMode(view, body) {
  const input = renderQuickUrl(view, body, 'Адрес страницы, статьи или PDF');
  setTimeout(() => input.focus(), 30);
  const tips = D.div(body, 'mi-tips');
  const tip = (ic, title, text) => {
    const t = D.div(tips, 'mi-tip');
    const b = D.div(t, 'mi-icon-box mi-icon-box-sm');
    D.icon(b, ic);
    const tx = D.div(t, 'mi-tip-text');
    D.div(tx, 'mi-tip-title', title);
    D.div(tx, 'mi-tip-desc', text);
  };
  tip('newspaper', 'Статьи и блоги', 'Основной контент без меню и рекламы: Habr, Medium, Substack, ЖЖ, Wikipedia, vc.ru…');
  tip('file-type-2', 'PDF по ссылке', 'arXiv, отчёты, документация — структура, таблицы, иллюстрации');
  tip('github', 'GitHub и Google Docs', 'Файлы .md берутся «сырыми», Google Docs — через экспорт HTML');
  tip('send', 'Telegram', 'Ссылка t.me/канал/123 — пост, t.me/канал — лента');
  const modeRow = D.div(body, 'mi-inline-opts');
  D.el(modeRow, 'span', 'mi-label', 'Извлечение:');
  D.segmented(modeRow, {
    cls: 'mi-seg-sm',
    options: [
      { value: 'auto', label: 'Основной контент' },
      { value: 'full', label: 'Вся страница' },
    ],
    value: view.pendingOptions.extraction,
    onChange: (v) => {
      view.pendingOptions.extraction = v;
      view.render();
    },
  });
}

function renderTelegramMode(view, body) {
  const src = view.src;
  const labelRow = D.div(body, 'mi-label-row');
  D.el(labelRow, 'span', 'mi-label', 'Пост или канал Telegram');
  D.el(labelRow, 'span', 'mi-label mi-accent', 'ПУБЛИЧНЫЕ КАНАЛЫ · БЕЗ ВХОДА');
  const row = D.div(body, 'mi-url-row');
  const field = D.div(row, 'mi-input-wrap');
  D.icon(field, 'send');
  const input = field.createEl('input', { type: 'text', cls: 'mi-input', placeholder: 'https://t.me/durov/123  ·  t.me/channel  ·  @channel' });
  input.value = src.tg;
  input.addEventListener('input', () => (src.tg = input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      view.importTelegram(input.value);
    }
  });
  setTimeout(() => input.focus(), 30);
  D.button(row, {
    icon: 'clipboard-paste',
    text: 'Из буфера',
    cls: 'mi-btn-outline',
    onClick: async () => {
      try {
        input.value = (await navigator.clipboard.readText()).trim();
        src.tg = input.value;
      } catch (e) {
        new Notice('Нет доступа к буферу');
      }
    },
  });

  const opts = D.div(body, 'mi-tg-opts');
  const countWrap = D.div(opts, 'mi-tg-count');
  D.el(countWrap, 'span', 'mi-label', 'Постов из ленты');
  const num = countWrap.createEl('input', { type: 'number', cls: 'mi-input mi-input-num' });
  num.min = '1';
  num.max = '500';
  num.value = String(src.tgCount);
  num.addEventListener('change', () => (src.tgCount = Math.max(1, Math.min(500, parseInt(num.value, 10) || 20))));
  D.checkbox(opts, {
    label: 'Каждый пост — отдельной заметкой',
    checked: src.tgSplit,
    onChange: (v) => (src.tgSplit = v),
  });
  D.div(body, 'mi-note', 'Сохраняются текст с форматированием, фото и альбомы, видео, опросы, превью ссылок, пересылки и ответы. Из буфера Telegram Desktop можно вставлять и закрытые чаты — во вкладке «Буфер обмена».');
}

function renderClipboardMode(view, body) {
  const src = view.src;
  const zone = D.div(body, 'mi-drop mi-paste-zone');
  zone.tabIndex = 0;
  const zIcon = D.div(zone, 'mi-icon-box mi-icon-box-lg');
  D.icon(zIcon, 'clipboard-paste');
  D.div(zone, 'mi-drop-title', 'Нажмите Ctrl/Cmd+V здесь — или кнопку ниже');
  const hint = D.div(zone, 'mi-drop-hint');
  D.icon(hint, 'info');
  hint.createSpan({ text: 'HTML из браузера, Telegram Desktop, Word, Google Docs; текст, Markdown, картинки' });
  setTimeout(() => zone.focus(), 30);

  const row = D.div(body, 'mi-url-row');
  D.button(row, {
    icon: 'clipboard',
    text: 'Прочитать буфер обмена',
    cls: 'mi-btn-outline',
    onClick: async () => {
      const { readClipboard } = require('../sources/clipboard');
      src.clip = await readClipboard();
      if (src.clip.empty) new Notice('Буфер пуст или нет доступа — используйте Ctrl/Cmd+V');
      view.render();
    },
  });

  if (src.clip && !src.clip.empty) {
    const c = src.clip;
    const card = D.div(body, 'mi-file-card mi-clip-card');
    const ic = D.div(card, 'mi-icon-box');
    D.icon(ic, c.html ? 'code-2' : c.images.length && !c.text ? 'image' : 'type');
    const info = D.div(card, 'mi-file-info');
    D.div(info, 'mi-file-name', U.firstLine(c.text || c.html.replace(/<[^>]+>/g, ' '), 100) || 'Изображение');
    const metaRow = D.div(info, 'mi-file-meta');
    for (const k of c.kinds) D.chip(metaRow, k, 'mi-chip-mono');
    if (c.sourceUrl) D.chip(metaRow, c.sourceUrl, 'mi-chip-mono');
    D.chip(metaRow, `${U.formatNumber(U.countWords(c.text || c.html.replace(/<[^>]+>/g, ' ')))} слов`, 'mi-chip-mono');
    const st = D.div(card, 'mi-status-pill');
    st.createSpan({ cls: 'mi-dot' });
    st.createSpan({ text: c.isUrl ? 'Ссылка — будет загружена страница' : c.html ? 'С форматированием' : 'Простой текст' });
    D.button(card, {
      icon: 'trash-2',
      cls: 'mi-btn-ghost mi-btn-icon',
      title: 'Очистить',
      onClick: () => {
        src.clip = null;
        view.render();
      },
    });
  }
}

// ───────────── параметры ─────────────

function renderParams(view, card) {
  const o = view.pendingOptions;
  const box = D.div(card, 'mi-params');
  const head = D.div(box, 'mi-label-row');
  D.el(head, 'span', 'mi-label', 'Параметры разбора и генерации для Obsidian');
  D.el(head, 'span', 'mi-label', `Папка: /${view.core.settings.folder || ''}`);
  const grid = D.div(box, 'mi-params-grid');
  const item = (key, label) =>
    D.checkbox(grid, {
      label,
      checked: o[key],
      onChange: (v) => (o[key] = v),
    });
  item('removeHeaders', 'Удалять колонтитулы, номера страниц и повторяющиеся сноски');
  item('tablesMarkdown', 'Конвертировать таблицы в Markdown Table (сложные — в HTML)');
  item('frontmatter', 'Автоматически генерировать YAML Frontmatter (теги, автор, дата)');
  D.checkbox(grid, {
    label: (el) => {
      el.appendText('Цитаты и врезки → Callouts ');
      el.createEl('code', { text: '> [!quote]' });
    },
    checked: o.callouts,
    onChange: (v) => (o.callouts = v),
  });
  D.checkbox(grid, {
    label: (el) => {
      el.appendText('Сохранять иллюстрации в хранилище ');
      el.createEl('code', { text: `/${view.core.settings.imagesFolder || 'attachments'}/` });
      el.appendText(', видео — в ');
      el.createEl('code', { text: `/${view.core.settings.videosFolder || 'attachments'}/` });
    },
    checked: o.downloadImages,
    onChange: (v) => (o.downloadImages = v),
  });
  item('preserveStyles', 'Сохранять оформление: выравнивание, цвета, подчёркивания, размеры');
  item('latex', 'Формулы KaTeX / MathJax / MathML → LaTeX $$');
  item('pageImages', 'PDF: добавить изображение каждой страницы (точная копия)');
}

module.exports = { renderSources };
