'use strict';

/** Ссылка → сессия: веб-страница, PDF по ссылке, Telegram, сырой Markdown с GitHub. */

const U = require('../util');
const { fetchUrl, createHtmlSession } = require('./common');
const { fetchViaBrowser, canUseBrowser } = require('./browser');
const { createPdfSession } = require('./pdf');
const { createTelegramSession, isTelegramUrl } = require('./telegram');
const { createTextSession } = require('./file');

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Вставьте ссылку');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    return new URL(s).href;
  } catch (e) {
    throw new Error('Некорректная ссылка');
  }
}

/** Специальные правила для известных сайтов. */
function rewrite(url) {
  const u = new URL(url);
  // GitHub: файл .md → raw
  let m = /^\/([^/]+)\/([^/]+)\/blob\/(.+\.(md|markdown|txt))$/i.exec(u.pathname);
  if (u.hostname === 'github.com' && m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, kind: 'markdown', base: url };
  // arXiv: /pdf/ID — оставляем PDF; /abs/ — страница
  m = /^\/pdf\/([\w.\/-]+?)(v\d+)?(\.pdf)?$/.exec(u.pathname);
  if (/arxiv\.org$/.test(u.hostname) && m) return { url: `https://arxiv.org/pdf/${m[1]}${m[2] || ''}`, kind: 'pdf' };
  // Google Docs → экспорт HTML
  m = /^\/document\/d\/([\w-]+)/.exec(u.pathname);
  if (u.hostname === 'docs.google.com' && m) return { url: `https://docs.google.com/document/d/${m[1]}/export?format=html`, kind: 'html-doc', base: url };
  return { url };
}

async function createUrlSession(plugin, input, { onProgress } = {}) {
  const url = normalizeUrl(input);
  if (isTelegramUrl(url)) return createTelegramSession(plugin, url, { onProgress });
  const rule = rewrite(url);
  const s = plugin.settings;
  const viaBrowser = async (reason) => {
    if (onProgress) onProgress(reason, 0.2);
    const page = await fetchViaBrowser(plugin.app, s, rule.url, { onProgress });
    if (onProgress) onProgress('Извлекаю основной контент…', 0.7);
    return createHtmlSession(plugin, {
      kind: 'web',
      html: page.html,
      baseUrl: page.url || rule.url,
      size: page.html.length,
      readable: rule.kind !== 'html-doc',
    });
  };
  if (s.browserMode === 'always' && canUseBrowser() && rule.kind !== 'markdown' && rule.kind !== 'pdf' && !/\.pdf($|\?)/i.test(rule.url)) {
    return viaBrowser('Открываю страницу во встроенном браузере…');
  }
  if (onProgress) onProgress('Загружаю страницу…', 0.1);
  let fetched;
  try {
    fetched = await fetchUrl(s, rule.url);
  } catch (err) {
    if (err.blocked && s.browserMode !== 'never' && canUseBrowser()) {
      return viaBrowser(`Сайт ответил ${err.status || 'отказом'} — пробую через встроенный браузер…`);
    }
    if (err.blocked) {
      err.message += '. Откройте статью в браузере и нажмите закладку «Страницу в MarkImporter» (Настройки → Сеть и браузер) или скопируйте текст и вставьте во вкладке «Буфер обмена».';
    }
    throw err;
  }
  const { buffer, contentType } = fetched;
  const bytes = new Uint8Array(buffer.slice(0, 5));
  const isPdf = /application\/pdf/i.test(contentType) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  if (isPdf) {
    const name = decodeURIComponent(new URL(rule.url).pathname.split('/').pop() || 'document') + (/\.pdf$/i.test(rule.url) ? '' : '.pdf');
    return createPdfSession(plugin, { buffer, fileName: name, sourceRef: url, onProgress });
  }
  if (rule.kind === 'markdown' || /text\/(markdown|plain)/i.test(contentType)) {
    const text = U.decodeBuffer(buffer, contentType, false);
    const name = decodeURIComponent(new URL(rule.url).pathname.split('/').pop() || 'text');
    return createTextSession(plugin, {
      text,
      fileName: name,
      kind: rule.kind === 'markdown' || /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text',
      sourceRef: url,
      title: name.replace(/\.\w+$/, ''),
      size: buffer.byteLength,
    });
  }
  if (/^image\//i.test(contentType)) {
    const html = `<html><head><title>${U.escapeHtml(url.split('/').pop())}</title></head><body><img src="${U.escapeHtml(rule.url)}"></body></html>`;
    return createHtmlSession(plugin, { kind: 'web', html, baseUrl: url, size: buffer.byteLength, readable: false });
  }
  const html = U.decodeBuffer(buffer, contentType);
  const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const { CHALLENGE_RE } = require('./browser');
  if (s.browserMode !== 'never' && canUseBrowser() && (visible.length < 600 || (CHALLENGE_RE.test(html) && visible.length < 3000))) {
    // пустая оболочка SPA или страница проверки — дорисуем в браузере
    try {
      return await viaBrowser('Страница собирается скриптами — открываю во встроенном браузере…');
    } catch (e) {
      /* отдаём то, что есть */
    }
  }
  if (onProgress) onProgress('Извлекаю основной контент…', 0.6);
  return createHtmlSession(plugin, {
    kind: 'web',
    html,
    baseUrl: rule.base || rule.url,
    size: buffer.byteLength,
    readable: rule.kind !== 'html-doc',
  });
}

module.exports = { createUrlSession, normalizeUrl };
