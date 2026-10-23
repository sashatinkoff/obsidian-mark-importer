'use strict';

/**
 * Буфер обмена: HTML (из браузера, Telegram Desktop, Word, Google Docs),
 * простой текст/Markdown, картинки, ссылка (→ импорт по URL).
 */

const { Platform } = require('obsidian');
const U = require('../util');
const { createHtmlSession } = require('./common');
const { createTextSession } = require('./file');
const { looksLikeMarkdown } = require('../convert/text');

/** Чтение буфера: Clipboard API → Electron (десктоп). */
async function readClipboard() {
  const result = { html: '', text: '', images: [], sourceUrl: '' };
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type === 'text/html') result.html = await blob.text();
          else if (type === 'text/plain') result.text = await blob.text();
          else if (type.startsWith('image/')) result.images.push({ data: await blob.arrayBuffer(), mime: type });
        }
      }
    }
  } catch (e) {
    /* нет разрешения — пробуем Electron */
  }
  if (!result.html && !result.text && !result.images.length && Platform.isDesktopApp) {
    try {
      const { clipboard } = require('electron');
      result.html = clipboard.readHTML() || '';
      result.text = clipboard.readText() || '';
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        result.images.push({ data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), mime: 'image/png' });
      }
    } catch (e) {
      /* нет electron */
    }
  }
  if (!result.text && navigator.clipboard && navigator.clipboard.readText) {
    try {
      result.text = await navigator.clipboard.readText();
    } catch (e) {
      /* ignore */
    }
  }
  return normalizeClip(result);
}

/** Из события paste (самый надёжный путь). */
async function readPasteEvent(evt) {
  const dt = evt.clipboardData;
  const result = { html: dt.getData('text/html') || '', text: dt.getData('text/plain') || '', images: [], sourceUrl: dt.getData('text/x-moz-url') || '' };
  for (const item of dt.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) result.images.push({ data: await f.arrayBuffer(), mime: item.type });
    }
  }
  return normalizeClip(result);
}

function normalizeClip(r) {
  // Windows CF_HTML / Chromium добавляют служебные заголовки
  const src = /SourceURL:(\S+)/.exec(r.html);
  if (src) r.sourceUrl = r.sourceUrl || src[1];
  r.html = r.html.replace(/^Version:[\s\S]*?(?=<)/, '');
  const frag = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/.exec(r.html);
  if (frag) r.html = `<html><body>${frag[1]}</body></html>`;
  r.text = r.text.replace(/\r\n?/g, '\n');
  r.isUrl = !r.html && /^\s*https?:\/\/\S+\s*$/.test(r.text);
  r.kinds = [r.html && 'HTML', r.text && 'Текст', r.images.length && `Изображение ×${r.images.length}`].filter(Boolean);
  r.empty = !r.html && !r.text.trim() && !r.images.length;
  return r;
}

function createClipboardSession(plugin, clip) {
  if (clip.empty) throw new Error('Буфер обмена пуст');
  const stamp = U.humanDate(new Date());
  if (clip.html && clip.html.replace(/<[^>]+>/g, '').trim().length + (clip.html.match(/<img/g) || []).length > 0) {
    const session = createHtmlSession(plugin, {
      kind: 'clipboard',
      html: clip.html,
      baseUrl: clip.sourceUrl || '',
      readable: !!clip.pageTitle, // из закладки браузера — чистим от кнопок «поделиться», рекламы и т.п.
      sourceRef: clip.sourceUrl || 'Буфер обмена',
    });
    const fromText = U.firstLine(clip.text || session.original.html.replace(/<[^>]+>/g, ' '), 70);
    if (clip.pageTitle) session.title = U.sanitizeFileName(clip.pageTitle);
    else if (!clip.sourceUrl || !session.meta.title) session.title = U.sanitizeFileName(fromText || `Вставка ${stamp}`);
    if (clip.sourceUrl) {
      session.meta.source = clip.sourceUrl;
      try {
        session.meta.site = session.meta.site || new URL(clip.sourceUrl).hostname.replace(/^www\./, '');
      } catch (e) {
        /* ignore */
      }
    }
    if (clip.images.length) addImages(session, clip.images);
    return session;
  }
  if (clip.text.trim()) {
    const session = createTextSession(plugin, {
      text: clip.text,
      kind: looksLikeMarkdown(clip.text) ? 'markdown' : 'text',
      sourceRef: 'Буфер обмена',
      title: U.firstLine(clip.text, 70) || `Вставка ${stamp}`,
    });
    session.kind = 'clipboard';
    if (clip.images.length) addImages(session, clip.images);
    return session;
  }
  // только картинки
  const session = createTextSession(plugin, { text: '', kind: 'text', sourceRef: 'Буфер обмена', title: `Изображение ${stamp}` });
  session.kind = 'clipboard';
  session.original = { type: 'html', html: '', baseUrl: '' };
  addImages(session, clip.images);
  return session;
}

function addImages(session, images) {
  const tokens = images.map((im) => session.assets.add({ data: im.data, mime: im.mime, name: 'clipboard' }));
  const html = tokens.map((t) => `<p><img src="${session.assets.previewUrl(t.slice('mi-asset://'.length))}" style="max-width:100%"></p>`).join('');
  if (session.original && session.original.type === 'html') session.original.html = (session.original.html || '') + html;
  const prev = session.builder;
  session.builder = async (o, sess) => {
    const blocks = await prev(o, sess);
    if (!blocks.some((b) => b.type === 'image')) for (const t of tokens) blocks.push({ type: 'image', md: `![](${t})`, text: 'Изображение' });
    return blocks;
  };
}

module.exports = { readClipboard, readPasteEvent, createClipboardSession };
