'use strict';

/**
 * Сессия импорта: исходник + разобранные блоки + состояние конструктора.
 * Источники (src/sources/*) создают сессию и задают builder(options) → blocks.
 */

const { AssetRegistry } = require('./assets');
const { SOURCE_LABELS } = require('./constants');
const { buildAttributes } = require('./attributes');
const U = require('./util');

/** Опции, при смене которых нужно заново разобрать исходник. */
const PARSE_KEYS = ['removeHeaders', 'tablesMarkdown', 'callouts', 'preserveStyles', 'latex', 'extractImages', 'pageImages', 'extraction'];

class ImportSession {
  constructor(plugin, init) {
    this.plugin = plugin;
    this.id = U.uid();
    this.kind = init.kind; // pdf | web | telegram | clipboard | docx | text | markdown | html
    this.title = init.title || 'Без названия';
    this.originalTitle = this.title;
    this.meta = Object.assign({ source: '', author: '', published: '', site: '', description: '', lang: '', keywords: [] }, init.meta || {});
    this.original = init.original || null; // { type: 'html'|'pdf'|'text', ... }
    this.sourceRef = init.sourceRef || '';
    this.size = init.size || 0;
    this.pages = init.pages || 0;
    this.rawBuffer = init.rawBuffer || null;
    this.fileName = init.fileName || '';
    this.groupMeta = init.groupMeta || null; // для Telegram-лент: { [group]: { title, source, published } }
    this.assets = new AssetRegistry(plugin.settings);
    this.builder = init.builder;
    this.prepare = init.prepare || null; // async (options) перед builder (например, рендер страниц PDF)
    this.onDispose = init.onDispose || null;

    const s = plugin.settings;
    this.options = {
      mode: s.defaultMode,
      removeHeaders: s.removeHeaders,
      tablesMarkdown: s.tablesMarkdown,
      callouts: s.callouts,
      preserveStyles: s.preserveStyles,
      latex: s.latex,
      extractImages: s.pdfExtractImages,
      pageImages: s.pdfPageImages,
      frontmatter: s.frontmatter,
      autoWikilinks: s.autoWikilinks,
      saveOriginalPdf: s.saveOriginalPdf,
      downloadImages: s.downloadImages,
      extraction: s.extraction,
      split: init.kind === 'telegram' ? s.telegramSplit : false,
    };
    if (init.options) Object.assign(this.options, init.options);

    this.blocks = [];
    this.order = [];
    this.disabled = new Set();
    this.rawOverride = null;
    this.folder = s.folder;
    this.created = new Date();
  }

  get label() {
    const names = this.plugin.settings.typeNames || {};
    return names[this.kind] || SOURCE_LABELS[this.kind] || this.kind;
  }

  get hasGroups() {
    return !!this.groupMeta && Object.keys(this.groupMeta).length > 1;
  }

  async rebuild() {
    if (this.prepare) await this.prepare(this.options, this);
    const raw = await this.builder(this.options, this);
    this.blocks = raw.map((b, i) => Object.assign({ id: `b${i}` }, b));
    this.order = this.blocks.map((b) => b.id);
    this.disabled.clear();
  }

  needsRebuild(changedKey) {
    return PARSE_KEYS.includes(changedKey);
  }

  blockById(id) {
    return this.blocks.find((b) => b.id === id);
  }

  activeBlocks(group) {
    return this.order
      .map((id) => this.blockById(id))
      .filter((b) => b && !this.disabled.has(b.id) && (group === undefined || b.group === group));
  }

  tags() {
    const s = this.plugin.settings;
    const tags = String(s.defaultTags || '')
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
    if (s.addSourceTag) tags.push(`source/${this.kind}`);
    return [...new Set(tags)];
  }

  frontmatter(extra = {}, groupMeta = null, words = 0) {
    const m = groupMeta ? Object.assign({}, this.meta, groupMeta) : this.meta;
    const title = groupMeta && groupMeta.title ? groupMeta.title : this.title;
    const fm = buildAttributes(this.plugin.settings, {
      title,
      originalTitle: groupMeta ? '' : this.originalTitle,
      source: m.source || this.sourceRef,
      author: m.author,
      published: m.published,
      site: m.site,
      description: m.description,
      kind: this.kind,
      pages: this.pages,
      words,
      file: extra.file || '',
      tags: this.tags(),
    });
    return U.buildFrontmatter(fm);
  }

