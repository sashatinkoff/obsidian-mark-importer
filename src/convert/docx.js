'use strict';

/**
 * DOCX → HTML (затем обычный конвейер HTML → Markdown).
 * Поддерживаются: заголовки (стили Heading/Заголовок, Title), списки с
 * вложенностью и нумерацией, таблицы с объединёнными ячейками, жирный/курсив/
 * подчёркнутый/зачёркнутый, цвет и выделение, над/подстрочные, ссылки,
 * картинки (с шириной), цитаты и код по стилям, выравнивание абзацев.
 */

const { readZip } = require('./zip');
const U = require('../util');

const W = (el, name) => {
  if (!el) return null;
  for (const c of el.children) if (c.localName === name) return c;
  return null;
};
const Ws = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const val = (el) => (el ? el.getAttribute('w:val') || el.getAttribute('val') : null);
const isOn = (el) => !!el && !['0', 'false', 'none'].includes(String(val(el) || '').toLowerCase());

function parseXml(text) {
  return text ? new DOMParser().parseFromString(text, 'application/xml') : null;
}

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', emf: 'image/emf', wmf: 'image/wmf' };

async function docxToHtml(buffer, assets) {
  const zip = await readZip(buffer);
  const doc = parseXml(await zip.text('word/document.xml'));
  if (!doc) throw new Error('В архиве нет word/document.xml');
  const rels = new Map();
  const relDoc = parseXml(await zip.text('word/_rels/document.xml.rels'));
  if (relDoc) {
    for (const r of relDoc.getElementsByTagName('Relationship')) {
      rels.set(r.getAttribute('Id'), { target: r.getAttribute('Target'), external: r.getAttribute('TargetMode') === 'External' });
    }
  }

  // стили
  const styles = new Map();
  const stylesDoc = parseXml(await zip.text('word/styles.xml'));
  if (stylesDoc) {
    for (const s of stylesDoc.getElementsByTagNameNS('*', 'style')) {
      const id = s.getAttribute('w:styleId');
      const nameEl = W(s, 'name');
      const pPr = W(s, 'pPr');
      const outline = pPr ? W(pPr, 'outlineLvl') : null;
      const basedOn = val(W(s, 'basedOn'));
      const sNum = pPr ? W(pPr, 'numPr') : null;
      styles.set(id, {
        name: (val(nameEl) || id || '').toLowerCase(),
        outline: outline ? +val(outline) : null,
        basedOn,
        numId: sNum ? val(W(sNum, 'numId')) : null,
        ilvl: sNum && W(sNum, 'ilvl') ? +val(W(sNum, 'ilvl')) : null,
      });
    }
  }
  const styleKind = (id) => {
    let cur = styles.get(id);
    let guard = 0;
    while (cur && guard++ < 6) {
      const n = cur.name;
      let m = /^(?:heading|заголовок)\s*(\d)$/.exec(n);
      if (m) return { kind: 'heading', level: Math.min(+m[1], 6) };
      if (n === 'title' || n === 'название' || n === 'заголовок') return { kind: 'heading', level: 1 };
      if (n === 'subtitle' || n === 'подзаголовок') return { kind: 'heading', level: 2 };
      if (cur.outline !== null && cur.outline < 6) return { kind: 'heading', level: cur.outline + 1 };
      if (/quote|цитата/.test(n)) return { kind: 'quote' };
      if (/code|preformatted|source|код/.test(n)) return { kind: 'code' };
      if (/caption|название объекта|подпись/.test(n)) return { kind: 'caption' };
      cur = cur.basedOn ? styles.get(cur.basedOn) : null;
    }
    return { kind: 'p' };
  };

  // нумерация
  const numFormats = new Map(); // numId → ilvl → fmt
  const numDoc = parseXml(await zip.text('word/numbering.xml'));
  if (numDoc) {
    const abstract = new Map();
    for (const a of numDoc.getElementsByTagNameNS('*', 'abstractNum')) {
      const lv = new Map();
      for (const l of Ws(a, 'lvl')) lv.set(+l.getAttribute('w:ilvl'), val(W(l, 'numFmt')) || 'bullet');
      abstract.set(a.getAttribute('w:abstractNumId'), lv);
    }
    for (const n of numDoc.getElementsByTagNameNS('*', 'num')) {
      const aid = val(W(n, 'abstractNumId'));
      if (abstract.has(aid)) numFormats.set(n.getAttribute('w:numId'), abstract.get(aid));
    }
  }

  // метаданные
  const meta = { title: '', author: '', published: '' };
  const core = parseXml(await zip.text('docProps/core.xml'));
  if (core) {
    const g = (name) => {
      const el = core.getElementsByTagNameNS('*', name)[0];
      return el ? el.textContent.trim() : '';
    };
    meta.title = g('title');
    meta.author = g('creator');
    meta.published = g('created');
  }

  const imageHtml = async (rid, widthPx) => {
    const rel = rels.get(rid);
    if (!rel) return '';
    if (rel.external) return `<img src="${U.escapeHtml(rel.target)}">`;
    const path = rel.target.startsWith('/') ? rel.target.slice(1) : `word/${rel.target}`.replace(/\/\.\//g, '/');
    const data = await zip.bytes(path.replace(/word\/\.\.\//, ''));
    if (!data) return '';
    const ext = (path.split('.').pop() || 'png').toLowerCase();
    if (ext === 'emf' || ext === 'wmf') return ''; // браузер не отображает векторные форматы Office
    const token = assets.add({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), mime: EXT_MIME[ext] || 'image/png', name: path.split('/').pop() });
    return `<img src="${token}"${widthPx ? ` width="${widthPx}"` : ''}>`;
  };

  const runHtml = async (r) => {
    const rPr = W(r, 'rPr');
    let text = '';
    for (const c of r.children) {
      switch (c.localName) {
        case 't':
        case 'delText':
          if (c.localName === 't') text += U.escapeHtml(c.textContent);
          break;
        case 'tab':
          text += ' ';
          break;
        case 'br':
        case 'cr':
          if ((c.getAttribute('w:type') || '') !== 'page') text += '<br>';
          break;
        case 'noBreakHyphen':
          text += '‑';
          break;
        case 'sym':
          text += c.getAttribute('w:char') ? String.fromCharCode(parseInt(c.getAttribute('w:char'), 16) & 0xffff) : '';
          break;
        case 'drawing': {
          const blip = c.getElementsByTagNameNS('*', 'blip')[0];
          const extent = c.getElementsByTagNameNS('*', 'extent')[0];
          const w = extent ? Math.round(+extent.getAttribute('cx') / 9525) : 0;
          if (blip) text += await imageHtml(blip.getAttribute('r:embed') || blip.getAttribute('r:link'), w);
          break;
        }
        case 'pict':
        case 'object': {
          const im = c.getElementsByTagNameNS('*', 'imagedata')[0];
          if (im) text += await imageHtml(im.getAttribute('r:id'), 0);
          break;
        }
        default:
          break;
      }
    }
    if (!text) return '';
    if (rPr) {
      const fonts = W(rPr, 'rFonts');
      const fontName = fonts ? `${fonts.getAttribute('w:ascii') || ''} ${fonts.getAttribute('w:hAnsi') || ''}` : '';
      if (/courier|consolas|mono|menlo/i.test(fontName)) text = `<code>${text}</code>`;
      const va = val(W(rPr, 'vertAlign'));
      if (va === 'superscript') text = `<sup>${text}</sup>`;
      if (va === 'subscript') text = `<sub>${text}</sub>`;
      if (isOn(W(rPr, 'strike')) || isOn(W(rPr, 'dstrike'))) text = `<s>${text}</s>`;
      if (W(rPr, 'u') && isOn(W(rPr, 'u'))) text = `<u>${text}</u>`;
      if (W(rPr, 'i') && isOn(W(rPr, 'i'))) text = `<em>${text}</em>`;
      if (W(rPr, 'b') && isOn(W(rPr, 'b'))) text = `<strong>${text}</strong>`;
      const hl = val(W(rPr, 'highlight'));
      if (hl && hl !== 'none') text = `<mark>${text}</mark>`;
      const shd = W(rPr, 'shd');
      const color = val(W(rPr, 'color'));
      if (color && color !== 'auto' && /^[0-9a-f]{6}$/i.test(color)) text = `<span style="color:#${color}">${text}</span>`;
      if (!hl && shd && /^[0-9a-f]{6}$/i.test(shd.getAttribute('w:fill') || '') && shd.getAttribute('w:fill').toLowerCase() !== 'ffffff') {
        text = `<span style="background-color:#${shd.getAttribute('w:fill')}">${text}</span>`;
      }
    }
    return text;
  };

  const inlineHtml = async (parent) => {
    let out = '';
    for (const c of parent.children) {
      switch (c.localName) {
        case 'r':
          out += await runHtml(c);
          break;
        case 'hyperlink': {
          const inner = await inlineHtml(c);
          const rid = c.getAttribute('r:id');
          const href = rid && rels.get(rid) ? rels.get(rid).target : '';
          out += href ? `<a href="${U.escapeHtml(href)}">${inner}</a>` : inner;
          break;
        }
        case 'ins':
        case 'smartTag':
        case 'fldSimple':
        case 'customXml':
        case 'sdtContent':
          out += await inlineHtml(c);
          break;
        case 'sdt':
          out += await inlineHtml(W(c, 'sdtContent') || c);
          break;
        case 'oMath':
        case 'oMathPara':
          out += U.escapeHtml(c.textContent);
          break;
        default:
          break;
      }
    }
    return out;
  };

  const paraInfo = async (p) => {
    const pPr = W(p, 'pPr');
    const styleId = pPr ? val(W(pPr, 'pStyle')) : null;
    const kind = styleKind(styleId);
    const numPr = pPr ? W(pPr, 'numPr') : null;
    let list = null;
    if (!numPr && styleId) {
      // нумерация, заданная в стиле (List Bullet, List Number, «Маркированный список»)
      let st = styles.get(styleId);
      let guard = 0;
      while (st && !st.numId && st.basedOn && guard++ < 5) st = styles.get(st.basedOn);
      const sname = (styles.get(styleId) || {}).name || '';
      const lvlFromName = /(\d)$/.exec(sname);
      if (st && st.numId && st.numId !== '0') {
        const ilvl = st.ilvl !== null && st.ilvl !== undefined ? st.ilvl : lvlFromName ? +lvlFromName[1] - 1 : 0;
        const fmt = (numFormats.get(st.numId) && numFormats.get(st.numId).get(ilvl)) || (/number|нумер/.test(sname) ? 'decimal' : 'bullet');
        list = { numId: st.numId, ilvl: Math.max(ilvl, lvlFromName ? +lvlFromName[1] - 1 : 0), ordered: fmt !== 'bullet' && fmt !== 'none' };
      } else if (/^list (bullet|number)|^маркированный|^нумерованный/.test(sname)) {
        list = { numId: 'style', ilvl: lvlFromName ? +lvlFromName[1] - 1 : 0, ordered: /number|нумер/.test(sname) };
      }
    }
    if (numPr) {
      const numId = val(W(numPr, 'numId'));
      const ilvl = +(val(W(numPr, 'ilvl')) || 0);
      if (numId && numId !== '0') {
        const fmt = (numFormats.get(numId) && numFormats.get(numId).get(ilvl)) || 'bullet';
        list = { numId, ilvl, ordered: fmt !== 'bullet' && fmt !== 'none' };
      }
    }
    const jc = pPr ? val(W(pPr, 'jc')) : null;
    const html = await inlineHtml(p);
    return { kind, list, align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : null, html };
  };

  const blockHtml = async (container) => {
    const parts = [];
    let listStack = []; // [{ordered, ilvl}]
    const closeLists = (toLevel = -1) => {
      while (listStack.length && listStack[listStack.length - 1].ilvl > toLevel) {
        const l = listStack.pop();
        parts.push(`</li></${l.ordered ? 'ol' : 'ul'}>`);
      }
    };
    for (const node of container.children) {
      if (node.localName === 'sdt') {
        closeLists();
        parts.push(await blockHtml(W(node, 'sdtContent') || node));
        continue;
      }
      if (node.localName === 'tbl') {
        closeLists();
        parts.push(await tableHtml(node));
        continue;
      }
      if (node.localName !== 'p') continue;
      const info = await paraInfo(node);
      if (info.list) {
        const top = listStack[listStack.length - 1];
        if (!top || info.list.ilvl > top.ilvl) {
          listStack.push({ ordered: info.list.ordered, ilvl: info.list.ilvl });
          parts.push(`<${info.list.ordered ? 'ol' : 'ul'}><li>${info.html}`);
        } else {
          closeLists(info.list.ilvl);
          const cur = listStack[listStack.length - 1];
          if (cur && cur.ilvl === info.list.ilvl) parts.push(`</li><li>${info.html}`);
          else {
            listStack.push({ ordered: info.list.ordered, ilvl: info.list.ilvl });
            parts.push(`<${info.list.ordered ? 'ol' : 'ul'}><li>${info.html}`);
          }
        }
        continue;
      }
      closeLists();
      if (!info.html.replace(/<[^>]+>/g, '').trim() && !/<img/.test(info.html)) continue;
      const align = info.align ? ` align="${info.align}"` : '';
      switch (info.kind.kind) {
        case 'heading':
          parts.push(`<h${info.kind.level}>${info.html}</h${info.kind.level}>`);
          break;
        case 'quote':
          parts.push(`<blockquote><p>${info.html}</p></blockquote>`);
          break;
        case 'code':
          parts.push(`<pre><code>${info.html.replace(/<br>/g, '\n').replace(/<(?!\/?code)[^>]+>/g, '')}</code></pre>`);
          break;
        case 'caption':
          parts.push(`<p><em>${info.html}</em></p>`);
          break;
        default:
          parts.push(`<p${align}>${info.html}</p>`);
      }
    }
    closeLists();
    // соседние блоки кода/цитат склеиваем
    return parts
      .join('\n')
      .replace(/<\/code><\/pre>\n<pre><code>/g, '\n')
      .replace(/<\/blockquote>\n<blockquote>/g, '\n');
  };

  const tableHtml = async (tbl) => {
    const rows = Ws(tbl, 'tr');
    const grid = rows.map(() => []);
    // vMerge → rowspan
    const out = [];
    const spans = new Map(); // "r:c" → rowspan
    const matrix = [];
    for (let r = 0; r < rows.length; r++) {
      let col = 0;
      matrix[r] = [];
      for (const tc of Ws(rows[r], 'tc')) {
        const tcPr = W(tc, 'tcPr');
        const span = tcPr && W(tcPr, 'gridSpan') ? +val(W(tcPr, 'gridSpan')) || 1 : 1;
        const vm = tcPr ? W(tcPr, 'vMerge') : null;
        const vmState = vm ? val(vm) || 'continue' : null;
        matrix[r].push({ tc, col, span, vmState });
        col += span;
      }
    }
    for (let r = 0; r < matrix.length; r++) {
      for (const cell of matrix[r]) {
        if (cell.vmState === 'restart') {
          let n = 1;
          for (let k = r + 1; k < matrix.length; k++) {
            const below = matrix[k].find((c) => c.col === cell.col);
            if (below && below.vmState === 'continue') n++;
            else break;
          }
          spans.set(`${r}:${cell.col}`, n);
        }
      }
    }
    for (let r = 0; r < matrix.length; r++) {
      const cells = [];
      for (const cell of matrix[r]) {
        if (cell.vmState === 'continue') continue;
        const inner = await blockHtml(cell.tc);
        const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${spans.get(`${r}:${cell.col}`) > 1 ? ` rowspan="${spans.get(`${r}:${cell.col}`)}"` : ''}`;
        const simple = inner.replace(/^<p>([\s\S]*)<\/p>$/, '$1');
        const body = /<p[ >]/.test(simple) ? inner : simple;
        cells.push(`<${r === 0 ? 'th' : 'td'}${attrs}>${body}</${r === 0 ? 'th' : 'td'}>`);
      }
      out.push(`<tr>${cells.join('')}</tr>`);
    }
    void grid;
    return `<table>\n${out.join('\n')}\n</table>`;
  };

  const body = doc.getElementsByTagNameNS('*', 'body')[0];
  const html = await blockHtml(body);
  return { html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, meta };
}

module.exports = { docxToHtml };
