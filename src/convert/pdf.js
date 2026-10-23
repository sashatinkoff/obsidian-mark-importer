'use strict';

/**
 * PDF → блоки Markdown на встроенном в Obsidian pdf.js.
 *
 * Этап 1 (analyzePdf) — один раз: текстовые элементы с координатами и
 * шрифтами, ссылки из аннотаций, растровые иллюстрации с положением.
 * Этап 2 (buildPdfBlocks) — при каждой смене настроек: колонки, порядок
 * чтения, колонтитулы, заголовки по кеглю, абзацы/переносы, списки,
 * таблицы, подписи, выравнивание, надстрочные индексы.
 */

const { loadPdfJs } = require('obsidian');
const U = require('../util');
const { escText } = require('./html2md');

async function openPdf(buffer) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false });
  const doc = await task.promise;
  return { pdfjs, doc };
}

function parsePdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(s || ''));
  if (!m) return '';
  return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}${m[4] ? `T${m[4]}:${m[5] || '00'}:${m[6] || '00'}` : ''}`;
}

async function pdfMetadata(doc) {
  try {
    const { info } = await doc.getMetadata();
    return {
      title: (info && info.Title) || '',
      author: (info && info.Author) || '',
      published: parsePdfDate(info && (info.CreationDate || info.ModDate)),
      keywords: ((info && info.Keywords) || '')
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  } catch (e) {
    return { title: '', author: '', published: '', keywords: [] };
  }
}

function fontFlags(page, fontName, style, cache) {
  if (cache.has(fontName)) return cache.get(fontName);
  let name = '';
  let bold = false;
  let italic = false;
  try {
    const store = page.commonObjs;
    if (!store.has || store.has(fontName)) {
      const f = store.get(fontName);
      if (f) {
        name = f.name || f.loadedName || '';
        bold = !!(f.bold || f.black);
        italic = !!f.italic;
      }
    }
  } catch (e) {
    /* шрифт ещё не загружен */
  }
  const family = `${name} ${(style && style.fontFamily) || ''}`;
  const info = {
    bold: bold || /bold|black|heavy|semibold|demi|medi\b|-bd\b|cmbx|\bbd\b/i.test(family),
    italic: italic || /italic|oblique|-it\b|cmti|cmsl/i.test(family),
    mono: /mono|courier|consol|cmtt|code/i.test(family) || (style && style.fontFamily === 'monospace'),
  };
  cache.set(fontName, info);
  return info;
}

function getImageObject(page, name) {
  for (const store of name.startsWith('g_') ? [page.commonObjs, page.objs] : [page.objs, page.commonObjs]) {
    try {
      if (!store.has || store.has(name)) {
        const o = store.get(name);
        if (o) return o;
      }
    } catch (e) {
      /* нет в этом хранилище */
    }
  }
  return null;
}

async function imageToBuffer(img) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let mime = 'image/png';
  const source = img.bitmap || (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap ? img : null);
  if (source) {
    canvas.width = source.width;
    canvas.height = source.height;
    ctx.drawImage(source, 0, 0);
  } else if (img.data && img.width && img.height) {
    const { width: w, height: h, kind, data } = img;
    canvas.width = w;
    canvas.height = h;
    const out = ctx.createImageData(w, h);
    const px = out.data;
    if (kind === 3) px.set(data.subarray ? data.subarray(0, w * h * 4) : data.slice(0, w * h * 4));
    else if (kind === 2) {
      mime = 'image/jpeg';
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        px[i * 4] = data[j];
        px[i * 4 + 1] = data[j + 1];
        px[i * 4 + 2] = data[j + 2];
        px[i * 4 + 3] = 255;
      }
    } else if (kind === 1) {
      const rowBytes = (w + 7) >> 3;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const i = (y * w + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = v;
          px[i + 3] = 255;
        }
      }
    } else return null;
    ctx.putImageData(out, 0, 0);
  } else return null;
  const blob = await new Promise((r) => canvas.toBlob(r, mime, 0.9));
  if (!blob) return null;
  return { data: await blob.arrayBuffer(), mime, width: canvas.width, height: canvas.height };
}

/** Этап 1. */
async function analyzePdf(pdfjs, doc, { extractImages = true, onProgress } = {}) {
  const pages = [];
  const fontCache = new Map();
  const OPS = pdfjs.OPS;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    let opList = null;
    try {
      opList = await page.getOperatorList();
    } catch (e) {
      opList = null;
    }
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]) || Math.abs(it.height) || 10;
      if (Math.abs(t[1]) > Math.abs(t[0]) * 0.5) continue; // повёрнутый текст (штампы на полях)
      const f = fontFlags(page, it.fontName, tc.styles && tc.styles[it.fontName], fontCache);
      const w = Math.abs(it.width) * (Math.hypot(t[0], t[1]) / (Math.hypot(it.transform[0], it.transform[1]) || 1)) || it.str.length * size * 0.5;
      items.push({ str: it.str, x: t[4], y: t[5], w, x2: t[4] + w, size, bold: f.bold, italic: f.italic, mono: f.mono });
    }

    const links = [];
    try {
      for (const a of await page.getAnnotations()) {
        const url = a.url || a.unsafeUrl;
        if (a.subtype !== 'Link' || !url || !a.rect || !/^(https?|mailto):/i.test(url)) continue;
        const [ta, tb, tc2, td, te, tf] = vp.transform;
        const pt = (x, y) => [ta * x + tc2 * y + te, tb * x + td * y + tf];
        const p1 = pt(a.rect[0], a.rect[1]);
        const p2 = pt(a.rect[2], a.rect[3]);
        const r = [p1[0], p1[1], p2[0], p2[1]];
        links.push({ x1: Math.min(r[0], r[2]), y1: Math.min(r[1], r[3]), x2: Math.max(r[0], r[2]), y2: Math.max(r[1], r[3]), url });
      }
    } catch (e) {
      /* без аннотаций */
    }

    const images = [];
    if (extractImages && opList) {
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const paintOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat].filter((x) => x !== undefined));
      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === OPS.transform) ctm = pdfjs.Util.transform(ctm, args);
        else if (fn === OPS.paintFormXObjectBegin) {
          stack.push(ctm);
          if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = pdfjs.Util.transform(ctm, args[0]);
        } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (paintOps.has(fn)) {
          const m = pdfjs.Util.transform(vp.transform, ctm);
          const pts = [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
          const xs = pts.map((q) => q[0]);
          const ys = pts.map((q) => q[1]);
          const box = { x: Math.min(...xs), x2: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
          if (box.x2 - box.x < 36 || box.bottom - box.top < 28) continue;
          const key = typeof args[0] === 'string' ? args[0] : `inline-${p}-${i}`;
          const obj = typeof args[0] === 'string' ? getImageObject(page, args[0]) : args[0];
          if (!obj) continue;
          try {
            const buf = await imageToBuffer(obj);
            if (buf) images.push(Object.assign(box, { key, data: buf.data, mime: buf.mime, pxw: buf.width }));
          } catch (e) {
            /* пропускаем битую картинку */
          }
        }
      }
    }

    pages.push({ num: p, width: vp.width, height: vp.height, items, links, images });
    if (onProgress) onProgress(p, doc.numPages);
    try {
      page.cleanup();
    } catch (e) {
      /* ignore */
    }
  }
  return { pages, numPages: doc.numPages };
}

async function renderPageToCanvas(doc, num, scale, canvas) {
  const page = await doc.getPage(num);
  const vp = page.getViewport({ scale });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

async function renderPageImage(doc, num, scale = 1.5) {
  const canvas = document.createElement('canvas');
  await renderPageToCanvas(doc, num, scale, canvas);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { data: await blob.arrayBuffer(), mime: 'image/jpeg' };
}

// ───────────── Этап 2 ─────────────

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Ряды по базовой линии → сегменты, разделённые большими пробелами. */
function buildSegments(items, gutter = null) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    let row = null;
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
      const r = rows[i];
      // элементы одной «строки» не могут перекрываться по горизонтали — иначе это соседние строки
      const overlaps = r.items.some((o) => it.x < o.x2 - 1 && it.x2 > o.x + 1);
      if (!overlaps && Math.abs(r.y - it.y) <= 0.5 * Math.max(Math.min(r.size, it.size * 1.6), it.size)) {
        row = r;
        break;
      }
    }
    if (!row) {
      row = { y: it.y, size: it.size, items: [] };
      rows.push(row);
    }
    row.items.push(it);
    if (it.size > row.size) {
      row.size = it.size;
      row.y = it.y;
    }
  }
  const segments = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let seg = null;
    for (const it of row.items) {
      const gap = seg ? it.x - seg.x2 : 0;
      const crossesGutter = gutter !== null && seg && seg.x2 <= gutter + 2 && it.x >= gutter - 2;
      if (!seg || gap > Math.max(1.1 * row.size, 8) || crossesGutter) {
        seg = { y: row.y, size: 0, x: it.x, x2: it.x2, items: [] };
        segments.push(seg);
      }
      seg.items.push(it);
      seg.x2 = Math.max(seg.x2, it.x2);
    }
  }
  for (const s of segments) {
    // кегль сегмента — по числу символов
    const bySize = new Map();
    for (const it of s.items) {
      const k = Math.round(it.size * 2) / 2;
      bySize.set(k, (bySize.get(k) || 0) + it.str.length);
    }
    s.size = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0];
    s.text = segText(s.items);
  }
  return segments;
}

function segText(items) {
  let out = '';
  let prev = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - prev.x2;
      if (gap > 0.12 * Math.min(prev.size, it.size) && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+/g, ' ');
}

function findGutter(items, width) {
  const boxes = items.filter((it) => it.x2 - it.x > 0);
  if (boxes.length < 12) return null;
  const n = boxes.length;
  let best = null;
  for (let x = width * 0.3; x <= width * 0.7; x += 1) {
    let cross = 0;
    let left = 0;
    let right = 0;
    for (const b of boxes) {
      if (b.x2 <= x) left++;
      else if (b.x >= x) right++;
      else cross++;
    }
    if (left < n * 0.15 || right < n * 0.15 || cross > n * 0.08) continue;
    const score = cross * 1000 + Math.abs(x - width / 2);
    if (!best || score < best.score) best = { x, score };
  }
  if (!best) return null;
  // строк по обе стороны должно быть много на одних и тех же высотах — иначе это не колонки
  const lefts = new Set(boxes.filter((b) => b.x2 <= best.x).map((b) => Math.round(b.y / 4)));
  const rights = boxes.filter((b) => b.x >= best.x).map((b) => Math.round(b.y / 4));
  const shared = rights.filter((y) => lefts.has(y)).length;
  return shared >= Math.min(4, rights.length * 0.3) ? best.x : null;
}

/** Буквица: крупная одиночная заглавная перед абзацем → приклеиваем к первому слову. */
function fixDropCaps(items, body) {
  const out = items.slice();
  for (const cap of items) {
    const t = cap.str.trim();
    if (t.length !== 1 || !/\p{Lu}/u.test(t) || cap.size < body * 1.8) continue;
    const capTop = cap.y - cap.size * 0.8;
    const near = items
      .filter((it) => it !== cap && it.size < cap.size * 0.7 && it.x >= cap.x2 - 2 && it.x <= cap.x2 + cap.size * 1.2 && it.y - it.size >= capTop - body && it.y <= cap.y + body * 0.5)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (!near.length) continue;
    const first = near[0];
    const idx = out.indexOf(first);
    out[idx] = Object.assign({}, first, { str: t + first.str.replace(/^\s+/, ''), x: cap.x });
    out.splice(out.indexOf(cap), 1);
    // строки рядом с буквицей сдвинуты вправо — это не отступ абзаца
    for (const it of near.slice(1)) {
      const k = out.indexOf(it);
      if (k >= 0 && it.y <= cap.y + body * 0.5) out[k] = Object.assign({}, it, { noIndent: true });
    }
  }
  return out;
}

/**
 * Порядок чтения рекурсивным разрезанием страницы (XY-cut): по вертикальным
 * просветам — колонки и врезки, по горизонтальным — полосы. Так блочная
 * вёрстка (журнальные колонки, сайдбары, иллюстрации поперёк) читается
 * сверху вниз внутри каждой колонки, а таблицы не разваливаются на столбцы.
 */
function readingOrder(page, body) {
  const items = fixDropCaps(page.items, body);
  const segs = buildSegments(items, null);
  const boxes = [];
  for (const sg of segs) boxes.push({ top: sg.y - sg.size * 0.9, bottom: sg.y + sg.size * 0.25, x: sg.x, x2: sg.x2, seg: sg, chars: sg.text.trim().length });
  for (const im of page.images) boxes.push({ top: im.top, bottom: im.bottom, x: im.x, x2: im.x2, img: { image: im, y: im.top, x: im.x, x2: im.x2, size: 0, items: [] }, chars: 0 });
  page.columns = {};
  const out = [];

  const vGap = (list) => {
    const sorted = list.slice().sort((a, b) => a.x - b.x);
    const gaps = [];
    let end = sorted[0].x2;
    for (const b of sorted.slice(1)) {
      if (b.x > end + Math.max(body * 0.9, 6)) gaps.push({ at: (end + b.x) / 2, width: b.x - end, left: end, right: b.x });
      end = Math.max(end, b.x2);
    }
    let best = null;
    for (const g of gaps) {
      const L = list.filter((b) => b.x2 <= g.left + 0.5);
      const R = list.filter((b) => b.x >= g.right - 0.5);
      const prose = (side) => {
        const text = side.filter((b) => b.seg);
        if (side.some((b) => b.img) && text.length === 0) return true;
        if (text.length < 2) return side.some((b) => b.img);
        return text.reduce((n, b) => n + b.chars, 0) / text.length >= 12;
      };
      if (!prose(L) || !prose(R)) continue;
      // стороны должны идти «рядом», а не одна над другой
      const top = (side) => Math.min(...side.map((b) => b.top));
      const bottom = (side) => Math.max(...side.map((b) => b.bottom));
      const overlap = Math.min(bottom(L), bottom(R)) - Math.max(top(L), top(R));
      if (overlap < body * 2) continue;
      if (!best || g.width > best.width) best = Object.assign(g, { L, R });
    }
    return best;
  };

  const hBands = (list, minGap) => {
    const sorted = list.slice().sort((a, b) => a.top - b.top);
    const bands = [[sorted[0]]];
    let end = sorted[0].bottom;
    for (const b of sorted.slice(1)) {
      if (b.top > end + minGap) bands.push([b]);
      else bands[bands.length - 1].push(b);
      end = Math.max(end, b.bottom);
    }
    return bands;
  };

  const leaf = (list, colId) => {
    const c = page.columns[colId] || { x: Infinity, x2: -Infinity };
    for (const b of list) {
      c.x = Math.min(c.x, b.x);
      c.x2 = Math.max(c.x2, b.x2);
    }
    page.columns[colId] = c;
    const units = list.map((b) => {
      const u = b.seg || b.img;
      u.col = colId;
      return u;
    });
    out.push(...mergeLines(units.sort((a, b) => a.y - b.y || a.x - b.x)));
  };

  const cut = (list, colId, depth) => {
    if (!list.length) return;
    if (list.length === 1 || depth > 14) return leaf(list, colId);
    const v = vGap(list);
    if (v) {
      cut(v.L, colId + 'L', depth + 1);
      cut(v.R, colId + 'R', depth + 1);
      return;
    }
    // сначала только крупные просветы (между шапкой, разделами, иллюстрациями поперёк),
    // затем — межабзацные; колонки при этом не режутся на строки
    for (const minGap of [body * 1.4, body * 0.55]) {
      const bands = hBands(list, minGap);
      if (bands.length > 1) {
        for (const b of bands) cut(b, colId, depth + 1);
        return;
      }
    }
    leaf(list, colId);
  };
  if (boxes.length) cut(boxes, 'c', 0);
  return out;
}

/** Сегменты одной колонки на одной базовой линии → строка с ячейками. */
function mergeLines(list) {
  const lines = [];
  for (const s of list) {
    if (s.image) {
      lines.push(s);
      continue;
    }
    const last = lines[lines.length - 1];
    if (last && !last.image && Math.abs(last.y - s.y) <= 0.5 * Math.max(last.size, s.size)) {
      last.cells.push(s);
      last.x2 = Math.max(last.x2, s.x2);
      last.x = Math.min(last.x, s.x);
      last.items = last.items.concat(s.items);
      continue;
    }
    lines.push({ y: s.y, x: s.x, x2: s.x2, size: s.size, col: s.col, cells: [s], items: s.items.slice() });
  }
  for (const l of lines) {
    if (l.image) continue;
    l.cells.sort((a, b) => a.x - b.x);
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.cells.map((c) => c.text).join(' ').trim();
  }
  return lines;
}

const LIST_RE = /^\s*([•◦▪●○■□►▸‣∙·–—*-]|\(?\d{1,3}[.)]|\(?[a-zа-я][.)])\s+/i;
const CAPTION_RE = /^(fig\.?|figure|рис\.?|рисунок|table|таблица|табл\.)\s*\d+/i;
const SENTENCE_END = /[.!?:;…»"”)\]]$/;

function buildPdfBlocks(analysis, opts, assets, pageImageTokens) {
  const o = Object.assign({ removeHeaders: true, tablesMarkdown: true, preserveStyles: true, extractImages: true, pageImages: false }, opts);
  const pages = analysis.pages;

  // кегль основного текста
  const sizeChars = new Map();
  let totalChars = 0;
  for (const pg of pages)
    for (const it of pg.items) {
      const k = Math.round(it.size * 2) / 2;
      sizeChars.set(k, (sizeChars.get(k) || 0) + it.str.length);
      totalChars += it.str.length;
    }
  const body = sizeChars.size ? [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0][0] : 10;

  // порядок чтения
  const flows = pages.map((pg) => readingOrder(pg, body));

  // колонтитулы
  const removed = new Set();
  if (o.removeHeaders && pages.length === 1) {
    const H = pages[0].height;
    for (const l of flows[0]) {
      if (l.image || !(l.y < H * 0.06 || l.y > H * 0.95)) continue;
      const t = l.text.trim();
      if (/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(t) || (l.size <= body * 0.9 && U.countWords(t) <= 10)) removed.add(l);
    }
  }
  if (o.removeHeaders && pages.length > 1) {
    const counts = new Map();
    const keyOf = (l) => l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    flows.forEach((lines, pi) => {
      const H = pages[pi].height;
      const seen = new Set();
      for (const l of lines) {
        if (l.image || (l.y > H * 0.09 && l.y < H * 0.93)) continue;
        const k = keyOf(l);
        if (seen.has(k)) continue;
        seen.add(k);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    });
    const threshold = Math.max(2, Math.ceil(pages.length * 0.4));
    flows.forEach((lines, pi) => {
      const H = pages[pi].height;
      for (const l of lines) {
        const inMargin = l.y < H * 0.09 || l.y > H * 0.93 || (l.image && (l.image.bottom < H * 0.1 || l.image.top > H * 0.92));
        if (!inMargin) continue;
        if (l.image) {
          // логотипы на каждой странице
          const same = pages.filter((p) => p.images.some((im) => im.key === l.image.key)).length;
          if (same >= threshold) removed.add(l);
          continue;
        }
        const k = keyOf(l);
        const pageNum = /^(стр\.?|страница|page|p\.)?\s*#(\s*(из|of|\/)\s*#)?$|^[-–—]?\s*#\s*[-–—]?$|^[ivxlc]+$/i.test(k);
        if (pageNum || (counts.get(k) || 0) >= threshold) removed.add(l);
      }
    });
  }

  // уровни заголовков по кеглю
  const headingSizes = [...sizeChars.entries()]
    .filter(([s, n]) => s >= body * 1.15 && n >= 4 && n < totalChars * 0.3)
    .map(([s]) => s)
    .sort((a, b) => b - a);
  const levelOf = (size) => {
    const idx = headingSizes.findIndex((s) => Math.abs(s - size) < 0.6);
    if (idx < 0) return 0;
    return Math.min(idx + 1, 4);
  };
  const boldLevel = Math.min(headingSizes.length + 1, 4) || 3;

  // типичный межстрочный интервал
  const gaps = [];
  for (const lines of flows) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1];
      const b = lines[i];
      if (a.image || b.image || a.col !== b.col) continue;
      if (Math.abs(a.size - body) < 0.6 && Math.abs(b.size - body) < 0.6) {
        const g = b.y - a.y;
        if (g > 0 && g < body * 3) gaps.push(g);
      }
    }
  }
  const lineGap = median(gaps) || body * 1.25;

  const blocks = [];
  let para = null; // { kind:'paragraph'|'list', lines:[{md,plain,line}], size, align }
  let tableRun = [];

  const colBounds = (page, line) => {
    const col = page.columns && page.columns[line.col] ? page.columns[line.col] : { x: 0, x2: page.width };
    return col;
  };

  // фактические края текста в колонке (левое поле, правое поле)
  const marginCache = new Map();
  const margins = (pi, line) => {
    const key = `${pi}:${line.col}`;
    if (marginCache.has(key)) return marginCache.get(key);
    const lines = flows[pi].filter((l) => !l.image && l.col === line.col && Math.abs(l.size - body) < 1);
    const xs = lines.map((l) => Math.round(l.x));
    const counts = new Map();
    for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
    const left = xs.length ? +[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : colBounds(pages[pi], line).x;
    const rights = lines.map((l) => l.x2).sort((a, b) => a - b);
    const right = rights.length ? rights[Math.floor(rights.length * 0.9)] : colBounds(pages[pi], line).x2;
    const m = { left, right };
    marginCache.set(key, m);
    return m;
  };

  const runsToMd = (items, line, html = false, plainOnly = false) => {
    const page = line.page;
    let out = '';
    let cur = null;
    const flush = () => {
      if (!cur) return;
      let text = cur.text;
      if (!plainOnly) {
        if (html) {
          text = U.escapeHtml(text);
          if (cur.sup) text = `<sup>${text}</sup>`;
          if (cur.bold) text = `<b>${text}</b>`;
          if (cur.italic) text = `<i>${text}</i>`;
          if (cur.link) text = `<a href="${U.escapeHtml(cur.link)}">${text}</a>`;
        } else if (cur.mono && text.trim()) {
          text = wrapKeep(text, '`', true);
        } else {
          text = escText(text);
          if (cur.sup && o.preserveStyles && text.trim()) text = `<sup>${text.trim()}</sup>`;
          if (cur.bold) text = wrapKeep(text, '**');
          if (cur.italic) text = wrapKeep(text, '*');
          if (cur.link && text.trim()) text = wrapLink(text, cur.link);
        }
      }
      out += text;
      cur = null;
    };
    let prev = null;
    for (const it of items) {
      const sup = it.size < line.size * 0.8 && line.y - it.y > line.size * 0.2;
      const link = page ? linkAt(page, it) : null;
      const key = `${it.bold ? 'b' : ''}${it.italic ? 'i' : ''}${it.mono ? 'm' : ''}${sup ? 's' : ''}|${link || ''}`;
      let space = '';
      if (prev) {
        const gap = it.x - prev.x2;
        if (gap > 0.12 * Math.min(prev.size, it.size) && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) space = ' ';
      }
      if (!cur || cur.key !== key) {
        flush();
        out += space;
        cur = { key, text: it.str, bold: it.bold, italic: it.italic, mono: it.mono, sup, link };
      } else {
        cur.text += space + it.str;
      }
      prev = it;
    }
    flush();
    return out.replace(/\s+/g, ' ').trim();
  };

  const flushPara = () => {
    if (!para) return;
    const p = para;
    para = null;
    if (!p.lines.length) return;
    if (p.kind === 'list') {
      const md = p.lines
        .map((l) => {
          const m = LIST_RE.exec(l.plain);
          const isNum = m && /\d/.test(m[1]);
          const body = l.md.replace(/^\s*(\\?[•◦▪●○■□►▸‣∙·–—*-]|\(?\d{1,3}\\?[.)]|\(?[a-zа-я]\\?[.)])\s+/i, '');
          return `${isNum ? m[1].replace(/\D/g, '') + '.' : '-'} ${body}`;
        })
        .join('\n');
      blocks.push({ type: 'list', md, text: p.lines.map((l) => l.plain).join(' ').slice(0, 200), page: p.page });
      return;
    }
    let md = '';
    let plain = '';
    p.lines.forEach((l, i) => {
      if (i === 0) {
        md = l.md;
        plain = l.plain;
        return;
      }
      const prev = p.lines[i - 1];
      if (prev.hardBreak) {
        md += '  \n' + l.md;
        plain += '\n' + l.plain;
      } else if (/[\p{L}]-$/u.test(prev.plain) && /^\p{Ll}/u.test(l.plain)) {
        md = md.replace(/-(\**)$/, '$1') + l.md;
        plain = plain.replace(/-$/, '') + l.plain;
      } else {
        md += ' ' + l.md;
        plain += ' ' + l.plain;
      }
    });
    // одинаковое выделение на соседних строках — одним фрагментом
    md = md.replace(/\*\* \*\*/g, ' ').replace(/(?<!\*)\* \*(?!\*)/g, ' ');
    if (p.caption) {
      blocks.push({ type: 'paragraph', md: `*${md.replace(/^\*+|\*+$/g, '')}*`, text: plain, caption: true, page: p.page });
      return;
    }
    // выравнивание по центру в PDF не переносим как HTML — это ломало вёрстку в Obsidian
    if (p.size >= body * 1.12 && U.countWords(plain) > 6 && /^[«"“„—–]/.test(plain.trim())) {
      // крупный многострочный текст — вынос/лид: цитата
      const quoted = md.split('\n').map((l) => `> ${l}`).join('\n');
      blocks.push({ type: 'quote', md: o.callouts ? `> [!quote]\n${quoted}` : quoted, text: plain, page: p.page });
      return;
    }
    md = md
      .split('\n')
      .map((l) => l.replace(/^(\s*)(#{1,6}\s)/, '$1\\$2').replace(/^(\s*)>/, '$1\\>'))
      .join('\n');
    blocks.push({ type: 'paragraph', md, text: plain, page: p.page });
  };

  const flushTable = () => {
    if (!tableRun.length) return;
    const run = tableRun;
    tableRun = [];
    const ok = run.length >= 3 || (run.length >= 2 && run.every((l) => l.cells.length >= 3));
    if (!ok) {
      for (const l of run) handleTextLine(l, true);
      return;
    }
    const tol = body * 1.2;
    const starts = [];
    for (const l of run) for (const c of l.cells) starts.push(c.x);
    starts.sort((a, b) => a - b);
    const clusters = [];
    for (const x of starts) {
      const last = clusters[clusters.length - 1];
      if (last && x - last.max <= tol) {
        last.max = x;
        last.n++;
      } else clusters.push({ min: x, max: x, n: 1 });
    }
    const anchors = clusters.filter((c) => c.n >= Math.ceil(run.length * 0.5)).map((c) => c.min);
    if (anchors.length < 2) {
      for (const l of run) handleTextLine(l, true);
      return;
    }
    const rows = run.map((l) => {
      const cells = anchors.map(() => []);
      for (const c of l.cells) {
        let idx = 0;
        for (let i = 0; i < anchors.length; i++) if (c.x + tol >= anchors[i]) idx = i;
        cells[idx].push(runsToMd(c.items, Object.assign({}, l, { page: l.page })));
      }
      return cells.map((x) => x.join(' ').replace(/\|/g, '\\|').trim());
    });
    // настоящая таблица — короткие ячейки; длинные «ячейки» = текст в соседних блоках
    const cells = rows.flat().filter(Boolean);
    const avg = cells.reduce((n, c) => n + c.length, 0) / Math.max(1, cells.length);
    const filled = rows.filter((r) => r.filter(Boolean).length >= 2).length;
    if (avg > 45 || filled < Math.ceil(rows.length * 0.6)) {
      for (const l of run) handleTextLine(l, true);
      return;
    }
    let md;
    if (o.tablesMarkdown) {
      const line = (cells) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
      md = [line(rows[0]), `| ${anchors.map(() => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    } else {
      const tr = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${U.escapeHtml(c)}</${tag}>`).join('')}</tr>`;
      md = `<table>\n${tr(rows[0], 'th')}\n${rows.slice(1).map((r) => tr(r, 'td')).join('\n')}\n</table>`;
    }
    blocks.push({ type: 'table', md, text: rows.map((r) => r.join(' · ')).join(' / ').slice(0, 200), page: run[0].pageNum });
  };

  let prevLine = null;

  const handleTextLine = (line, fromTable = false) => {
    const pi = line.pageIndex;
    const page = pages[pi];
    const plain = runsToMd(line.items, line, false, true);
    if (!plain) return;
    const md = runsToMd(line.items, line);
    const m = margins(pi, line);
    const col = colBounds(page, line);
    const colWidth = m.right - m.left || col.x2 - col.x;

    // заголовок по кеглю
    let level = levelOf(line.size);
    const allBold = line.items.every((it) => it.bold);
    if (!level && allBold && plain.length < 90 && !SENTENCE_END.test(plain) && /^(\d+(\.\d+)*\.?\s+\S|[\p{Lu}])/u.test(plain) && line.size >= body * 0.95 && !LIST_RE.test(plain)) {
      level = boldLevel;
    }
    const words = U.countWords(plain);
    const looksLikeHeading = level && plain.length < 200 && !CAPTION_RE.test(plain) && words <= 16 && !(/[.!?…]$/.test(plain) && words > 6);
    if (looksLikeHeading) {
      const last = blocks[blocks.length - 1];
      const continues = !para && last && last.type === 'heading' && last.level === level && prevLine && !prevLine.image && line.y - prevLine.y < line.size * 1.8 && line.pageIndex === prevLine.pageIndex && prevLine.col === line.col;
      const merged = continues ? `${last.text} ${plain}` : '';
      if (continues && (U.countWords(merged) > 16 || (/[.!?…]$/.test(plain) && U.countWords(merged) > 6))) {
        // это не заголовок, а крупный многострочный текст (вынос, лид) — переводим в абзац
        blocks.pop();
        para = { kind: 'paragraph', lines: (last.rawLines || [{ md: escText(last.text), plain: last.text, line: prevLine }]).slice(), size: line.size, page: page.num, align: null, caption: false, indentedStart: false };
      } else if (continues) {
        last.md += ' ' + escText(plain);
        last.text += ' ' + plain;
        last.rawLines.push({ md, plain, line });
        prevLine = line;
        return;
      } else {
        flushPara();
        blocks.push({ type: 'heading', level, md: `${'#'.repeat(level)} ${escText(plain)}`, text: plain, page: page.num, rawLines: [{ md, plain, line }] });
        prevLine = line;
        return;
      }
    }

    const isList = LIST_RE.test(plain);
    const afterImage = prevLine && prevLine.image && line.size <= body * 0.92 && line.y - prevLine.image.bottom < body * 3;
    const isCaption = CAPTION_RE.test(plain) || !!afterImage;
    const center = (line.x + line.x2) / 2;
    const colCenter = (m.left + m.right) / 2;
    const leftGap = line.x - m.left;
    const rightGap = m.right - line.x2;
    const centered =
      !line.items.some((it) => it.noIndent) &&
      Math.abs(center - colCenter) < body * 1.2 &&
      Math.abs(leftGap - rightGap) < body * 0.8 &&
      line.x2 - line.x < colWidth * 0.75 &&
      leftGap > body * 2;
    const indented = line.x > m.left + body * 0.8 && !line.items.some((it) => it.noIndent);
    const lineEntry = { md, plain, html: runsToMd(line.items, line, true), line };

    let startNew = !para;
    if (para && prevLine && !prevLine.image) {
      const samePage = prevLine.pageIndex === line.pageIndex;
      const sameCol = samePage && prevLine.col === line.col;
      const gap = line.y - prevLine.y;
      const prevEntry = para.lines[para.lines.length - 1];
      const nextWord = plain.split(/\s+/)[0] || '';
      const charW = (line.x2 - line.x) / Math.max(1, plain.length);
      const prevShort = prevLine.x2 < m.right - body * 2 && m.right - prevLine.x2 > (nextWord.length + 1) * charW;
      if (Math.abs(line.size - para.size) > para.size * 0.15) startNew = true;
      else if (isList || isCaption) startNew = true;
      else if (para.kind === 'list' && !indented && !sameCol) startNew = true;
      else if (sameCol && gap > lineGap * 1.45) startNew = true;
      else if (sameCol && gap < 0) startNew = true;
      else if (!sameCol && SENTENCE_END.test(prevEntry.plain)) startNew = true;
      else if (para.kind === 'paragraph' && indented && !para.indentedStart && !centered) startNew = true;
      else if (para.align && !centered) startNew = true;
      else if (!para.align && centered && para.kind === 'paragraph' && para.lines.length > 0 && !prevShort) startNew = true;
      else if (para.kind === 'paragraph' && sameCol && prevShort) {
        if (SENTENCE_END.test(prevEntry.plain) && !para.align) startNew = true;
        else prevEntry.hardBreak = true; // стихи, адреса — сохраняем переносы
      }
      if (para && para.kind === 'list' && !isList && !startNew) {
        // продолжение пункта списка
        const last = para.lines[para.lines.length - 1];
        last.md += ' ' + md;
        last.plain += ' ' + plain;
        prevLine = line;
        return;
      }
    }
    if (startNew) {
      if (!(para && para.kind === 'list' && isList)) {
        flushPara();
        para = {
          kind: isList ? 'list' : 'paragraph',
          lines: [],
          size: line.size,
          page: page.num,
          align: centered && !isList ? 'center' : null,
          caption: isCaption,
          indentedStart: indented,
        };
      }
    }
    para.lines.push(lineEntry);
    prevLine = line;
  };

  flows.forEach((lines, pi) => {
    const page = pages[pi];
    if (o.pageImages && pageImageTokens && pageImageTokens[pi]) {
      flushTable();
      flushPara();
      blocks.push({ type: 'image', md: `![Страница ${page.num}](${pageImageTokens[pi]})`, text: `Страница ${page.num}`, page: page.num, pageImage: true });
    }
    for (const line of lines) {
      if (removed.has(line)) continue;
      line.pageIndex = pi;
      line.pageNum = page.num;
      line.page = page;
      if (line.image) {
        if (!o.extractImages || o.pageImages) continue;
        flushTable();
        flushPara();
        const token = assets.add({ data: line.image.data, mime: line.image.mime, name: `page${page.num}` });
        const w = Math.round(line.image.x2 - line.image.x);
        const width = o.preserveStyles && w < page.width * 0.6 ? `|${Math.round(w * 1.33)}` : '';
        blocks.push({ type: 'image', md: `![${width}](${token})`, text: `Иллюстрация, стр. ${page.num}`, page: page.num });
        prevLine = line;
        continue;
      }
      if (line.cells.length >= 2) {
        const last = tableRun[tableRun.length - 1];
        if (!last || (last.pageIndex === pi && line.y - last.y < lineGap * 2.6 && last.col === line.col)) {
          tableRun.push(line);
          continue;
        }
        flushTable();
        tableRun.push(line);
        continue;
      }
      flushTable();
      handleTextLine(line);
    }
    flushTable();
  });
  flushPara();

  // подписи к рисункам — сразу после иллюстраций, если стоят рядом
  return blocks.filter((b) => b.md && b.md.trim());
}

function linkAt(page, it) {
  if (!page.links || !page.links.length) return null;
  const cx = it.x + it.w / 2;
  const cy = it.y - it.size / 3;
  for (const l of page.links) if (cx >= l.x1 - 1 && cx <= l.x2 + 1 && cy >= l.y1 - 2 && cy <= l.y2 + 2) return l.url;
  return null;
}

function wrapKeep(text, marker, raw = false) {
  if (!text.trim()) return text;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const core = raw ? text.trim().replace(/`/g, "'") : text.trim();
  return `${lead}${marker}${core}${marker}${trail}`;
}

function wrapLink(text, url) {
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  return `${lead}[${text.trim()}](${String(url).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')})${trail}`;
}

/** Титул документа: самый крупный текст первой страницы. */
function guessTitle(analysis) {
  const p = analysis.pages[0];
  if (!p || !p.items.length) return '';
  const max = Math.max(...p.items.map((i) => i.size));
  const top = p.items.filter((i) => Math.abs(i.size - max) < 0.6).sort((a, b) => a.y - b.y || a.x - b.x);
  const text = segText(top).trim();
  return text.length > 3 && text.length < 250 ? text : '';
}

module.exports = { openPdf, analyzePdf, buildPdfBlocks, renderPageToCanvas, renderPageImage, pdfMetadata, guessTitle };
