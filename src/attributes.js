'use strict';

/**
 * Атрибуты (свойства frontmatter): встроенные с переименованием, свои — с
 * шаблонами значений. Порядок в настройках = порядок в заметке.
 */

const U = require('./util');

const BUILTIN = [
  { id: 'title', key: 'title', label: 'Название', hint: 'Заголовок заметки' },
  { id: 'aliases', key: 'aliases', label: 'Псевдонимы', hint: 'Исходный заголовок, если имя файла другое', enabled: false },
  { id: 'source', key: 'source', label: 'Источник', hint: 'Ссылка или имя файла' },
  { id: 'author', key: 'author', label: 'Автор', hint: 'Автор статьи, документа, канал' },
  { id: 'published', key: 'published', label: 'Дата публикации', hint: 'Из метаданных источника' },
  { id: 'created', key: 'created', label: 'Дата импорта', hint: 'Когда создана заметка' },
  { id: 'site', key: 'site', label: 'Сайт / площадка', hint: 'Хабр, Telegram, имя домена' },
  { id: 'description', key: 'description', label: 'Описание', hint: 'Анонс из og:description' },
  { id: 'type', key: 'type', label: 'Тип источника', hint: 'PDF, Web, Telegram… (названия ниже)' },
  { id: 'pages', key: 'pages', label: 'Страниц', hint: 'Только для PDF' },
  { id: 'words', key: 'words', label: 'Слов', hint: 'Количество слов в заметке', enabled: false },
  { id: 'file', key: 'file', label: 'Исходный файл', hint: '[[файл.pdf]], если включено сохранение оригинала' },
  { id: 'tags', key: 'tags', label: 'Теги', hint: 'Теги по умолчанию + тег источника' },
];

const VARS = ['title', 'source', 'author', 'published', 'created', 'date', 'time', 'site', 'type', 'description', 'pages', 'words', 'file'];

const DEFAULT_TYPE_NAMES = { pdf: 'PDF', web: 'Web', telegram: 'Telegram', clipboard: 'Буфер', docx: 'DOCX', text: 'TXT', markdown: 'MD', html: 'HTML' };

function defaultAttributes(settings = {}) {
  const legacy = {
    title: settings.fmTitle,
    source: settings.fmSource,
    author: settings.fmAuthor,
    published: settings.fmPublished,
    created: settings.fmCreated,
    site: settings.fmSite,
    description: settings.fmDescription,
    type: settings.fmType,
  };
  return BUILTIN.map((b) => ({
    id: b.id,
    key: b.id === 'created' && settings.createdField ? settings.createdField : b.key,
    enabled: legacy[b.id] !== undefined ? !!legacy[b.id] : b.enabled !== false,
    builtin: true,
  }));
}

/** Приводит настройки к актуальному виду (миграция старых флагов fm*). */
function normalizeAttributes(settings) {
  if (!Array.isArray(settings.attributes) || !settings.attributes.length) {
    settings.attributes = defaultAttributes(settings);
  } else {
    // новые встроенные атрибуты из обновлений плагина — в конец
    for (const b of BUILTIN) {
      if (!settings.attributes.some((a) => a.builtin && a.id === b.id)) {
        settings.attributes.push({ id: b.id, key: b.key, enabled: b.enabled !== false, builtin: true });
      }
    }
  }
  settings.typeNames = Object.assign({}, DEFAULT_TYPE_NAMES, settings.typeNames || {});
  // новый формат по умолчанию — «6 мая 2026, 12:30», если пользователь формат не менял
  if (!settings.dateFormat || (!settings.dateFormatTouched && settings.dateFormat === 'YYYY-MM-DDTHH:mm:ss')) {
    settings.dateFormat = DEFAULT_DATE_FORMAT;
  }
  return settings.attributes;
}

function builtinInfo(id) {
  return BUILTIN.find((b) => b.id === id);
}

const DEFAULT_DATE_FORMAT = 'D MMMM YYYY, HH:mm';
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Убирает из формата часы/минуты/секунды (для дат без времени). */
function dateOnlyFormat(fmt) {
  const out = String(fmt)
    .replace(/[\s,T]*\[?(в)?\]?\s*[Hh]{1,2}(?:[:.]mm)?(?:[:.]ss)?\s*/g, '')
    .replace(/[\s,]+$/, '')
    .trim();
  return out || 'D MMMM YYYY';
}

