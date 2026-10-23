'use strict';

/** Общие помощники источников: сеть и HTML-сессии. */

const { requestUrl } = require('obsidian');
const U = require('../util');
const { ImportSession } = require('../session');
const { HtmlConverter } = require('../convert/html2md');
const { extractMetadata, extractContent, prepareDocument } = require('../convert/readability');

const BLOCK_CODES = new Set([401, 403, 406, 429, 451, 503]);

/** Набор заголовков настоящего Chrome — часть защит пропускает только их. */
function browserHeaders(settings, url) {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch (e) {
    /* ignore */
  }
  return {
    'User-Agent': settings.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': settings.acceptLanguage,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    Referer: origin ? origin + '/' : undefined,
  };
}

/**
 * Загрузка с повтором при защите от ботов (403/429/503):
 * 1) обычные заголовки, 2) полный набор заголовков Chrome, 3) без своего User-Agent.
 * Ошибка содержит .status и .blocked — тогда источник может открыть встроенный браузер.
 */
async function fetchUrl(settings, url, extraHeaders = {}) {
  const attempts = [
    Object.assign(
      {
        'User-Agent': settings.userAgent,
        'Accept-Language': settings.acceptLanguage,
        Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      },
      extraHeaders
    ),
    Object.assign(browserHeaders(settings, url), extraHeaders),
    Object.assign({ 'Accept-Language': settings.acceptLanguage, Accept: 'text/html,*/*;q=0.8' }, extraHeaders),
  ];
  let last = null;
  for (const headers of attempts) {
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    let res;
    try {
      res = await requestUrl({ url, method: 'GET', headers, throw: false });
    } catch (e) {
      last = { status: 0, message: e.message };
      continue;
    }
    if (res.status < 400) {
      const contentType = U.headerValue(res.headers, 'content-type') || '';
      return { buffer: res.arrayBuffer, contentType, status: res.status, headers: res.headers };
    }
    last = { status: res.status };
    if (!BLOCK_CODES.has(res.status)) break;
  }
  const err = new Error(
    last && last.status
      ? `Сервер ответил ${last.status}${BLOCK_CODES.has(last.status) ? ' — сайт блокирует автоматические запросы' : ''}`
      : `Нет соединения: ${(last && last.message) || url}`
  );
  err.status = last ? last.status : 0;
  err.blocked = !!last && (BLOCK_CODES.has(last.status) || last.status === 0);
  throw err;
}

function stripScriptsForPreview(html, baseUrl) {
  // исходник для панели «Оригинал»: без скриптов, с <base> для относительных путей
  let out = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?refresh[^>]*>/gi, '')
    .replace(/\son\w+=("[^"]*"|'[^']*')/gi, '');
  if (baseUrl && !/<base\s/i.test(out)) {
    const base = `<base href="${U.escapeHtml(baseUrl)}" target="_blank">`;
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + base) : base + out;
  }
  return out;
}

/**
 * Создаёт сессию из HTML-строки.
 * @param {object} init { kind, html, baseUrl, sourceRef, title?, meta?, size?, fileName?, readable? (bool — применять извлечение контента) }
 */
function createHtmlSession(plugin, init) {
  const probe = new DOMParser().parseFromString(init.html, 'text/html');
  const meta = Object.assign(extractMetadata(probe, init.baseUrl), init.meta || {});
  meta.source = init.baseUrl || meta.source || '';
  const title = init.title || meta.title || U.firstLine(probe.body ? probe.body.textContent : '', 80) || 'Без названия';

  const session = new ImportSession(plugin, {
    kind: init.kind,
    title,
    meta,
    sourceRef: init.sourceRef || init.baseUrl || '',
    size: init.size || new TextEncoder().encode(init.html).length,
    fileName: init.fileName || '',
    original: { type: 'html', html: stripScriptsForPreview(init.html, init.baseUrl), baseUrl: init.baseUrl || '' },
    builder: async (o, sess) => {
      const doc = new DOMParser().parseFromString(init.html, 'text/html');
      prepareDocument(doc, init.baseUrl);
      const readable = init.readable !== false;
      const root = readable ? extractContent(doc, o.extraction) : doc.body;
      const conv = new HtmlConverter({
        baseUrl: init.baseUrl,
        assets: sess.assets,
        tablesMarkdown: o.tablesMarkdown,
        callouts: o.callouts,
        preserveStyles: o.preserveStyles,
        latex: o.latex,
      });
      let blocks = conv.convert(root);
      // не дублируем заголовок заметки первым H1
      const first = blocks[0];
      if (first && first.type === 'heading' && first.level <= 2 && normalize(first.text) === normalize(sess.title)) blocks = blocks.slice(1);
      return blocks;
    },
  });
  return session;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

module.exports = { BLOCK_CODES, fetchUrl, createHtmlSession, stripScriptsForPreview };
