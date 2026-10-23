'use strict';

/**
 * Реестр вложений сессии импорта.
 * В Markdown картинки ссылаются на токены mi-asset://id. Для предпросмотра
 * токены заменяются на http/blob-адреса, при создании заметки — файлы
 * скачиваются/записываются в хранилище и токены меняются на ссылки.
 */

const { requestUrl, normalizePath } = require('obsidian');
const { ASSET_SCHEME } = require('./constants');
const U = require('./util');

const TOKEN_RE = /mi-asset:\/\/([a-z0-9]+)/g;

class AssetRegistry {
  constructor(settings) {
    this.settings = settings;
    this.items = new Map();
    this.byKey = new Map();
    this.blobUrls = new Map();
    this.counter = 0;
  }

  /** @returns {string} токен вида mi-asset://id */
  add({ url = '', data = null, mime = '', name = '', alt = '', kind = '' }) {
    const key = url && !url.startsWith('data:') ? url : null;
    if (key && this.byKey.has(key)) return ASSET_SCHEME + this.byKey.get(key);
    if (url && url.startsWith('data:')) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
      if (m) {
        mime = m[1] || mime || 'application/octet-stream';
        try {
          data = m[2] ? U.base64ToArrayBuffer(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])).buffer;
          url = '';
        } catch (e) {
          /* оставим как есть */
        }
      }
    }
    const id = (++this.counter).toString(36) + Math.random().toString(36).slice(2, 6);
    this.items.set(id, { id, url, data, mime, name, alt, kind });
    if (key) this.byKey.set(key, id);
    return ASSET_SCHEME + id;
  }

  /** Заменяет адрес уже добавленной картинки (нашлась версия крупнее). */
  upgrade(token, url) {
    const id = String(token).replace('mi-asset://', '');
    const item = this.items.get(id);
    if (!item || item.data) return;
    if (item.url) this.byKey.delete(item.url);
    item.url = url;
    this.byKey.set(url, id);
    if (this.blobUrls.has(id)) {
      URL.revokeObjectURL(this.blobUrls.get(id));
      this.blobUrls.delete(id);
    }
  }

  get(id) {
    return this.items.get(id);
  }

  get size() {
    return this.items.size;
  }

  previewUrl(id) {
    const item = this.items.get(id);
    if (!item) return '';
    if (item.url) return item.url;
    if (!this.blobUrls.has(id) && item.data) {
      const blob = new Blob([item.data], { type: item.mime || 'image/png' });
      this.blobUrls.set(id, URL.createObjectURL(blob));
    }
    return this.blobUrls.get(id) || '';
  }

  /** Подставляет адреса для предпросмотра. */
  resolveForPreview(md) {
    return String(md).replace(TOKEN_RE, (_, id) => this.previewUrl(id) || '#');
  }

  /** Для «Копировать MD» — только удалённые адреса, локальные данные — заглушка. */
  resolveForClipboard(md) {
    return String(md).replace(TOKEN_RE, (_, id) => {
      const it = this.items.get(id);
      return it && it.url ? it.url : 'attachment';
    });
  }

  usedIds(md) {
    const ids = new Set();
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(md))) ids.add(m[1]);
    return [...ids];
  }

  async fetchData(item) {
    if (item.data) return { data: item.data, mime: item.mime };
    if (!item.url) throw new Error('нет данных');
    const res = await requestUrl({
      url: item.url,
      method: 'GET',
      headers: { 'User-Agent': this.settings.userAgent, Referer: item.referer || item.url },
      throw: false,
    });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const mime = U.headerValue(res.headers, 'content-type') || item.mime;
    return { data: res.arrayBuffer, mime };
  }

  /** Папка для вложения: kind = 'image' | 'video' (видео и аудио). */
  attachmentFolder(app, notePath, kind = 'image') {
    const s = this.settings;
    const noteFolder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
    if (s.attachmentsMode === 'obsidian') {
      const cfg = (app.vault.getConfig && app.vault.getConfig('attachmentFolderPath')) || '/';
      if (cfg === '/' || cfg === '') return '';
      if (cfg === './') return noteFolder;
      if (cfg.startsWith('./')) return U.joinPath(noteFolder, cfg.slice(2));
      return normalizePath(cfg);
    }
    const noteName = notePath.split('/').pop().replace(/\.md$/, '');
    const tpl = kind === 'video' ? s.videosFolder || s.imagesFolder : s.imagesFolder || s.attachmentsFolder;
    return normalizePath(U.applyTemplate(tpl || 'attachments', { note: U.sanitizeFileName(noteName) }));
  }

  linkFor(app, file, notePath, alt) {
    if (this.settings.linkStyle === 'markdown') {
      const encoded = file.path.split('/').map(encodeURIComponent).join('/');
      return `![${alt || ''}](${encoded})`;
    }
    const dest = app.metadataCache.getFirstLinkpathDest(file.name, notePath);
    const target = dest && dest.path === file.path ? file.name : file.path;
    return `![[${target}]]`;
  }

  /**
   * Сохраняет используемые вложения в хранилище и заменяет токены.
   * @returns {{md:string, saved:string[], failed:number}}
   */
  async materialize(app, md, notePath, noteTitle, onProgress) {
    const ids = this.usedIds(md);
    if (!ids.length) return { md, saved: [], failed: 0 };
    const s = this.settings;
    const replacements = new Map();
    const saved = [];
    let failed = 0;
    let n = 0;

    for (const id of ids) {
      const item = this.items.get(id);
      n++;
      if (onProgress) onProgress(n, ids.length);
      if (!item) continue;
      const isVideo = item.kind === 'video' || item.kind === 'audio' || /^(video|audio)\//.test(item.mime || '') || /\.(mp4|webm|mov|mp3|ogg|m4a)(\?|$)/i.test(item.url || '');
      const download = isVideo ? s.downloadVideos : this.downloadOverride !== undefined ? this.downloadOverride : s.downloadImages;
      if (!download && item.url) {
        replacements.set(id, { remote: item.url });
        continue;
      }
      try {
        const { data, mime } = await this.fetchData(item);
        const ext = U.extFromMime(mime) || U.extFromUrl(item.url) || U.extFromUrl(item.name) || (isVideo ? 'mp4' : 'png');
        const folder = this.attachmentFolder(app, notePath, isVideo || /^(video|audio)\//.test(mime || '') ? 'video' : 'image');
        const base = U.sanitizeFileName(
          U.applyTemplate(s.imageNaming || '{{note}}_{{n}}', { note: U.slugify(noteTitle), n: U.pad(saved.length + 1) })
        );
        await U.ensureFolder(app, folder);
        const path = U.availablePath(app, folder, base, ext);
        const file = await app.vault.createBinary(path, data);
        saved.push(file.path);
        replacements.set(id, { file, alt: item.alt });
      } catch (e) {
        console.warn('MarkImporter: не удалось сохранить вложение', item.url, e);
        failed++;
        replacements.set(id, { remote: item.url || '' });
      }
    }

    // <video|audio src=token> → встраивание файла хранилища
    md = md.replace(/<(video|audio)\s+src="mi-asset:\/\/([a-z0-9]+)"[^>]*>\s*<\/\1>/g, (all, tag, id) => {
      const r = replacements.get(id);
      if (!r) return all;
      if (r.file) return this.linkFor(app, r.file, notePath, '');
      return r.remote ? `<${tag} src="${U.escapeHtml(r.remote)}" controls${tag === 'video' ? ' width="100%"' : ''}></${tag}>` : '';
    });
    // ![alt](token) и ![alt|w](token) → ссылка хранилища
    let out = md.replace(/!\[([^\]]*)\]\(mi-asset:\/\/([a-z0-9]+)\)/g, (all, alt, id) => {
      const r = replacements.get(id);
      if (!r) return all;
      if (r.file) {
        const link = this.linkFor(app, r.file, notePath, alt);
        const size = /\|(\d+)$/.exec(alt);
        if (size && link.startsWith('![[')) return link.replace(/\]\]$/, `|${size[1]}]]`);
        return link;
      }
      return r.remote ? `![${alt}](${r.remote})` : '';
    });
    // остальные места (HTML src, ссылки) → путь в хранилище
    out = out.replace(TOKEN_RE, (all, id) => {
      const r = replacements.get(id);
      if (!r) return all;
      if (r.file) return r.file.path.split('/').map(encodeURIComponent).join('/');
      return r.remote || '';
    });
    return { md: out, saved, failed };
  }

  dispose() {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
  }
}

module.exports = { AssetRegistry, TOKEN_RE };
