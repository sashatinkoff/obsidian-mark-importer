'use strict';

/** PDF-файл/ссылка → сессия импорта. */

const U = require('../util');
const { ImportSession } = require('../session');
const { openPdf, analyzePdf, buildPdfBlocks, renderPageImage, pdfMetadata, guessTitle } = require('../convert/pdf');

async function createPdfSession(plugin, { buffer, fileName = '', sourceRef = '', onProgress } = {}) {
  const raw = buffer.slice(0);
  const { pdfjs, doc } = await openPdf(buffer);
  const info = await pdfMetadata(doc);
  if (onProgress) onProgress(`Разбор страниц: 0/${doc.numPages}`, 0);
  const analysis = await analyzePdf(pdfjs, doc, {
    extractImages: true,
    onProgress: (p, n) => onProgress && onProgress(`Разбор страниц: ${p}/${n}`, p / n),
  });

  const fromFile = fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
  const guessed = guessTitle(analysis);
  const metaTitle = info.title && !/^(untitled|microsoft word|document\d*)/i.test(info.title) ? info.title : '';
  const title = U.sanitizeFileName(metaTitle || guessed || fromFile || 'PDF');

  let pageImageTokens = null;
  const session = new ImportSession(plugin, {
    kind: 'pdf',
    title,
    meta: {
      source: /^https?:/.test(sourceRef) ? sourceRef : '',
      author: /^(anonymous|unknown|user|admin)$/i.test(info.author || '') ? '' : info.author,
      published: info.published,
      keywords: info.keywords,
    },
    sourceRef: sourceRef || fileName,
    size: raw.byteLength,
    pages: doc.numPages,
    rawBuffer: raw,
    fileName,
    original: { type: 'pdf', doc, pdfjs, pageCount: doc.numPages },
    prepare: async (o, sess) => {
      if (o.pageImages && !pageImageTokens) {
        pageImageTokens = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const img = await renderPageImage(doc, p, plugin.settings.pdfPageImageScale || 1.5);
          pageImageTokens.push(sess.assets.add({ data: img.data, mime: img.mime, name: `page-${p}` }));
        }
      }
    },
    builder: async (o, sess) =>
      buildPdfBlocks(
        analysis,
        {
          removeHeaders: o.removeHeaders,
          tablesMarkdown: o.tablesMarkdown,
          preserveStyles: o.preserveStyles,
          extractImages: o.extractImages,
          pageImages: o.pageImages,
          callouts: o.callouts,
        },
        sess.assets,
        pageImageTokens
      ),
    onDispose: () => doc.destroy(),
  });
  session.analysis = analysis;
  // если первый блок дублирует заголовок — убираем его из тела
  const origBuilder = session.builder;
  session.builder = async (o, sess) => {
    const blocks = await origBuilder(o, sess);
    const first = blocks.find((b) => b.type !== 'image');
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (first && first.type === 'heading' && first.level === 1 && norm(first.text) === norm(sess.title)) blocks.splice(blocks.indexOf(first), 1);
    return blocks;
  };
  return session;
}

module.exports = { createPdfSession };