  /** Плоский текст блока (режим «Без вёрстки»). */
  static flatText(b) {
    if (b.type === 'code') return b.md.replace(/^(```+|~~~+)[^\n]*\n?/, '').replace(/\n?(```+|~~~+)\s*$/, '');
    if (b.type === 'math') return b.text || '';
    if (b.type === 'table' && !b.html) {
      return b.md
        .split('\n')
        .filter((l) => !/^\|\s*:?-{3,}/.test(l))
        .map((l) =>
          l
            .replace(/^\|\s*|\s*\|$/g, '')
            .split(/\s*(?<!\\)\|\s*/)
            .map((c) => plainLine(c))
            .join('\t')
        )
        .join('\n');
    }
    if (b.html) return b.text || '';
    return b.md
      .split('\n')
      .map((l) => plainLine(l.replace(/^\s*>\s?(\[![^\]]+\][-+]?\s*)?/, '').replace(/^(\t*)([-*+]|\d+\.)\s(\[[ x]\]\s)?/, '$1• ')))
      .join('\n')
      .replace(/^\s*\n/gm, '');
  }

  /**
   * Собирает Markdown.
   * @returns {{ md: string, body: string, stats: object }}
   */
  compose({ group, extraFm, forPreview } = {}) {
    const o = this.options;
    const blocks = this.activeBlocks(group);
    let body;
    if (o.mode === 'flat') {
      body = blocks
        .filter((b) => !['image', 'hr', 'embed'].includes(b.type) && !b.caption)
        .map((b) => ImportSession.flatText(b))
        .filter((t) => t.trim())
        .join('\n\n');
    } else {
      body = blocks.map((b) => b.md).join('\n\n');
      if (o.autoWikilinks) body = applyWikilinks(body, this.plugin.app, this.title);
    }
    let md;
    if (this.rawOverride !== null && group === undefined) {
      md = this.rawOverride;
    } else {
      const gm = group !== undefined && this.groupMeta ? this.groupMeta[group] : null;
      const fm = o.frontmatter ? this.frontmatter(extraFm || {}, gm, U.countWords(U.stripMarkdown(body))) : '';
      md = (fm ? fm + '\n' : '') + body.trim() + '\n';
    }
    return { md, body, stats: this.stats(md, blocks), forPreview };
  }

  stats(md, blocks) {
    const bodyOnly = md.replace(/^---\n[\s\S]*?\n---\n/, '');
    const plain = U.stripMarkdown(bodyOnly);
    const tables = (bodyOnly.match(/^\|[^\n]*\|\s*\n\|\s*:?-{3,}/gm) || []).length + (bodyOnly.match(/<table[\s>]/g) || []).length;
    const formulas = (bodyOnly.match(/\$\$[\s\S]+?\$\$/g) || []).length + (bodyOnly.replace(/\$\$[\s\S]+?\$\$/g, '').match(/(?<![\\$])\$[^$\n]+?\$(?!\$)/g) || []).length;
    const links = (bodyOnly.match(/(?<!!)\[\[/g) || []).length;
    const images = (bodyOnly.match(/!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\]|<img\s/g) || []).length;
    const blockTypes = {};
    for (const b of blocks) blockTypes[b.type] = (blockTypes[b.type] || 0) + 1;
    return {
      bytes: new TextEncoder().encode(md).length,
      words: U.countWords(plain),
      tables,
      formulas,
      links,
      images,
      blocks: blocks.length,
      blockTypes,
    };
  }

  dispose() {
    this.assets.dispose();
    if (this.onDispose) {
      try {
        this.onDispose();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function plainLine(l) {
  return l
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/(\*\*|__|~~|==)/g, '')
    .replace(/(^|[^\\])\*(?=\S)|(?<=\S)\*(?!\*)/g, '$1')
    .replace(/`/g, '')
    .replace(/\\([\\`*_[\]<>#+\-.!|$=~%])/g, '$1')
    .replace(/\s+$/, '');
}

/** Первые упоминания названий существующих заметок → [[ссылки]]. */
function applyWikilinks(body, app, selfTitle) {
  if (!app || !app.vault) return body;
  const names = [
    ...new Set(
      app.vault
        .getMarkdownFiles()
        .map((f) => f.basename)
        .filter((n) => n.length >= 4 && n !== selfTitle && !/^\d+$/.test(n) && !/[[\]|#^]/.test(n))
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4000);
  if (!names.length) return body;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  try {
    re = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'u');
  } catch (e) {
    return body;
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const used = new Set();
  const protectedRe = /```[\s\S]*?```|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|\[\[[^\]\n]*\]\]|<[^>\n]+>|https?:\/\/\S+|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|^#{1,6} .*$/gm;
  let out = '';
  let last = 0;
  const linkify = (text) => {
    let result = '';
    let rest = text;
    while (rest) {
      const m = re.exec(rest);
      if (!m) {
        result += rest;
        break;
      }
      const name = lower.get(m[1].toLowerCase()) || m[1];
      result += rest.slice(0, m.index);
      if (used.has(name)) result += m[1];
      else {
        used.add(name);
        result += name === m[1] ? `[[${name}]]` : `[[${name}|${m[1]}]]`;
      }
      rest = rest.slice(m.index + m[1].length);
    }
    return result;
  };
  let m;
  while ((m = protectedRe.exec(body))) {
    out += linkify(body.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += linkify(body.slice(last));
  return out;
}

module.exports = { ImportSession, applyWikilinks, PARSE_KEYS };
