'use strict';

/**
 * Упрощённый «Readability»: метаданные страницы + поиск основного контента.
 * Работает над Document, полученным через DOMParser (скрипты не исполняются).
 */

const U = require('../util');

const JUNK_SELECTOR = [
  'script:not([type^="math/tex"])', 'style', 'noscript', 'template', 'link', 'meta', 'object', 'embed:not([src*="youtube"])',
  'form', 'button', 'input:not([type="checkbox"])', 'select', 'textarea', 'dialog',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]', '[role="dialog"]',
  '[aria-hidden="true"]', '[hidden]',
  '.mw-editsection', '.navbox', '.vertical-navbox', '.noprint', '.mw-jump-link', '#toc', '.toc',
  '.sharedaddy', '.share', '.sharing', '.social-share', '.addtoany_share_save_container',
  '.advert', '.advertisement', '.ads', '.ad-container', '.adsbygoogle', '.banner-ad',
  '.cookie', '.cookies', '#cookie-banner', '.gdpr', '.newsletter', '.subscribe-widget',
].join(',');

const NEGATIVE = /(^|[\s_-])(comment|comments|meta|footer|footnote-back|sidebar|sponsor|advert|promo|related|recommend|share|social|nav|navbar|menu|breadcrumb|header|masthead|widget|subscribe|newsletter|popup|modal|banner|cookie|tags?-list|author-bio|pagination|pager|outbrain|taboola)([\s_-]|$)/i;
const POSITIVE = /(article|body|content|entry|main|page|post|text|blog|story|markdown|prose|tm-article|lj-|aentry|singlepost)/i;

const PREFERRED_SELECTORS = [
  'article .tm-article-body', // Habr
  '#post-content-body',
  '.aentry-post__text', // LiveJournal
  '.b-singlepost-bodywrapper',
  '.entry-content',
  '.asset-body',
  '[itemprop="articleBody"]',
  '.available-content', // Substack
  '.post-content',
  '.article-body',
  '.article__body',
  '.article-content',
  '.post-body',
  '.markdown-body', // GitHub
  '.tl_article_content', // Telegraph
  '#mw-content-text .mw-parser-output', // Wikipedia
  '.content__body',
];

function meta(doc, ...names) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el && (el.getAttribute('content') || '').trim();
    if (v) return v;
  }
  return '';
}

function extractMetadata(doc, url) {
  const ldJson = parseLdJson(doc);
  const title =
    meta(doc, 'og:title', 'twitter:title') ||
    (ldJson && ldJson.headline) ||
    textOf(doc.querySelector('h1')) ||
    textOf(doc.querySelector('title'));
  let author =
    meta(doc, 'author', 'article:author', 'twitter:creator', 'dc.creator') ||
    (ldJson && ldJson.author && (Array.isArray(ldJson.author) ? ldJson.author.map((a) => a.name || a).join(', ') : ldJson.author.name || ldJson.author)) ||
    textOf(doc.querySelector('[rel="author"], .author-name, .byline [itemprop="name"], [itemprop="author"] [itemprop="name"], .tm-user-info__username'));
  if (typeof author !== 'string') author = '';
  if (/^https?:/.test(author)) author = '';
  const published =
    meta(doc, 'article:published_time', 'datePublished', 'pubdate', 'date', 'dc.date', 'og:published_time') ||
    (ldJson && ldJson.datePublished) ||
    ((doc.querySelector('time[datetime]') || {}).getAttribute
      ? doc.querySelector('time[datetime]').getAttribute('datetime')
      : '');
  const description = meta(doc, 'og:description', 'description', 'twitter:description');
  let site = meta(doc, 'og:site_name', 'application-name');
  if (!site && url) {
    try {
      site = new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      /* ignore */
    }
  }
  const image = meta(doc, 'og:image', 'twitter:image');
  const lang = (doc.documentElement && doc.documentElement.getAttribute('lang')) || meta(doc, 'og:locale');
  const keywords = meta(doc, 'keywords', 'news_keywords')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    title: cleanTitle(title, site),
    author: (author || '').trim(),
    published: published || '',
    description,
    site,
    image: image ? U.absolutize(image, url) : '',
    lang: lang || '',
    keywords,
  };
}

