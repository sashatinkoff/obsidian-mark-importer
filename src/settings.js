'use strict';

/**
 * Настройки: один рендерер разделов, который используется и во вкладке
 * «Настройки» окна плагина, и в стандартных настройках Obsidian.
 */

const { PluginSettingTab, Setting, AbstractInputSuggest, TFolder, Notice } = require('obsidian');
const { DEFAULT_SETTINGS } = require('./constants');

/** Автоподстановка папок хранилища. */
class FolderSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, onPick) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.onPick = onPick;
  }
  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path.toLowerCase().includes(q))
      .map((f) => f.path || '/')
      .sort((a, b) => a.length - b.length)
      .slice(0, 50);
  }
  renderSuggestion(path, el) {
    el.setText(path === '/' ? '/ (корень)' : path);
  }
  selectSuggestion(path) {
    const value = path === '/' ? '' : path;
    this.setValue(value);
    this.inputEl.dispatchEvent(new Event('input'));
    if (this.onPick) this.onPick(value);
    this.close();
  }
}

const SECTIONS = [
  { id: 'save', label: 'Папки', icon: 'folder-tree' },
  { id: 'attachments', label: 'Вложения', icon: 'paperclip' },
  { id: 'attributes', label: 'Атрибуты', icon: 'list-tree' },
  { id: 'parse', label: 'Разбор', icon: 'wand-2' },
  { id: 'telegram', label: 'Telegram', icon: 'send' },
  { id: 'network', label: 'Сеть и браузер', icon: 'globe' },
  { id: 'journal', label: 'Журнал', icon: 'history' },
];

/**
 * @param {HTMLElement} el
 * @param {{app, core, redraw: Function, section?: string}} ctx
 */
