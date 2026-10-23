'use strict';

/**
 * HTML → блоки Markdown с максимальным сохранением вёрстки:
 * заголовки, списки (вложенные, чек-листы), таблицы (GFM или HTML при
 * объединённых ячейках), цитаты → callouts, код с языком, формулы KaTeX/
 * MathJax/MathML → $…$, картинки (с шириной), видео/iframe, выравнивание и
 * цвет текста (как inline-HTML), подчёркивание, ==выделение==, sub/sup.
 *
 * Результат — массив блоков { type, md, text, level? } для конструктора.
 */

const U = require('../util');

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DETAILS', 'DIALOG', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL', 'VIDEO', 'AUDIO',
  'IFRAME', 'SUMMARY', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'BODY', 'HTML',
]);

const SKIP_TAGS = new Set([
  'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BUTTON', 'SELECT', 'TEXTAREA',
  'CANVAS', 'MAP', 'OBJECT', 'TITLE', 'SVG', 'svg', 'COLGROUP', 'COL',
]);

const HTML_ALLOWED = new Set([
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'p', 'br', 'b', 'strong', 'i', 'em', 'u',
  's', 'del', 'sub', 'sup', 'mark', 'code', 'pre', 'a', 'img', 'ul', 'ol', 'li', 'span', 'div', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'figcaption', 'kbd', 'small', 'big', 'font', 'center',
  'details', 'summary', 'dl', 'dt', 'dd', 'video', 'audio', 'source', 'iframe',
]);
const VOID = new Set(['br', 'img', 'hr', 'source']);
const STYLE_PROPS = new Set([
  'color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration', 'vertical-align', 'width',
]);

const CALLOUT_RULES = [
  [/warn|caution|attention/i, 'warning'],
  [/danger|error|alert-danger|failure/i, 'danger'],
  [/tip|hint|success/i, 'tip'],
  [/important/i, 'important'],
  [/question|faq/i, 'question'],
  [/example/i, 'example'],
  [/abstract|summary|tldr|annotation|аннотац/i, 'abstract'],
  [/info|note|notice/i, 'info'],
  [/quote|pullquote|epigraph/i, 'quote'],
];
const CALLOUT_CONTAINER = /(admonition|callout|alert|notice|note|warning|tip|info-?box|infobox|highlight-box|abstract|epigraph|pullquote)/i;

const BR = '\u0000BR\u0000';

function cls(el) {
  const c = el.getAttribute && el.getAttribute('class');
  return `${c || ''} ${el.id || ''}`;
}

function styleOf(el) {
  const raw = (el.getAttribute && el.getAttribute('style')) || '';
  const map = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return map;
}

function parseColor(c) {
  if (!c) return null;
  c = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return m[1].split('').map((x) => parseInt(x + x, 16));
  m = /^#([0-9a-f]{6})/.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(c);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) < 0.15) return null;
    return [+m[1], +m[2], +m[3]];
  }
  const named = { red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], orange: [255, 165, 0], yellow: [255, 255, 0], purple: [128, 0, 128] };
  return named[c] || null;
}

/** Серые/почти чёрные/почти белые цвета не переносим — они ломают тёмную тему. */
function isMeaningfulColor(c) {
  const rgb = parseColor(c);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return Math.max(r, g, b) - Math.min(r, g, b) > 40;
}

function isYellowish(c) {
  const rgb = parseColor(c);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return r > 200 && g > 180 && b < 160;
}

function cleanTex(tex) {
  tex = String(tex || '').trim();
  const m = /^\{\\displaystyle\s*([\s\S]*)\}$/.exec(tex) || /^\{\\textstyle\s*([\s\S]*)\}$/.exec(tex);
  if (m) tex = m[1].trim();
  return tex;
}

class HtmlConverter {
  /**
   * @param {object} o { baseUrl, assets, tablesMarkdown, callouts, preserveStyles, latex }
   */
  constructor(o) {
    this.o = Object.assign({ tablesMarkdown: true, callouts: true, preserveStyles: true, latex: true }, o);
    this.root = null;
    this.seenImages = new Map(); // ключ → { token, url }
  }

  convert(root) {
    this.root = root;
    const out = [];
    this.collect(root, out);
    return out.filter((b) => b.md && b.md.trim());
  }

  // ───────────── классификация ─────────────