function parseLdJson(doc) {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      let data = JSON.parse(s.textContent);
      if (data['@graph']) data = data['@graph'];
      const list = Array.isArray(data) ? data : [data];
      const art = list.find((x) => x && /Article|BlogPosting|NewsArticle|Report/.test(String(x['@type'])));
      if (art) return art;
    } catch (e) {
      /* битый JSON */
    }
  }
  return null;
}

function cleanTitle(title, site) {
  title = String(title || '').replace(/\s+/g, ' ').trim();
  if (site && title.length > site.length + 5) {
    for (const sep of [' | ', ' — ', ' - ', ' :: ', ' · ', ' / ']) {
      if (title.endsWith(sep + site)) return title.slice(0, -(sep.length + site.length)).trim();
    }
  }
  return title;
}

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function linkDensity(el) {
  const total = el.textContent.length || 1;
  let links = 0;
  for (const a of el.querySelectorAll('a')) links += a.textContent.length;
  return links / total;
}

function classAndId(el) {
  return `${el.className && el.className.baseVal === undefined ? el.className : ''} ${el.id || ''}`;
}

/** Подготовка документа: ленивые картинки, мусор. Вызывается всегда. */
function prepareDocument(doc, baseUrl) {
  // ленивые изображения
  for (const img of doc.querySelectorAll('img')) {
    const lazy =
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-url') ||
      img.getAttribute('data-hi-res-src');
    const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
    const best = bestFromSrcset(srcset);
    const src = img.getAttribute('src') || '';
    if (lazy && (!src || src.startsWith('data:image/gif') || src.startsWith('data:image/svg') || /placeholder|blank|spacer/.test(src))) {
      img.setAttribute('src', lazy);
    } else if (best && (!src || src.startsWith('data:'))) {
      img.setAttribute('src', best);
    } else if (best && !src.startsWith('data:')) {
      img.setAttribute('src', best);
    }
  }
  // <picture><source srcset> без img src
  for (const pic of doc.querySelectorAll('picture')) {
    const img = pic.querySelector('img');
    const source = pic.querySelector('source[srcset]');
    if (img && source && !img.getAttribute('src')) img.setAttribute('src', bestFromSrcset(source.getAttribute('srcset')));
  }
  // noscript с картинкой (часто fallback для lazy)
  for (const ns of [...doc.querySelectorAll('noscript')]) {
    // содержимое noscript бывает и элементами (DOMParser), и текстом-HTML (браузер со скриптами)
    let img = ns.querySelector('img');
    if (!img && /<img/i.test(ns.textContent)) {
      const tmp = doc.createElement('div');
      tmp.innerHTML = ns.textContent;
      img = tmp.querySelector('img');
    }
    if (!img || !img.getAttribute('src')) continue;
    const nsSrc = U.absolutize(img.getAttribute('src'), baseUrl).split('?')[0];
    // рядом уже есть та же картинка (ленивая подгрузка уже подставила адрес) — копия не нужна
    const same = ns.parentElement && [...ns.parentElement.querySelectorAll('img[src]')].some((im) => {
      if (ns.contains(im)) return false;
      const s1 = im.getAttribute('src') || '';
      return !s1.startsWith('data:') && U.absolutize(s1, baseUrl).split('?')[0] === nsSrc;
    });
    if (same) {
      ns.remove();
      continue;
    }
    // заглушка ленивой загрузки прямо перед noscript — заменяем её настоящей картинкой
    const prev = ns.previousElementSibling;
    if (prev && prev.tagName === 'IMG' && (!prev.getAttribute('src') || prev.getAttribute('src').startsWith('data:'))) prev.remove();
    ns.replaceWith(img);
  }
  // абсолютные ссылки
  for (const a of doc.querySelectorAll('a[href]')) a.setAttribute('href', U.absolutize(a.getAttribute('href'), baseUrl));
  for (const el of doc.querySelectorAll('img[src], video[src], audio[src], source[src], iframe[src]')) {
    el.setAttribute('src', U.absolutize(el.getAttribute('src'), baseUrl));
  }
  for (const el of doc.querySelectorAll('video[poster]')) el.setAttribute('poster', U.absolutize(el.getAttribute('poster'), baseUrl));
}

