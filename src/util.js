'use strict';

const { normalizePath, TFolder } = require('obsidian');

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function sanitizeFileName(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return clean || 'Без названия';
}

function slugify(name) {
  return (
    sanitizeFileName(name)
      .toLowerCase()
      .replace(/[\s\-–—.,]+/g, '_')
      .replace(/[^\p{L}\p{N}_]/gu, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60) || 'note'
  );
}

function countWords(text) {
  const m = String(text || '').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

function stripMarkdown(md) {
  return String(md || '')
    .replace(/^---[\s\S]*?\n---\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~=`$|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function pad(n, width = 3) {
  return String(n).padStart(width, '0');
}

function isoLocal(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function humanDate(date, withTime = true) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  const p = (x) => String(x).padStart(2, '0');
  const base = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
  return withTime ? `${base}, ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

function shortDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function yamlScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v).replace(/\r?\n/g, ' ').trim();
  if (/^\d{4}-\d{2}-\d{2}(T[\d:]+)?$/.test(s)) return s;
  return JSON.stringify(s);
}

function buildFrontmatter(obj) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const items = value.filter((x) => x !== undefined && x !== null && String(x).trim() !== '');
      if (!items.length) continue;
      lines.push(`${key}:`);
      for (const item of items) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.length > 2 ? lines.join('\n') + '\n' : '';
}

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) return headers[key];
  return '';
}

/** Декодирует HTML/текст с учётом charset (в т.ч. windows-1251). */
function decodeBuffer(buffer, contentType = '', sniffHtml = true) {
  const bytes = new Uint8Array(buffer);
  let charset = (/charset=["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8';
  if (!charset && bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le';
  if (!charset && sniffHtml) {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  if (!charset) {
    // эвристика: валидный UTF-8 или cp1251
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      charset = 'windows-1251';
    }
  }
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch (e) {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function absolutize(url, base) {
  if (!url) return '';
  url = String(url).trim();
  if (/^(data|blob|mi-asset):/i.test(url)) return url;
  try {
    return new URL(url, base || undefined).href;
  } catch (e) {
    return url;
  }
}

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function extFromMime(mime) {
  return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
}

function extFromUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(url || '').split('?')[0]);
  const ext = m ? m[1].toLowerCase() : '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'mp4', 'webm', 'mov', 'mp3', 'ogg', 'm4a', 'pdf'].includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function ensureFolder(app, path) {
  path = normalizePath(path || '/');
  if (!path || path === '/' || path === '.') return;
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) return;
  const parts = path.split('/');
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const f = app.vault.getAbstractFileByPath(cur);
    if (!f) {
      try {
        await app.vault.createFolder(cur);
      } catch (e) {
        /* гонка — папка уже есть */
      }
    }
  }
}

function joinPath(folder, name) {
  folder = (folder || '').replace(/^\/+|\/+$/g, '');
  return normalizePath(folder ? `${folder}/${name}` : name);
}

function availablePath(app, folder, base, ext) {
  let candidate = joinPath(folder, `${base}.${ext}`);
  let i = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = joinPath(folder, `${base} ${i}.${ext}`);
    i++;
  }
  return candidate;
}

function applyTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

function firstLine(text, max = 90) {
  const line = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!line) return '';
  return line.length > max ? line.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : line;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

module.exports = {
  uid,
  sanitizeFileName,
  slugify,
  countWords,
  stripMarkdown,
  formatBytes,
  formatNumber,
  plural,
  pad,
  isoLocal,
  dateKey,
  humanDate,
  shortDate,
  buildFrontmatter,
  headerValue,
  decodeBuffer,
  absolutize,
  extFromMime,
  extFromUrl,
  escapeHtml,
  ensureFolder,
  joinPath,
  availablePath,
  applyTemplate,
  firstLine,
  parseDate,
  debounce,
  arrayBufferToBase64,
  base64ToArrayBuffer,
};