  mathInfo(el) {
    if (!this.o.latex || el.nodeType !== 1) return null;
    const tag = el.tagName.toUpperCase();
    const c = cls(el);
    const annot = (scope) => {
      const a = scope.querySelector('annotation[encoding*="tex"], annotation[encoding*="TeX"]');
      return a ? a.textContent : '';
    };
    if (/\bkatex-display\b/.test(c)) {
      const tex = annot(el);
      return tex ? { tex: cleanTex(tex), display: true } : null;
    }
    if (/\bkatex\b/.test(c)) {
      const tex = annot(el);
      return tex ? { tex: cleanTex(tex), display: !!el.closest('.katex-display') } : null;
    }
    if (/\bmwe-math-element\b/.test(c)) {
      const m = el.querySelector('math');
      const tex = (m && (m.getAttribute('alttext') || annot(m))) || ((el.querySelector('img[alt]') || {}).alt || '');
      return tex ? { tex: cleanTex(tex), display: /display/.test(c) || (m && m.getAttribute('display') === 'block') } : null;
    }
    if (tag === 'MATH') {
      const tex = el.getAttribute('alttext') || annot(el);
      const t = tex || el.textContent.replace(/\s+/g, ' ').trim();
      return t ? { tex: cleanTex(t), display: el.getAttribute('display') === 'block' } : null;
    }
    if (tag === 'MJX-CONTAINER') {
      const m = el.querySelector('math');
      const tex = m ? m.getAttribute('alttext') || annot(m) : '';
      return tex ? { tex: cleanTex(tex), display: el.getAttribute('display') === 'true' } : null;
    }
    if (tag === 'SCRIPT' && /math\/tex/.test(el.getAttribute('type') || '')) {
      return { tex: cleanTex(el.textContent), display: /mode=display/.test(el.getAttribute('type')) };
    }
    if (tag === 'IMG' && (/\b(latex|tex|mwe-math-fallback)/.test(c) || /latex|codecogs|mathtex/.test(el.getAttribute('src') || '')) && el.getAttribute('alt')) {
      return { tex: cleanTex(el.getAttribute('alt')), display: /display/.test(c) };
    }
    return null;
  }

  isBlockEl(el) {
    if (el.nodeType !== 1) return false;
    const tag = el.tagName.toUpperCase();
    if (BLOCK_TAGS.has(tag)) return true;
    const m = this.mathInfo(el);
    if (m && m.display) return true;
    return false;
  }

  hasBlockDescendant(el) {
    return !!el.querySelector(
      'p, div, ul, ol, table, pre, blockquote, h1, h2, h3, h4, h5, h6, figure, section, article, iframe, video, hr, dl'
    );
  }

  isCentered(el) {
    let cur = el;
    while (cur && cur !== this.root && cur.nodeType === 1) {
      const st = styleOf(cur);
      const align = (cur.getAttribute('align') || st['text-align'] || '').toLowerCase();
      if (cur.tagName === 'CENTER' || align === 'center') return 'center';
      if (align === 'right') return 'right';
      if (align === 'left' || align === 'justify' || align === 'start') return null;
      cur = cur.parentElement;
    }
    return null;
  }

  calloutTypeFor(el, fallback) {
    const c = cls(el);
    for (const [re, type] of CALLOUT_RULES) if (re.test(c)) return type;
    return fallback;
  }

  // ───────────── обход блоков ─────────────