/**
 * Форматирование даты по токенам (как в moment, русские названия):
 * YYYY YY · MMMM (мая — родительный после D, иначе май) MMM MM M · DD D ·
 * dddd ddd · HH H · mm · ss · [текст в скобках] выводится как есть.
 */
function formatDate(date, fmt, dateOnly = false) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  let f = fmt || DEFAULT_DATE_FORMAT;
  if (dateOnly) f = dateOnlyFormat(f);
  const hasDay = /(^|[^D])D{1,2}([^D]|$)/.test(f.replace(/\[[^\]]*\]/g, ''));
  const p2 = (n) => String(n).padStart(2, '0');
  const tokens = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => (hasDay ? MONTHS_GEN : MONTHS_NOM)[d.getMonth()],
    MMM: () => MONTHS_SHORT[d.getMonth()],
    MM: () => p2(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => p2(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => WEEKDAYS[d.getDay()],
    ddd: () => WEEKDAYS_SHORT[d.getDay()],
    HH: () => p2(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => p2(d.getMinutes()),
    ss: () => p2(d.getSeconds()),
  };
  return f.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, (m, lit) => (lit !== undefined ? lit : tokens[m]()));
}

/**
 * Собирает объект frontmatter.
 * @param {object} settings
 * @param {object} ctx { title, source, author, published, site, description, kind, pages, words, file, tags, originalTitle }
 */
function buildAttributes(settings, ctx) {
  normalizeAttributes(settings);
  const now = new Date();
  const typeName = (settings.typeNames && settings.typeNames[ctx.kind]) || DEFAULT_TYPE_NAMES[ctx.kind] || ctx.kind;
  const pub = ctx.published ? U.parseDate(ctx.published) : null;
  const pubDateOnly = !!ctx.published && String(ctx.published).length <= 10;
  const values = {
    title: ctx.title,
    aliases: ctx.originalTitle && ctx.originalTitle !== ctx.title ? [ctx.originalTitle] : null,
    source: ctx.source,
    author: ctx.author,
    published: pub ? formatDate(pub, settings.dateFormat, pubDateOnly) : ctx.published || '',
    created: formatDate(now, settings.dateFormat),
    site: ctx.site,
    description: ctx.description ? U.firstLine(ctx.description, 300) : '',
    type: typeName,
    pages: ctx.kind === 'pdf' && ctx.pages ? ctx.pages : '',
    words: ctx.words || '',
    file: ctx.file || '',
    tags: ctx.tags && ctx.tags.length ? ctx.tags : null,
  };
  const vars = Object.assign({}, values, {
    date: formatDate(now, 'YYYY-MM-DD', true),
    time: formatDate(now, 'HH:mm'),
    tags: (ctx.tags || []).join(', '),
    aliases: '',
  });

  const fm = {};
  for (const a of settings.attributes) {
    if (!a.enabled) continue;
    const key = String(a.key || '').trim();
    if (!key) continue;
    let value;
    if (a.builtin) value = values[a.id];
    else {
      const raw = U.applyTemplate(a.value || '', vars).trim();
      value = a.list
        ? raw
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : raw;
      if (!a.list && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
      if (!a.list && (value === 'true' || value === 'false')) value = value === 'true';
    }
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    if (Array.isArray(value) && Array.isArray(fm[key])) fm[key] = [...new Set(fm[key].concat(value))];
    else fm[key] = value;
  }
  return fm;
}

/** Имена свойств, уже встречающихся в хранилище (для автоподстановки). */
function vaultPropertyNames(app) {
  const names = new Set();
  try {
    const infos = app.metadataCache.getAllPropertyInfos && app.metadataCache.getAllPropertyInfos();
    if (infos) for (const k of Object.keys(infos)) names.add((infos[k] && infos[k].name) || k);
  } catch (e) {
    /* старый Obsidian */
  }
  if (!names.size) {
    for (const f of app.vault.getMarkdownFiles().slice(0, 3000)) {
      const fm = app.metadataCache.getFileCache && (app.metadataCache.getFileCache(f) || {}).frontmatter;
      if (fm) for (const k of Object.keys(fm)) if (k !== 'position') names.add(k);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
}

module.exports = { DEFAULT_DATE_FORMAT, dateOnlyFormat, BUILTIN, VARS, DEFAULT_TYPE_NAMES, defaultAttributes, normalizeAttributes, builtinInfo, buildAttributes, vaultPropertyNames, formatDate };
