'use strict';

/** Ядро плагина: настройки, команды, вид, протокол obsidian://markimporter. */

const { Notice, TFile, Platform } = require('obsidian');
const { VIEW_TYPE, DEFAULT_SETTINGS } = require('./constants');
const { Journal } = require('./store');
const { ImporterView } = require('./ui/view');
const { SettingsTab } = require('./settings');
const { normalizeAttributes } = require('./attributes');

const IMPORTABLE = new Set(['pdf', 'docx', 'html', 'htm', 'txt', 'md', 'markdown']);

class PluginCore {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.manifest = plugin.manifest;
  }

  async onload() {
    const p = this.plugin;
    const saved = (await p.loadData()) || {};
    this.data = Object.assign({ settings: {}, journal: [] }, saved);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings || {});
    normalizeAttributes(this.settings);
    if (this.data.settings && this.data.settings.attachmentsFolder && !this.data.settings.imagesFolder) {
      this.settings.imagesFolder = this.data.settings.attachmentsFolder;
    }
    this.journal = new Journal(this);

    p.registerView(VIEW_TYPE, (leaf) => new ImporterView(leaf, this));
    p.addRibbonIcon('file-input', 'MarkImporter — импорт в заметку', () => this.openView());

    p.addCommand({ id: 'open', name: 'Открыть окно импорта', callback: () => this.openView() });
    p.addCommand({
      id: 'import-clipboard',
      name: 'Импорт из буфера обмена (с предпросмотром)',
      callback: async () => (await this.openView()).importFromClipboard(),
    });
    p.addCommand({
      id: 'import-url-clipboard',
      name: 'Импорт ссылки из буфера обмена',
      callback: async () => {
        let text = '';
        try {
          text = (await navigator.clipboard.readText()).trim();
        } catch (e) {
          /* ignore */
        }
        const view = await this.openView();
        if (/^https?:\/\/\S+$/.test(text)) view.importUrl(text);
        else {
          view.setSourceMode('url');
          new Notice('В буфере нет ссылки — вставьте её в поле');
        }
      },
    });
    p.addCommand({
      id: 'import-active-file',
      name: 'Создать заметку из открытого PDF/DOCX/HTML',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = f && IMPORTABLE.has(f.extension) && f.extension !== 'md';
        if (checking) return !!ok;
        if (ok) this.importVaultFile(f);
        return true;
      },
    });
    p.addCommand({
      id: 'open-settings',
      name: 'Настройки MarkImporter',
      callback: async () => (await this.openView()).switchTab('settings'),
    });
    p.addCommand({ id: 'open-stats', name: 'Статистика и журнал импорта', callback: async () => (await this.openView()).switchTab('stats') });

    p.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !IMPORTABLE.has(file.extension) || file.extension === 'md') return;
        menu.addItem((item) =>
          item
            .setTitle('MarkImporter: создать заметку')
            .setIcon('file-input')
            .onClick(() => this.importVaultFile(file))
        );
      })
    );
    p.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.journal.renamePath(oldPath, file.path)));

    // obsidian://markimporter?url=…  (закладка в браузере) или ?text=…
    p.registerObsidianProtocolHandler('markimporter', async (params) => {
      const view = await this.openView();
      if (params.clip) view.importFromClipboard({ sourceUrl: params.url || '', title: params.title || '' });
      else if (params.url) view.importUrl(decodeURIComponent(params.url));
      else if (params.tg) view.importTelegram(decodeURIComponent(params.tg));
    });

    p.addSettingTab(new SettingsTab(this.app, p, this));
  }

  onunload() {
    // вид закрывается Obsidian автоматически
  }

  async persist() {
    this.data.settings = this.settings;
    await this.plugin.saveData(this.data);
  }

  async openView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    return leaf.view;
  }

  async importVaultFile(file) {
    const view = await this.openView();
    const buffer = await this.app.vault.readBinary(file);
    view.importFile({ name: file.name, buffer, size: file.stat.size, vaultPath: file.path });
  }

  get isMobile() {
    return Platform.isMobile;
  }
}

module.exports = { PluginCore };