function bestFromSrcset(srcset) {
  if (!srcset) return '';
  let best = '';
  let bestW = -1;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [u, d] = part.trim().split(/\s+/);
    const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
    if (u && w > bestW) {
      best = u;
      bestW = w;
    }
  }
  return best;
}

function removeJunk(root) {
  for (const el of root.querySelectorAll(JUNK_SELECTOR)) {
    // не выкидываем формулы и встраивания видео
    if (el.closest('.katex, math, mjx-container')) continue;
    el.remove();
  }
}

/**
 * Возвращает элемент с основным контентом.
 * @param {Document} doc
 * @param {'auto'|'full'} mode
 */
function extractContent(doc, mode = 'auto') {
  const body = doc.body || doc.documentElement;
  if (mode === 'full') {
    removeJunk(body);
    for (const el of body.querySelectorAll('nav, aside, footer, header')) el.remove();
    return body;
  }

  for (const sel of PREFERRED_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el && el.textContent.trim().length > 300) {
      removeJunk(el);
      cleanInside(el);
      return el;
    }
  }

  removeJunk(body);

  const articles = [...doc.querySelectorAll('article')].filter((a) => a.textContent.trim().length > 400);
  if (articles.length === 1) {
    cleanInside(articles[0]);
    return articles[0];
  }

  // скоринг кандидатов
  const scores = new Map();
  const addScore = (el, v) => {
    if (!el || el === doc.documentElement) return;
    if (!scores.has(el)) {
      let base = 0;
      const ci = classAndId(el);
      if (NEGATIVE.test(ci)) base -= 25;
      if (POSITIVE.test(ci)) base += 25;
      if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') base += 15;
      scores.set(el, base);
    }
    scores.set(el, scores.get(el) + v);
  };
  for (const p of body.querySelectorAll('p, pre, td, blockquote, li, div > br + br')) {
    const text = (p.textContent || '').trim();
    if (text.length < 25) continue;
    const score = 1 + (text.split(/[,،，]/).length - 1) + Math.min(3, Math.floor(text.length / 100));
    addScore(p.parentElement, score);
    if (p.parentElement) addScore(p.parentElement.parentElement, score / 2);
  }
  let best = null;
  let bestScore = -Infinity;
  for (const [el, score] of scores) {
    const adjusted = score * (1 - linkDensity(el));
    if (adjusted > bestScore) {
      bestScore = adjusted;
      best = el;
    }
  }
  if (!best) return body;

  // если у лучшего кандидата родитель содержит несколько хороших соседей — берём родителя
  const parent = best.parentElement;
  if (parent && parent !== body) {
    const siblings = [...parent.children].filter((c) => c !== best && scores.has(c) && scores.get(c) > bestScore * 0.3);
    if (siblings.length >= 1) best = parent;
  }
  cleanInside(best);
  return best;
}

function cleanInside(root) {
  removeJunk(root);
  for (const el of [...root.querySelectorAll('div, section, ul, aside, nav, footer, header')]) {
    if (!el.isConnected) continue;
    const ci = classAndId(el);
    const text = el.textContent.trim();
    const hasMedia = el.querySelector('img, video, iframe, table, pre, math, .katex');
    if (NEGATIVE.test(ci) && !POSITIVE.test(ci) && text.length < 2000) {
      el.remove();
      continue;
    }
    if (!hasMedia && text.length < 200 && el.querySelectorAll('a').length > 2 && linkDensity(el) > 0.6) el.remove();
  }
}

module.exports = { extractMetadata, extractContent, prepareDocument, cleanTitle };