  collect(parent, out) {
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const nodes = buf;
      buf = [];
      this.pushParagraph(nodes, out, parent);
    };
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) {
        buf.push(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'SCRIPT' && !/math\/tex/.test(child.getAttribute('type') || '')) continue;
      if (this.isBlockEl(child)) {
        flush();
        this.blockElement(child, out);
      } else if (!this.mathInfo(child) && tag !== 'A' && this.hasBlockDescendant(child)) {
        flush();
        this.collect(child, out);
      } else if (tag === 'A' && this.hasBlockDescendant(child)) {
        flush();
        this.collect(child, out);
      } else {
        buf.push(child);
      }
    }
    flush();
  }

  pushParagraph(nodes, out, container) {
    const md = this.finishInline(this.inlineNodes(nodes, {}));
    if (!md.trim()) return;
    const align = this.o.preserveStyles && container && container.nodeType === 1 ? this.isCentered(container) : null;
    out.push(this.paragraphBlock(md, align ? this.wrapAligned(nodes, align) : null));
  }

  paragraphBlock(md, alignedHtml) {
    const trimmed = md.trim();
    if (/^(!\[[^\]]*\]\([^)]+\)\s*)+$/.test(trimmed)) return { type: 'image', md: trimmed, text: 'Изображение' };
    if (/^\$\$[\s\S]+\$\$$/.test(trimmed)) return { type: 'math', md: trimmed, text: trimmed.replace(/\$\$/g, '').trim() };
    if (alignedHtml) return { type: 'paragraph', md: alignedHtml, text: U.stripMarkdown(trimmed), html: true };
    return { type: 'paragraph', md: escapeLineStarts(trimmed), text: U.stripMarkdown(trimmed) };
  }

  wrapAligned(nodes, align) {
    const inner = nodes.map((n) => this.toHtml(n)).join('').replace(/\s+/g, ' ').trim();
    if (!inner) return null;
    return `<p align="${align}">${inner}</p>`;
  }

  blockElement(el, out) {
    const tag = el.tagName.toUpperCase();
    const math = this.mathInfo(el);
    if (math && math.display) {
      out.push({ type: 'math', md: `$$\n${math.tex}\n$$`, text: math.tex });
      return;
    }
    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const level = +tag[1];
        const text = this.finishInline(this.inlineNodes([...el.childNodes], { heading: true }))
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\s*[¶#§]\s*$/, '')
          .trim();
        if (!text) return;
        // заголовок, состоящий из картинки — выводим картинку
        if (/^!\[/.test(text) && /\)$/.test(text)) out.push({ type: 'image', md: text, text: 'Изображение' });
        else out.push({ type: 'heading', level, md: `${'#'.repeat(level)} ${text}`, text: U.stripMarkdown(text) });
        return;
      }
      case 'P':
      case 'ADDRESS':
      case 'SUMMARY':
      case 'DT':
      case 'FIGCAPTION':
      case 'CAPTION': {
        if (this.hasBlockDescendant(el)) {
          this.collect(el, out);
          return;
        }
        const md = this.finishInline(this.inlineNodes([...el.childNodes], {}));
        if (!md.trim()) return;
        const align = this.o.preserveStyles ? this.isCentered(el) : null;
        if (tag === 'FIGCAPTION' || tag === 'CAPTION') {
          out.push({ type: 'paragraph', md: `*${md.trim().replace(/^\*+|\*+$/g, '')}*`, text: U.stripMarkdown(md), caption: true });
          return;
        }
        out.push(this.paragraphBlock(md, align ? this.wrapAligned([...el.childNodes], align) : null));
        return;
      }
      case 'UL':
      case 'OL': {
        const md = this.list(el, 0);
        if (md.trim()) out.push({ type: 'list', md, text: U.stripMarkdown(md).slice(0, 200) });
        return;
      }
      case 'BLOCKQUOTE':
        this.blockquote(el, out);
        return;
      case 'PRE':
        this.pre(el, out);
        return;
      case 'TABLE':
        this.table(el, out);
        return;
      case 'HR':
        out.push({ type: 'hr', md: '---', text: '———' });
        return;
      case 'FIGURE':
        this.figure(el, out);
        return;
      case 'DETAILS':
        this.details(el, out);
        return;
      case 'DL':
        this.dl(el, out);
        return;
      case 'IFRAME':
        this.iframe(el, out);
        return;
      case 'VIDEO':
      case 'AUDIO':
        this.media(el, out);
        return;
      case 'LI':
      case 'DD':
      case 'TBODY':
      case 'THEAD':
      case 'TFOOT':
      case 'TR':
      case 'TD':
      case 'TH':
        this.collect(el, out);
        return;
      default: {
        // DIV, SECTION, ARTICLE, CENTER и т.п.
        if (this.o.callouts && tag !== 'BODY' && tag !== 'HTML' && CALLOUT_CONTAINER.test(cls(el)) && el.textContent.trim().length < 4000) {
          this.callout(el, out, this.calloutTypeFor(el, 'note'));
          return;
        }
        if (this.o.preserveStyles && !this.hasBlockDescendant(el)) {
          const align = this.isCentered(el);
          const md = this.finishInline(this.inlineNodes([...el.childNodes], {}));
          if (!md.trim()) return;
          out.push(this.paragraphBlock(md, align ? this.wrapAligned([...el.childNodes], align) : null));
          return;
        }
        this.collect(el, out);
      }
    }
  }

  // ───────────── отдельные блоки ─────────────

  list(el, depth) {
    const ordered = el.tagName.toUpperCase() === 'OL';
    let n = parseInt(el.getAttribute('start') || '1', 10) || 1;
    const indent = '\t'.repeat(depth);
    const items = [];
    for (const child of el.children) {
      const ctag = child.tagName.toUpperCase();
      if (ctag === 'UL' || ctag === 'OL') {
        items.push({ nested: true, md: this.list(child, depth + 1) });
        continue;
      }
      if (ctag !== 'LI') {
        const md = this.finishInline(this.inlineNodes([child], {})).trim();
        if (md) items.push({ md: `${indent}- ${md}` });
        continue;
      }
      let marker = ordered ? `${n++}.` : '-';
      const cb = child.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"], :scope > label > input[type="checkbox"]');
      if (cb) marker += cb.checked || cb.hasAttribute('checked') ? ' [x]' : ' [ ]';
      else if (/task-list-item|checked/.test(cls(child)) && /\bchecked\b/.test(cls(child))) marker += ' [x]';

      const parts = [];
      let buf = [];
      const flushBuf = () => {
        if (!buf.length) return;
        const md = this.finishInline(this.inlineNodes(buf, {})).trim();
        if (md) parts.push({ kind: 'text', md });
        buf = [];
      };
      for (const node of child.childNodes) {
        if (node === cb) continue;
        if (node.nodeType === 1) {
          const t = node.tagName.toUpperCase();
          if (t === 'UL' || t === 'OL') {
            flushBuf();
            parts.push({ kind: 'list', md: this.list(node, depth + 1) });
            continue;
          }
          if (this.isBlockEl(node)) {
            flushBuf();
            const sub = [];
            this.blockElement(node, sub);
            for (const b of sub) {
              if (b.type === 'list') parts.push({ kind: 'list', md: indentLines(b.md, depth + 1, true) });
              else parts.push({ kind: b.type === 'paragraph' ? 'text' : 'block', md: b.md });
            }
            continue;
          }
        }
        buf.push(node);
      }
      flushBuf();

      const lines = [];
      let prev = null;
      for (const part of parts) {
        if (part.kind === 'list') {
          lines.push(part.md);
          prev = part;
          continue;
        }
        const partLines = part.md.split('\n');
        if (!prev) {
          lines.push(`${indent}${marker} ${partLines[0]}`);
          for (const l of partLines.slice(1)) lines.push(l ? `${indent}\t${l}` : '');
        } else {
          if (prev.kind !== 'list') lines.push('');
          for (const l of partLines) lines.push(l ? `${indent}\t${l}` : '');
        }
        prev = part;
      }
      if (!parts.length || parts[0].kind === 'list') lines.unshift(`${indent}${marker} `);
      items.push({ md: lines.join('\n') });
    }
    return items.map((i) => i.md).join('\n');
  }

  blockquote(el, out) {
    const inner = [];
    this.collect(el, inner);
    if (!inner.length) return;
    let title = '';
    if (this.o.callouts && inner[0].type === 'heading' && inner.length > 1) {
      title = inner.shift().text;
    }
    const body = inner.map((b) => b.md).join('\n\n');
    const quoted = body
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    if (this.o.callouts) {
      const type = this.calloutTypeFor(el, 'quote');
      out.push({ type: 'quote', md: `> [!${type}]${title ? ' ' + title : ''}\n${quoted}`, text: U.stripMarkdown(body).slice(0, 300) });
    } else {
      out.push({ type: 'quote', md: quoted, text: U.stripMarkdown(body).slice(0, 300) });
    }
  }

  callout(el, out, type) {
    const inner = [];
    const titleEl = el.querySelector(':scope > .admonition-title, :scope > .callout-title, :scope > .alert-heading, :scope > .title');
    let title = titleEl ? titleEl.textContent.trim() : '';
    if (titleEl) titleEl.remove();
    this.collect(el, inner);
    if (!inner.length) return;
    if (!title && inner[0].type === 'heading' && inner.length > 1) title = inner.shift().text;
    const body = inner.map((b) => b.md).join('\n\n');
    const quoted = body
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    out.push({ type: 'quote', md: `> [!${type}]${title ? ' ' + title : ''}\n${quoted}`, text: U.stripMarkdown(body).slice(0, 300) });
  }

  details(el, out) {
    const summary = el.querySelector(':scope > summary');
    const title = summary ? summary.textContent.replace(/\s+/g, ' ').trim() : 'Подробнее';
    if (summary) summary.remove();
    const inner = [];
    this.collect(el, inner);
    const body = inner.map((b) => b.md).join('\n\n');
    const quoted = body
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    out.push({ type: 'quote', md: `> [!note]- ${title}\n${quoted}`, text: title });
  }

  pre(el, out) {
    const codeEl = el.querySelector('code') || el;
    const langSrc = `${codeEl.getAttribute('class') || ''} ${el.getAttribute('class') || ''} ${el.getAttribute('data-lang') || ''} ${
      el.getAttribute('data-language') || ''
    }`;
    let lang = (/(?:language|lang|brush:?\s*)-?([\w+#-]+)/i.exec(langSrc) || [])[1] || el.getAttribute('data-lang') || '';
    lang = (lang || '').toLowerCase().replace(/[^\w+#-]/g, '');
    if (['none', 'text', 'plaintext', 'nohighlight'].includes(lang)) lang = '';
    const text = preText(codeEl).replace(/\n+$/, '').replace(/^\n/, '');
    if (!text.trim()) return;
    let fence = '```';
    while (text.includes(fence)) fence += '`';
    out.push({ type: 'code', md: `${fence}${lang}\n${text}\n${fence}`, text: text.slice(0, 200), lang });
  }

  table(el, out) {
    const rows = [...el.querySelectorAll('tr')].filter((r) => r.closest('table') === el);
    if (!rows.length) return;
    const cellsOf = (r) => [...r.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const maxCols = Math.max(...rows.map((r) => cellsOf(r).reduce((s, c) => s + (parseInt(c.getAttribute('colspan') || '1', 10) || 1), 0)));
    // вёрсточные таблицы: одна колонка или одна ячейка
    if (maxCols <= 1 || (rows.length === 1 && maxCols <= 2 && !el.querySelector('th'))) {
      for (const r of rows) for (const c of cellsOf(r)) this.collect(c, out);
      return;
    }
    const complex = rows.some((r) =>
      cellsOf(r).some(
        (c) =>
          (parseInt(c.getAttribute('colspan') || '1', 10) || 1) > 1 ||
          (parseInt(c.getAttribute('rowspan') || '1', 10) || 1) > 1 ||
          c.querySelector('table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6') ||
          c.querySelectorAll('p').length > 1
      )
    );
    const caption = el.querySelector(':scope > caption');
    const captionText = caption ? caption.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!this.o.tablesMarkdown || complex) {
      const html = this.toHtml(el).replace(/\n{2,}/g, '\n');
      out.push({ type: 'table', md: html, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200), html: true });
      return;
    }
    const matrix = rows.map((r) =>
      cellsOf(r).map((c) => {
        const md = this.finishInline(this.inlineNodes([...c.childNodes], { inTable: true }), true);
        return md.replace(/\n+/g, '<br>').replace(/\|/g, '\\|').trim();
      })
    );
    const header = matrix[0];
    const headerCells = cellsOf(rows[0]);
    const align = headerCells.map((c) => {
      const a = (c.getAttribute('align') || styleOf(c)['text-align'] || '').toLowerCase();
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
    });
    while (align.length < maxCols) align.push('---');
    const line = (cells) => {
      const full = cells.slice();
      while (full.length < maxCols) full.push('');
      return `| ${full.map((c) => c || ' ').join(' | ')} |`;
    };
    const lines = [line(header), `| ${align.join(' | ')} |`, ...matrix.slice(1).map(line)];
    if (captionText) out.push({ type: 'paragraph', md: `**${escText(captionText)}**`, text: captionText, caption: true });
    out.push({ type: 'table', md: lines.join('\n'), text: matrix.map((r) => r.join(' · ')).join(' / ').slice(0, 200) });
  }

  figure(el, out) {
    const caption = el.querySelector('figcaption');
    const captionMd = caption ? this.finishInline(this.inlineNodes([...caption.childNodes], {})).trim() : '';
    if (caption) caption.remove();
    const inner = [];
    this.collect(el, inner);
    if (!inner.length && !captionMd) return;
    if (inner.length && inner.every((b) => b.type === 'image')) {
      const md = inner.map((b) => b.md).join('\n') + (captionMd ? `\n*${captionMd.replace(/^\*+|\*+$/g, '')}*` : '');
      out.push({ type: 'image', md, text: captionMd ? U.stripMarkdown(captionMd) : 'Изображение' });
      return;
    }
    out.push(...inner);
    if (captionMd) out.push({ type: 'paragraph', md: `*${captionMd.replace(/^\*+|\*+$/g, '')}*`, text: U.stripMarkdown(captionMd), caption: true });
  }

  dl(el, out) {
    const lines = [];
    for (const child of el.children) {
      const md = this.finishInline(this.inlineNodes([...child.childNodes], {})).trim();
      if (!md) continue;
      if (child.tagName === 'DT') lines.push(`**${md.replace(/^\*\*|\*\*$/g, '')}**`);
      else lines.push(`: ${md}`);
    }
    if (lines.length) out.push({ type: 'paragraph', md: lines.join('  \n'), text: U.stripMarkdown(lines.join(' ')) });
  }

  iframe(el, out) {
    const src = el.getAttribute('src') || '';
    if (!src) return;
    const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(src);
    if (yt) {
      out.push({ type: 'embed', md: `![](https://www.youtube.com/watch?v=${yt[1]})`, text: 'YouTube' });
      return;
    }
    if (this.o.preserveStyles) {
      const h = parseInt(el.getAttribute('height') || '400', 10) || 400;
      out.push({ type: 'embed', md: `<iframe src="${U.escapeHtml(src)}" width="100%" height="${h}" frameborder="0" allowfullscreen></iframe>`, text: src, html: true });
    } else {
      out.push({ type: 'embed', md: `[Встроенный контент](${encodeUrl(src)})`, text: src });
    }
  }

  media(el, out) {
    const tag = el.tagName.toLowerCase();
    const srcEl = el.getAttribute('src') ? el : el.querySelector('source[src]');
    const src = srcEl ? srcEl.getAttribute('src') : '';
    if (!src) return;
    const poster = el.getAttribute('poster');
    const label = tag === 'video' ? 'Видео' : 'Аудио';
    if (this.o.assets) {
      const token = src.startsWith('mi-asset://') ? src : this.o.assets.add({ url: src, kind: tag, name: label });
      out.push({
        type: 'embed',
        md: `<${tag} src="${token}"${poster ? ` poster="${U.escapeHtml(poster)}"` : ''} controls${tag === 'video' ? ' width="100%"' : ''}></${tag}>`,
        text: label,
        html: true,
      });
      return;
    }
    out.push({ type: 'embed', md: `[${label}](${encodeUrl(src)})`, text: src });
  }

  // ───────────── inline ─────────────

  inlineNodes(nodes, ctx) {
    let s = '';
    for (const n of nodes) s += this.inline(n, ctx);
    return s;
  }

  inline(node, ctx) {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/[\s ​]+/g, (m) => (m.includes('​') && !/\s/.test(m.replace('​', '')) ? '' : ' '));
      return ctx.code ? t : escText(t);
    }
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return '';

    const math = this.mathInfo(el);
    if (math) {
      if (math.display) return `${BR}$$${math.tex}$$${BR}`;
      return `$${math.tex}$`;
    }
    if (tag === 'SCRIPT') return '';

    const kids = () => this.inlineNodes([...el.childNodes], ctx);
    const st = this.o.preserveStyles ? styleOf(el) : {};
    const c = cls(el);

    switch (tag) {
      case 'BR':
        return BR;
      case 'WBR':
        return '';
      case 'IMG':
        return this.img(el, ctx);
      case 'B':
      case 'STRONG': {
        if (/font-weight\s*:\s*(normal|[1-4]00)/i.test(el.getAttribute('style') || '')) return kids();
        if (ctx.bold || ctx.heading) return kids();
        return wrap(this.inlineNodes([...el.childNodes], Object.assign({}, ctx, { bold: true })), '**');
      }
      case 'I':
      case 'EM':
      case 'CITE':
      case 'DFN':
      case 'VAR': {
        if (/\bemoji\b/.test(c)) return escText(el.textContent);
        if (ctx.italic) return kids();
        return wrap(this.inlineNodes([...el.childNodes], Object.assign({}, ctx, { italic: true })), '*');
      }
      case 'U':
      case 'INS':
        return this.o.preserveStyles ? wrapHtml(kids(), 'u') : kids();
      case 'S':
      case 'DEL':
      case 'STRIKE':
        return ctx.strike ? kids() : wrap(this.inlineNodes([...el.childNodes], Object.assign({}, ctx, { strike: true })), '~~');
      case 'MARK':
        return wrap(kids(), '==');
      case 'CODE':
      case 'SAMP':
      case 'TT': {
        if (ctx.code) return el.textContent;
        const text = el.textContent.replace(/\s+/g, ' ');
        if (!text.trim()) return text;
        const ticks = text.includes('`') ? '``' : '`';
        const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
        return `${ticks}${pad}${text}${pad}${ticks}`;
      }
      case 'KBD':
        return `<kbd>${U.escapeHtml(el.textContent)}</kbd>`;
      case 'SUB':
      case 'SUP': {
        const inner = kids().trim();
        if (!inner) return '';
        return this.o.preserveStyles || tag === 'SUP' ? `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>` : inner;
      }
      case 'Q':
        return `«${kids()}»`;
      case 'A':
        return this.link(el, ctx);
      case 'INPUT':
        return '';
      case 'TG-SPOILER':
        return wrap(kids(), '==');
      case 'TG-EMOJI':
        return escText(el.textContent);
      default:
        break;
    }

    let inner = kids();
    if (/\bemoji\b/.test(c) && el.textContent) return escText(el.textContent);
    if (/\btg-spoiler\b|\bspoiler\b/.test(c)) return wrap(inner, '==');

    // inline-стили (Google Docs, Word, CMS)
    if (this.o.preserveStyles && Object.keys(st).length) {
      const fw = st['font-weight'];
      if (fw && (/bold/.test(fw) || parseInt(fw, 10) >= 600) && !ctx.bold && !ctx.heading) inner = wrap(inner, '**');
      if (/italic|oblique/.test(st['font-style'] || '') && !ctx.italic) inner = wrap(inner, '*');
      const deco = st['text-decoration'] || st['text-decoration-line'] || '';
      if (/line-through/.test(deco)) inner = wrap(inner, '~~');
      if (/underline/.test(deco) && !el.closest('a')) inner = wrapHtml(inner, 'u');
      const bg = st['background-color'] || st.background;
      if (bg && isMeaningfulColor(bg)) inner = isYellowish(bg) ? wrap(inner, '==') : wrapStyled(inner, `background-color:${bg}`);
      if (st.color && isMeaningfulColor(st.color)) inner = wrapStyled(inner, `color:${st.color}`);
      if (/super/.test(st['vertical-align'] || '')) inner = `<sup>${inner}</sup>`;
      if (/sub/.test(st['vertical-align'] || '')) inner = `<sub>${inner}</sub>`;
    } else if (this.o.preserveStyles && tag === 'FONT' && el.getAttribute('color') && isMeaningfulColor(el.getAttribute('color'))) {
      inner = wrapStyled(inner, `color:${el.getAttribute('color')}`);
    }
    return inner;
  }

  img(el, ctx, overrideSrc) {
    let src = overrideSrc || el.getAttribute('src') || '';
    if (!src) return '';
    const w = parseInt(el.getAttribute('width') || '0', 10);
    const h = parseInt(el.getAttribute('height') || '0', 10);
    if ((w && w <= 2) || (h && h <= 2)) return ''; // пиксели-трекеры
    const c = cls(el);
    if (/\b(emoji|wp-smiley|emoticon)\b/.test(c) && el.getAttribute('alt')) return escText(el.getAttribute('alt'));
    if (/^data:image\/(gif|svg)/.test(src) && src.length < 400) return '';
    // иконки, аватары, логотипы, спрайты
    if (w && h && w <= 40 && h <= 40) return '';
    if (/(^|[\s_-])(avatar|userpic|author-photo|logo|icon|badge|sprite|spinner|loader|share|social)([\s_-]|$)/i.test(c)) return '';
    if (el.closest && el.closest('[class~="avatar"], [class*="avatar__"], [class*="-avatar"], [class~="share"], [class*="share-buttons"], [class*="social-share"]')) return '';
    // дубликаты (тот же снимок в другом размере, noscript-копия, превью + полноразмер)
    const key = imageKey(src);
    if (key && this.seenImages.has(key)) {
      // та же картинка — если новая версия крупнее, подменяем адрес у уже вставленной
      const prev = this.seenImages.get(key);
      if (prev.token && this.o.assets && sizeScore(src) > sizeScore(prev.url)) {
        this.o.assets.upgrade(prev.token, src);
        prev.url = src;
      }
      return '';
    }
    let alt = (el.getAttribute('alt') || el.getAttribute('title') || '').replace(/[[\]\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(image|img|photo|picture|изображение|картинка|фото|untitled|\d+)$/i.test(alt) || /\.(jpe?g|png|gif|webp|avif)$/i.test(alt)) alt = '';
    const token = src.startsWith('mi-asset://') || !this.o.assets ? src : this.o.assets.add({ url: src, alt });
    if (key) this.seenImages.set(key, { token: token.startsWith('mi-asset://') ? token : null, url: src });
    if (this.o.preserveStyles && w && w < 720 && !ctx.inTable) alt = `${alt}|${w}`;
    return `![${alt}](${token})`;
  }

  link(el, ctx) {
    const href = el.getAttribute('href') || '';
    const imgs = el.querySelectorAll('img');
    const textOnly = el.textContent.replace(/\s+/g, ' ').trim();

    // Ссылка-обёртка вокруг картинки (лайтбокс, «открыть в полном размере», переход на страницу фото):
    // оставляем только картинку; если ссылка ведёт на файл изображения — берём его как более крупную версию.
    if (imgs.length && !textOnly) {
      if (imgs.length === 1 && isImageUrl(href)) {
        const big = this.img(imgs[0], ctx, href);
        if (big) return big;
      }
      return this.inlineNodes([...el.childNodes], ctx);
    }

    const inner = this.inlineNodes([...el.childNodes], ctx);
    const text = inner.trim();
    if (!href || /^javascript:/i.test(href)) return inner;
    if (/^#/.test(href) || (this.o.baseUrl && href.startsWith(this.o.baseUrl.split('#')[0] + '#'))) {
      if (!text || /^[¶#§]$/.test(text)) return '';
      return inner; // внутренние якоря в заметке не работают
    }
    if (!text) return '';
    if (/^!\[/.test(text)) return inner; // картинка с подписью внутри ссылки — без обёртки

    // Текстовые ссылки на файлы изображений («Увеличить», имя файла, тот же снимок) — лишние рядом с картинкой
    if (isImageUrl(href)) {
      const generic = /^(увеличить|открыть|полный размер|в полном размере|оригинал|скачать|смотреть|фото|изображение|картинка|источник|full[\s-]?size|enlarge|zoom|view( image| full)?|open( image)?|download|source|image|photo|original|click to enlarge)\W*$/i.test(textOnly);
      const fileName = /\.(jpe?g|png|gif|webp|avif|svg)$/i.test(textOnly) || textOnly === href;
      if (generic || fileName || this.seenImages.has(imageKey(href))) return generic || fileName ? '' : inner;
    }

    const plain = el.textContent.trim();
    if (plain === href || plain === href.replace(/^https?:\/\//, '')) return href;
    const lead = inner.match(/^\s*/)[0];
    const trail = inner.match(/\s*$/)[0];
    return `${lead}[${text.replace(/\n/g, ' ')}](${encodeUrl(href)})${trail}`;
  }

  finishInline(s, inTable = false) {
    return s
      .replace(/ {2,}/g, ' ')
      .replace(new RegExp(` *${BR} *`, 'g'), BR)
      .replace(new RegExp(`^(${BR})+|(${BR})+$`, 'g'), '')
      .replace(new RegExp(BR, 'g'), inTable ? '<br>' : '  \n')
      .replace(/^ +| +$/gm, (m, off, str) => (str[off + m.length] === '\n' && m.length === 2 ? m : ''))
      .trim();
  }

  // ───────────── безопасный HTML ─────────────

  toHtml(node) {
    if (node.nodeType === 3) return U.escapeHtml(node.nodeValue.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || tag === 'script') return '';
    const math = this.mathInfo(el);
    if (math) return U.escapeHtml(math.display ? `$$${math.tex}$$` : `$${math.tex}$`);
    const children = [...el.childNodes].map((n) => this.toHtml(n)).join('');
    if (!HTML_ALLOWED.has(tag)) return children;
    const attrs = [];
    const keep = (name, value) => {
      if (value !== null && value !== undefined && value !== '') attrs.push(` ${name}="${U.escapeHtml(value)}"`);
    };
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (/^javascript:/i.test(href)) return children;
      keep('href', href);
    }
    if (tag === 'img') {
      const src = el.getAttribute('src');
      if (!src) return '';
      const alt = el.getAttribute('alt') || '';
      keep('src', src.startsWith('mi-asset://') || !this.o.assets ? src : this.o.assets.add({ url: src, alt }));
      keep('alt', alt);
      keep('width', el.getAttribute('width'));
    }
    if (tag === 'iframe' || tag === 'video' || tag === 'audio' || tag === 'source') keep('src', el.getAttribute('src'));
    if (tag === 'video' || tag === 'audio') attrs.push(' controls');
    if (tag === 'td' || tag === 'th') {
      keep('colspan', el.getAttribute('colspan'));
      keep('rowspan', el.getAttribute('rowspan'));
    }
    keep('align', el.getAttribute('align'));
    if (tag === 'font' && el.getAttribute('color') && isMeaningfulColor(el.getAttribute('color'))) {
      return `<span style="color:${U.escapeHtml(el.getAttribute('color'))}">${children}</span>`;
    }
    if (this.o.preserveStyles) {
      const st = styleOf(el);
      const parts = [];
      for (const [k, v] of Object.entries(st)) {
        if (!STYLE_PROPS.has(k)) continue;
        if ((k === 'color' || k === 'background-color') && !isMeaningfulColor(v)) continue;
        if (/url\(|expression/i.test(v)) continue;
        parts.push(`${k}:${v}`);
      }
      if (parts.length) keep('style', parts.join(';'));
    }
    if (VOID.has(tag)) return `<${tag}${attrs.join('')}>`;
    const sep = tag === 'tr' || tag === 'thead' || tag === 'tbody' || tag === 'table' ? '\n' : '';
    return `<${tag}${attrs.join('')}>${sep}${children}${sep}</${tag}>`;
  }
}

// ───────────── помощники ─────────────

function wrap(inner, marker) {
  if (!inner || !inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0];
  const trail = inner.match(/\s*$/)[0];
  const core = inner.trim();
  if (core.startsWith(BR) || core.endsWith(BR)) {
    // переносы строк не должны оказаться внутри маркеров
    const parts = core.split(BR).map((p) => (p.trim() ? `${marker}${p.trim()}${marker}` : ''));
    return lead + parts.join(BR) + trail;
  }
  if (core.includes(BR)) {
    return lead + core.split(BR).map((p) => (p.trim() ? `${marker}${p.trim()}${marker}` : '')).join(BR) + trail;
  }
  return `${lead}${marker}${core}${marker}${trail}`;
}

function wrapHtml(inner, tag) {
  if (!inner || !inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0];
  const trail = inner.match(/\s*$/)[0];
  return `${lead}<${tag}>${inner.trim()}</${tag}>${trail}`;
}

function wrapStyled(inner, style) {
  if (!inner || !inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0];
  const trail = inner.match(/\s*$/)[0];
  return `${lead}<span style="${U.escapeHtml(style)}">${inner.trim()}</span>${trail}`;
}

function escText(t) {
  return t
    .replace(/\\/g, '\\\\')
    .replace(/([*`[\]<])/g, '\\$1')
    .replace(/(^|[^\p{L}\p{N}])_/gu, '$1\\_')
    .replace(/_(?=[^\p{L}\p{N}]|$)/gu, '\\_')
    .replace(/\$/g, '\\$')
    .replace(/==/g, '\\=\\=')
    .replace(/~~/g, '\\~\\~')
    .replace(/%%/g, '\\%\\%');
}

function escapeLineStarts(md) {
  return md
    .split('\n')
    .map((l) =>
      l
        .replace(/^(\s*)(#{1,6}\s)/, '$1\\$2')
        .replace(/^(\s*)>/, '$1\\>')
        .replace(/^(\s*)([-+])(\s)/, '$1\\$2$3')
        .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4')
        .replace(/^(\s*)(-{3,}|={3,})\s*$/, '$1\\$2')
    )
    .join('\n');
}

function indentLines(md, depth, keepFirst) {
  const pre = '\t'.repeat(depth);
  return md
    .split('\n')
    .map((l, i) => (l && !(keepFirst && i === 0 && l.startsWith('\t')) ? pre + l.replace(/^\t*/, '') : l))
    .join('\n');
}

/** Чем больше — тем крупнее версия картинки (оригинал без маркеров размера — максимум). */
function sizeScore(url) {
  const u = String(url || '');
  const m = /\/(\d{2,4})px-|[-_](\d{2,4})x(\d{2,4})(?=\.\w+(?:$|\?))|[-_](\d{2,4})w(?=\.\w+(?:$|\?))|[?&](?:w|width)=(\d{2,4})/.exec(u);
  if (m) return Math.max(...m.slice(1).filter(Boolean).map(Number));
  if (/\/thumbs?\/|thumbnail|[-_](small|preview|thumb)\./i.test(u)) return 150;
  return 100000;
}

function isImageUrl(url) {
  return /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?:$|[?#])/i.test(String(url || '').split('#')[0]) || /\/(image|images|img|photo|media)\/[^?#]+\?(.*&)?(w|width|format)=/i.test(url || '');
}

/** Ключ для поиска дублей одной картинки в разных размерах. */
function imageKey(url) {
  if (!url || url.startsWith('mi-asset://')) return url || '';
  if (url.startsWith('data:')) return url.length > 200 ? url.slice(0, 200) + url.length : url;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return url;
  }
  let path = decodeURIComponent(u.pathname).toLowerCase();
  path = path
    .replace(/\/thumb(s|nails?)?\//, '/')
    .replace(/\/(resize|crop|fit|w_\d+[^/]*|c_[^/]+|q_[^/]+|f_[^/]+|\d+x\d*|\d*x\d+)\//g, '/')
    .replace(/\/\d+px-([^/]+)$/, '/$1') // Wikipedia: /thumb/a/ab/Name.jpg/220px-Name.jpg
    .replace(/(\.(jpe?g|png|gif|webp|avif))\/[^/]+$/, '$1')
    .replace(/[-_](\d{2,4}x\d{2,4}|scaled|thumb|thumbnail|small|medium|large|preview|\d{2,4}w)(?=\.\w+$)/g, '')
    .replace(/@\dx(?=\.\w+$)/, '')
    .replace(/\.(webp|avif)$/, '.jpg')
    .replace(/\.jpeg$/, '.jpg');
  // параметры запроса часто и есть адрес картинки (/_next/image?url=…, /resize?src=…, image.php?id=…):
  // оставляем всё, кроме параметров размера/качества
  const SIZE_PARAMS = /^(w|h|width|height|q|quality|fm|format|fit|auto|dpr|crop|resize|size|s|v|ver|version|ts|t)$/i;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !SIZE_PARAMS.test(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('&');
  return u.hostname.replace(/^www\./, '') + path + (params ? `?${params}` : '');
}

function encodeUrl(url) {
  return String(url).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function preText(node) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (n.nodeType === 1) {
      const t = n.tagName.toUpperCase();
      if (t === 'BR') s += '\n';
      else if (t === 'DIV' || t === 'P' || t === 'LI' || /\bline\b/.test(cls(n))) {
        const inner = preText(n);
        s += inner.endsWith('\n') ? inner : inner + '\n';
      } else s += preText(n);
    }
  }
  return s;
}

/** Удобная обёртка: строка HTML → блоки. */
function htmlToBlocks(html, opts) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const conv = new HtmlConverter(opts);
  return conv.convert(doc.body);
}

module.exports = { imageKey, isImageUrl, HtmlConverter, htmlToBlocks, escText, escapeLineStarts, cleanTex, encodeUrl };
