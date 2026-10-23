'use strict';

const VIEW_TYPE = 'mark-importer-view';
const VERSION = '1.0.0';
const ASSET_SCHEME = 'mi-asset://';

const DEFAULT_SETTINGS = {
  // Куда сохранять
  folder: 'Imports',
  fileNameTemplate: '{{title}}',
  openAfterCreate: true,

  // Вложения
  downloadImages: true,
  attachmentsMode: 'folder', // 'folder' | 'obsidian'
  attachmentsFolder: 'attachments',
  imagesFolder: 'attachments',
  videosFolder: 'attachments/video',
  downloadVideos: true,
  imageNaming: '{{note}}_{{n}}',
  linkStyle: 'wikilink', // 'wikilink' | 'markdown'
  saveOriginalPdf: false,

  // Frontmatter
  frontmatter: true,
  fmTitle: true,
  fmSource: true,
  fmAuthor: true,
  fmPublished: true,
  fmCreated: true,
  fmSite: true,
  fmDescription: true,
  fmType: true,
  defaultTags: 'import',
  addSourceTag: true,
  createdField: 'created',

  // Разбор
  defaultMode: 'layout', // 'flat' | 'layout' | 'builder'
  defaultView: 'split', // 'original' | 'split' | 'result'
  extraction: 'auto', // 'auto' | 'full'
  removeHeaders: true,
  tablesMarkdown: true,
  callouts: true,
  preserveStyles: true,
  latex: true,
  autoWikilinks: false,
  pdfExtractImages: true,
  pdfPageImages: false,
  pdfPageImageScale: 1.5,

  // Telegram
  telegramCount: 20,
  telegramSplit: false,

  // Сеть
  browserMode: 'auto', // 'auto' — при блокировке | 'always' | 'never'
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  acceptLanguage: 'ru,en;q=0.8',
};

const SOURCE_LABELS = {
  pdf: 'PDF',
  web: 'Web',
  telegram: 'Telegram',
  clipboard: 'Буфер',
  docx: 'DOCX',
  text: 'TXT',
  markdown: 'MD',
  html: 'HTML',
};

const BLOCK_LABELS = {
  heading: 'Заголовки',
  paragraph: 'Текст и абзацы',
  list: 'Списки',
  table: 'Таблицы',
  image: 'Изображения',
  quote: 'Цитаты и callouts',
  code: 'Блоки кода',
  math: 'Формулы',
  embed: 'Медиа и встраивания',
  hr: 'Разделители',
  html: 'HTML-блоки',
  meta: 'Служебные',
};

const BLOCK_ICONS = {
  heading: 'heading',
  paragraph: 'pilcrow',
  list: 'list',
  table: 'table',
  image: 'image',
  quote: 'quote',
  code: 'code-2',
  math: 'sigma',
  embed: 'play-square',
  hr: 'minus',
  html: 'file-code',
  meta: 'info',
};

module.exports = {
  VIEW_TYPE,
  VERSION,
  ASSET_SCHEME,
  DEFAULT_SETTINGS,
  SOURCE_LABELS,
  BLOCK_LABELS,
  BLOCK_ICONS,
};
