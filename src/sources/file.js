'use strict';

/** Локальные файлы: PDF, DOCX, HTML, TXT, MD. */

const U = require('../util');
const { ImportSession } = require('../session');
const { markdownToBlocks, textToBlocks, looksLikeMarkdown } = require('../convert/text');
const { docxToHtml } = require('../convert/docx');
const { createHtmlSession } = require('./common');
const { createPdfSession } = require('./pdf');

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.html,.htm,.xhtml,.text,.log,.csv';

function createTextSession(plugin, { text, fileName = '', kind = 'text', sourceRef = '', title = '', size = 0 }) {
  const isMd = kind === 'markdown';
  const parsedMd = isMd ? markdownToBlocks(text) : null;
  return new ImportSession(plugin, {
    kind,
    title: U.sanitizeFileName(title || fileName.replace(/\.\w+$/, '') || U.firstLine(text, 70) || 'Текст'),
    meta: { source: /^https?:/.test(sourceRef) ? sourceRef : '' },
    sourceRef: sourceRef || fileName,
    size: size || new TextEncoder().encode(text).length,
    fileName,
    original: { type: 'text', text },
    builder: async (o) => {
      if (isMd) return parsedMd.blocks.map((b) => Object.assign({}, b));
      return textToBlocks(text, { keepLineBreaks: o.preserveStyles });
    },
  });
}

/**
 * @param {{name:string, buffer:ArrayBuffer}} file
 */
async function createFileSession(plugin, file, { onProgress } = {}) {
  const name = file.name || 'file';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const buffer = file.buffer;
  if (ext === 'pdf') return createPdfSession(plugin, { buffer, fileName: name, onProgress });
  if (ext === 'docx') {
    if (onProgress) onProgress('Распаковываю DOCX…', 0.2);
    // ассеты регистрируем во временный реестр сессии: создаём сессию после конвертации
    const holder = { assets: null };
    const { AssetRegistry } = require('../assets');
    holder.assets = new AssetRegistry(plugin.settings);
    const { html, meta } = await docxToHtml(buffer, holder.assets);
    const session = createHtmlSession(plugin, {
      kind: 'docx',
      html,
      baseUrl: '',
      size: buffer.byteLength,
      fileName: name,
      sourceRef: name,
      readable: false,
      title: meta.title || name.replace(/\.docx$/i, ''),
      meta: { author: meta.author, published: meta.published },
    });
    session.assets.dispose();
    session.assets = holder.assets;
    // в «Оригинале» картинки DOCX должны отображаться
    session.original.html = holder.assets.resolveForPreview(html);
    return session;
  }
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    const html = U.decodeBuffer(buffer, '');
    return createHtmlSession(plugin, { kind: 'html', html, baseUrl: '', size: buffer.byteLength, fileName: name, sourceRef: name });
  }
  if (ext === 'doc' || ext === 'rtf' || ext === 'odt' || ext === 'pages') {
    throw new Error(`Формат .${ext} пока не поддерживается — сохраните файл как DOCX или PDF`);
  }
  const text = U.decodeBuffer(buffer, '', false);
  const kind = ext === 'md' || ext === 'markdown' || (ext !== 'txt' && looksLikeMarkdown(text)) ? 'markdown' : 'text';
  return createTextSession(plugin, { text, fileName: name, kind, size: buffer.byteLength });
}

module.exports = { createFileSession, createTextSession, ACCEPT };
