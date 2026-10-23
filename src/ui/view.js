'use strict';

/**
 * Полноэкранная вкладка MarkImporter: «Конструктор» (предпросмотр),
 * «Источники» (импорт), «Статистика и журнал».
 */

const { ItemView, Notice } = require('obsidian');
const { VIEW_TYPE, VERSION } = require('../constants');
const D = require('./dom');
const { renderSources } = require('./sourcesTab');
const { renderBuilder } = require('./builderTab');
const { renderStats } = require('./statsTab');
const { renderSettingsTab } = require('./settingsTab');
const { createFileSession } = require('../sources/file');
const { createUrlSession } = require('../sources/web');
const { createTelegramSession } = require('../sources/telegram');
const { readClipboard, readPasteEvent, createClipboardSession } = require('../sources/clipboard');
const { createNotes } = require('../save');

const TABS = [
  { id: 'builder', label: 'Конструктор и предпросмотр', icon: 'layout-panel-left' },
  { id: 'sources', label: 'Источники и импорт', icon: 'download' },
  { id: 'stats', label: 'Статистика и журнал', icon: 'bar-chart-3' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
];

class ImporterView extends ItemView {
  constructor(leaf, core) {
    super(leaf);
    this.core = core;
    this.tab = 'sources';
    this.session = null;
    this.busy = null;
    this.lastError = '';
    const s = core.settings;
    this.src = { mode: 'file', file: null, url: '', tg: '', tgCount: s.telegramCount, tgSplit: s.telegramSplit, clip: null };
    this.pendingOptions = this.defaultOptions();
    this.ui = { view: s.defaultView, resultMode: 'preview', zoom: 1, typeFilter: null, settingsSection: 'save' };
    this.statsState = { range: 30, filter: 'all', query: '', page: 1, perPage: 10 };
  }

  defaultOptions() {
    const s = this.core.settings;
    return {
      removeHeaders: s.removeHeaders,
      tablesMarkdown: s.tablesMarkdown,
      frontmatter: s.frontmatter,
      callouts: s.callouts,
      downloadImages: s.downloadImages,
      preserveStyles: s.preserveStyles,
      latex: s.latex,
      extractImages: s.pdfExtractImages,
      pageImages: s.pdfPageImages,
      extraction: s.extraction,
    };
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'MarkImporter';
  }
  getIcon() {
    return 'file-input';
  }

  async onOpen() {
    this.contentEl.addClass('mi-host');
    this.registerDomEvent(this.contentEl, 'keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (this.tab === 'builder' && this.session) this.createNote();
        else if (this.tab === 'sources') this.startFromSources();
      }
    });
    this.registerDomEvent(this.contentEl, 'paste', async (e) => {
      if (this.tab !== 'sources') return;
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      const clip = await readPasteEvent(e);
      this.src.mode = 'clipboard';
      this.src.clip = clip;
      this.render();
    });
    this.render();
  }

  async onClose() {
    if (this.session) this.session.dispose();
    this.session = null;
  }

  // ───────────── каркас ─────────────

  render() {
    const root = this.contentEl;
    const scroll = root.querySelector('.mi-body');
    const top = scroll ? scroll.scrollTop : 0;
    root.empty();
    const shell = D.div(root, 'mi-root');

    const bar = D.div(shell, 'mi-topbar');
    const brand = D.div(bar, 'mi-brand');
    D.icon(brand, 'zap', 'mi-brand-icon');
    D.el(brand, 'span', 'mi-brand-name', 'MarkImporter');
    const nav = D.div(bar, 'mi-tabs');
    for (const t of TABS) {
      const b = nav.createEl('button', { cls: 'mi-tab' + (t.id === this.tab ? ' is-active' : '') });
      D.icon(b, t.icon);
      b.createSpan({ text: t.label });
      if (t.id === 'builder' && !this.session) b.addClass('is-empty');
      b.addEventListener('click', () => this.switchTab(t.id));
    }
    D.div(bar, 'mi-topbar-spacer');

    const body = D.div(shell, 'mi-body');
    const inner = D.div(body, `mi-page mi-page-${this.tab}`);
    try {
      if (this.tab === 'sources') renderSources(this, inner);
      else if (this.tab === 'builder') renderBuilder(this, inner);
      else if (this.tab === 'settings') renderSettingsTab(this, inner);
      else renderStats(this, inner);
    } catch (err) {
      console.error('MarkImporter: ошибка интерфейса', err);
      D.div(inner, 'mi-error', `Ошибка интерфейса: ${err.message}`);
    }
    if (this.tab !== 'builder') body.scrollTop = top;

    const status = D.div(shell, 'mi-statusbar');
    D.el(status, 'span', '', `Хранилище: ${this.app.vault.getName()}`);
    D.el(status, 'span', 'mi-status-sep', '/');
    D.el(status, 'span', '', `MarkImporter v${VERSION}`);
    D.div(status, 'mi-topbar-spacer');
    const st = D.el(status, 'span', 'mi-status-state');
    st.createSpan({ cls: 'mi-dot' + (this.busy ? ' is-busy' : '') });
    st.appendText(this.busy ? ` ${this.busy.label}` : this.session ? ` Готово к созданию: «${this.session.title}»` : ' Готов к импорту');
  }

  switchTab(id) {
    this.tab = id;
    this.render();
  }

  setSourceMode(mode) {
    this.src.mode = mode;
    this.tab = 'sources';
    this.render();
  }

  updateProgress(label, frac) {
    if (!this.busy) return;
    this.busy.label = label;
    if (typeof frac === 'number') this.busy.progress = frac;
    const bar = this.contentEl.querySelector('.mi-progress-fill');
    const text = this.contentEl.querySelector('.mi-progress-label');
    if (bar) bar.style.width = `${Math.round((this.busy.progress || 0) * 100)}%`;
    if (text) text.setText(label);
  }

  // ───────────── импорт ─────────────

  async runImport(label, factory) {
    if (this.busy) return;
    this.busy = { label, progress: 0.05 };
    this.lastError = '';
    this.tab = 'sources';
    this.render();
    try {
      const session = await factory((l, f) => this.updateProgress(l, f));
      Object.assign(session.options, this.pendingOptions);
      session.originalTitle = session.title;
      if (session.kind === 'telegram' && session.hasGroups) session.options.split = this.src.tgSplit;
      this.updateProgress('Собираю блоки…', 0.95);
      await session.rebuild();
      if (this.session) this.session.dispose();
      this.session = session;
      this.ui.view = this.core.settings.defaultView;
      this.ui.resultMode = 'preview';
      this.ui.typeFilter = null;
      this.ui.zoom = 1;
      this.tab = 'builder';
    } catch (err) {
      console.error('MarkImporter:', err);
      this.lastError = err.message || String(err);
      new Notice(`MarkImporter: ${this.lastError}`, 8000);
    } finally {
      this.busy = null;
      this.render();
    }
  }

  startFromSources() {
    const m = this.src.mode;
    if (m === 'file') {
      if (!this.src.file) return new Notice('Выберите файл');
      return this.importFile(this.src.file);
    }
    if (m === 'url') return this.importUrl(this.src.url);
    if (m === 'telegram') return this.importTelegram(this.src.tg);
    if (m === 'clipboard') {
      if (!this.src.clip || this.src.clip.empty) return this.importFromClipboard();
      return this.importClip(this.src.clip);
    }
  }

  importFile(file) {
    this.src.mode = 'file';
    this.src.file = file;
    return this.runImport(`Читаю ${file.name}…`, (p) => createFileSession(this.core, file, { onProgress: p }));
  }

  importUrl(url) {
    this.src.mode = 'url';
    this.src.url = url;
    return this.runImport('Загружаю ссылку…', (p) => createUrlSession(this.core, url, { onProgress: p }));
  }

  importTelegram(input) {
    this.src.mode = 'telegram';
    this.src.tg = input;
    return this.runImport('Загружаю Telegram…', (p) => createTelegramSession(this.core, input, { count: this.src.tgCount, onProgress: p }));
  }

  async importFromClipboard(hint = {}) {
    const clip = await readClipboard();
    if (hint.sourceUrl) clip.sourceUrl = clip.sourceUrl || hint.sourceUrl;
    if (hint.title) clip.pageTitle = hint.title;
    this.src.mode = 'clipboard';
    this.src.clip = clip;
    if (clip.empty) {
      new Notice('Буфер пуст или нет доступа — нажмите Ctrl/Cmd+V в окне импорта');
      this.tab = 'sources';
      this.render();
      return;
    }
    return this.importClip(clip);
  }

  importClip(clip) {
    if (clip.isUrl) return this.importUrl(clip.text.trim());
    return this.runImport('Разбираю буфер обмена…', async () => createClipboardSession(this.core, clip));
  }

  // ───────────── сохранение ─────────────

  async createNote() {
    const sess = this.session;
    if (!sess || this.busy) return;
    this.busy = { label: 'Создаю заметку…', progress: 0.1 };
    this.render();
    try {
      const files = await createNotes(this.core, sess, {
        folder: sess.folder,
        title: sess.title,
        onProgress: (l) => this.updateProgress(l),
      });
      new Notice(files.length > 1 ? `Создано заметок: ${files.length}` : `Заметка создана: ${files[0].path}`);
      sess.dispose();
      this.session = null;
      this.src.file = null;
      this.src.clip = null;
      this.tab = 'stats';
    } catch (err) {
      console.error('MarkImporter:', err);
      new Notice(`Не удалось создать заметку: ${err.message}`, 8000);
    } finally {
      this.busy = null;
      this.render();
    }
  }

  discardSession() {
    if (this.session) this.session.dispose();
    this.session = null;
    this.tab = 'sources';
    this.render();
  }
}

module.exports = { ImporterView };