function renderSettings(el, ctx) {
  const { app, core } = ctx;
  const s = core.settings;
  const save = () => core.persist();
  const redraw = ctx.redraw;
  const only = ctx.section || null;
  const show = (id) => !only || only === id;
  const heading = (id) => {
    if (!only) new Setting(el).setName(SECTIONS.find((x) => x.id === id).label).setHeading();
  };

  const folderSetting = (name, desc, key, placeholder, fallback) =>
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        t.setPlaceholder(placeholder)
          .setValue(s[key])
          .onChange((v) => {
            s[key] = v.trim().replace(/^\/+|\/+$/g, '') || fallback;
            save();
          });
        t.inputEl.addClass('mi-folder-setting');
        new FolderSuggest(app, t.inputEl, (v) => {
          s[key] = v || fallback;
          save();
        });
      });

  if (show('save')) {
    heading('save');
    folderSetting('Заметки', 'Куда создавать заметки. Можно поменять перед созданием каждой заметки.', 'folder', 'Imports', '');
    new Setting(el).setName('Где хранить фото и видео').addDropdown((d) =>
      d
        .addOption('folder', 'В папках ниже')
        .addOption('obsidian', 'Как в настройках Obsidian (Файлы и ссылки)')
        .setValue(s.attachmentsMode)
        .onChange((v) => {
          s.attachmentsMode = v;
          save();
          redraw();
        })
    );
    if (s.attachmentsMode === 'folder') {
      folderSetting('Фото', 'Картинки, иллюстрации из PDF, исходные PDF. {{note}} — имя заметки, например media/photo/{{note}}', 'imagesFolder', 'attachments', 'attachments');
      folderSetting('Видео', 'Видео и аудио (Telegram, сайты). {{note}} — имя заметки', 'videosFolder', 'attachments/video', 'attachments');
    }
    new Setting(el)
      .setName('Шаблон имени файла заметки')
      .setDesc('Переменные: {{title}}, {{date}}, {{source}}, {{site}}')
      .addText((t) => t.setValue(s.fileNameTemplate).onChange((v) => ((s.fileNameTemplate = v || '{{title}}'), save())));
    new Setting(el)
      .setName('Открывать заметку после создания')
      .addToggle((t) => t.setValue(s.openAfterCreate).onChange((v) => ((s.openAfterCreate = v), save())));
  }

  if (show('attachments')) {
    heading('attachments');
    new Setting(el)
      .setName('Скачивать фото в хранилище')
      .setDesc('Если выключено — остаются внешние ссылки.')
      .addToggle((t) => t.setValue(s.downloadImages).onChange((v) => ((s.downloadImages = v), save())));
    new Setting(el)
      .setName('Скачивать видео и аудио в хранилище')
      .setDesc('Если выключено — встраивается внешний плеер по ссылке.')
      .addToggle((t) => t.setValue(s.downloadVideos).onChange((v) => ((s.downloadVideos = v), save())));
    new Setting(el)
      .setName('Имя файла вложения')
      .setDesc('{{note}} — имя заметки, {{n}} — номер 001, 002…')
      .addText((t) => t.setValue(s.imageNaming).onChange((v) => ((s.imageNaming = v || '{{note}}_{{n}}'), save())));
    new Setting(el).setName('Формат ссылок на вложения').addDropdown((d) =>
      d
        .addOption('wikilink', '![[wikilink]]')
        .addOption('markdown', '![](путь)')
        .setValue(s.linkStyle)
        .onChange((v) => ((s.linkStyle = v), save()))
    );
    new Setting(el)
      .setName('Сохранять исходный PDF (в папку фото)')
      .addToggle((t) => t.setValue(s.saveOriginalPdf).onChange((v) => ((s.saveOriginalPdf = v), save())));
  }

  if (show('attributes')) {
    heading('attributes');
    const { renderAttributesEditor } = require('./ui/attributesEditor');
    renderAttributesEditor(el.createDiv(), { app, core, redraw });
  }

  if (show('parse')) {
    heading('parse');
    new Setting(el).setName('Режим по умолчанию').addDropdown((d) =>
      d
        .addOption('layout', 'С вёрсткой оригинала')
        .addOption('flat', 'Без вёрстки (чистый текст)')
        .addOption('builder', 'Конструктор блоков')
        .setValue(s.defaultMode)
        .onChange((v) => ((s.defaultMode = v), save()))
    );
    new Setting(el).setName('Вид предпросмотра').addDropdown((d) =>
      d
        .addOption('split', 'Рядом (Split)')
        .addOption('original', 'Оригинал')
        .addOption('result', 'Результат')
        .setValue(s.defaultView)
        .onChange((v) => ((s.defaultView = v), save()))
    );
    new Setting(el).setName('Извлечение со страниц сайтов').addDropdown((d) =>
      d
        .addOption('auto', 'Основной контент (без меню, рекламы, комментариев)')
        .addOption('full', 'Вся страница')
        .setValue(s.extraction)
        .onChange((v) => ((s.extraction = v), save()))
    );
    const toggles = [
      ['removeHeaders', 'Удалять колонтитулы и номера страниц (PDF)'],
      ['tablesMarkdown', 'Таблицы в Markdown (сложные — HTML)'],
      ['callouts', 'Цитаты и врезки → callouts [!quote]'],
      ['preserveStyles', 'Сохранять оформление: выравнивание, цвет, подчёркивание, ширину картинок'],
      ['latex', 'Формулы KaTeX/MathJax/MathML → LaTeX $$'],
      ['autoWikilinks', 'Автоматические [[wikilinks]] на существующие заметки'],
      ['pdfExtractImages', 'Извлекать иллюстрации из PDF'],
      ['pdfPageImages', 'PDF: добавлять изображение каждой страницы (1:1 с оригиналом)'],
    ];
    for (const [key, label] of toggles) {
      new Setting(el).setName(label).addToggle((t) => t.setValue(s[key]).onChange((v) => ((s[key] = v), save())));
    }
  }

  if (show('telegram')) {
    heading('telegram');
    new Setting(el).setName('Сколько постов брать из ленты канала').addSlider((sl) =>
      sl
        .setLimits(5, 200, 5)
        .setValue(s.telegramCount)
        .setDynamicTooltip()
        .onChange((v) => ((s.telegramCount = v), save()))
    );
    new Setting(el)
      .setName('Каждый пост — отдельной заметкой')
      .addToggle((t) => t.setValue(s.telegramSplit).onChange((v) => ((s.telegramSplit = v), save())));
  }

  if (show('network')) {
    heading('network');
    new Setting(el)
      .setName('Встроенный браузер')
      .setDesc('Когда сайт блокирует запросы (403, 429, капча) или собирает статью скриптами, страница открывается в скрытом Chromium внутри Obsidian. Только для десктопа.')
      .addDropdown((d) =>
        d
          .addOption('auto', 'Автоматически, если сайт блокирует')
          .addOption('always', 'Всегда открывать сайты в браузере')
          .addOption('never', 'Никогда')
          .setValue(s.browserMode || 'auto')
          .onChange((v) => ((s.browserMode = v), save()))
      );
    new Setting(el)
      .setName('User-Agent')
      .addText((t) => t.setValue(s.userAgent).onChange((v) => ((s.userAgent = v || DEFAULT_SETTINGS.userAgent), save())));

    const marks = [
      [
        'Закладка «Ссылку в MarkImporter»',
        'Отправляет адрес страницы — Obsidian сам загрузит её.',
        "javascript:location.href='obsidian://markimporter?url='+encodeURIComponent(location.href)",
      ],
      [
        'Закладка «Страницу в MarkImporter»',
        'Копирует статью прямо из вашего браузера (выделенный фрагмент или всю статью) и открывает MarkImporter. Работает с любыми сайтами, даже если они блокируют загрузку, и на iPhone/iPad.',
        "javascript:(()=>{const s=getSelection();if(s.isCollapsed){const r=document.createRange();r.selectNodeContents(document.querySelector('article')||document.querySelector('main')||document.body);s.removeAllRanges();s.addRange(r);}document.execCommand('copy');s.removeAllRanges();location.href='obsidian://markimporter?clip=1&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title);})()",
      ],
    ];
    for (const [name, desc, code] of marks) {
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addButton((b) =>
          b.setButtonText('Скопировать код').onClick(async () => {
            await navigator.clipboard.writeText(code);
            new Notice('Код скопирован — вставьте его как адрес новой закладки');
          })
        );
      el.createEl('pre', { cls: 'mi-bookmarklet', text: code });
    }
  }

  if (show('journal')) {
    heading('journal');
    new Setting(el)
      .setName('Очистить журнал импортов')
      .setDesc(`Записей: ${core.journal.entries.length}. Заметки не удаляются.`)
      .addButton((b) =>
        b
          .setButtonText('Очистить')
          .setWarning()
          .onClick(async () => {
            await core.journal.clear();
            redraw();
          })
      );
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin, core) {
    super(app, plugin);
    this.core = core;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('mi-settings');
    containerEl.createEl('h2', { text: 'MarkImporter' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Создание заметок из PDF, сайтов, Telegram, DOCX/TXT и буфера обмена с сохранением вёрстки. Те же настройки есть во вкладке «Настройки» окна плагина.',
    });
    renderSettings(containerEl, { app: this.app, core: this.core, redraw: () => this.display() });
  }
}

module.exports = { SettingsTab, FolderSuggest, renderSettings, SECTIONS };
