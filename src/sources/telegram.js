'use strict';

/**
 * Telegram: публичный пост (t.me/канал/123) или лента канала (t.me/канал,
 * @канал) — через веб-версию t.me без API-ключей.
 */

const U = require('../util');
const { ImportSession } = require('../session');
const { HtmlConverter } = require('../convert/html2md');
const { formatDate } = require('../attributes');
const { fetchUrl, stripScriptsForPreview } = require('./common');

function parseTelegramInput(input) {
  const s = String(input || '').trim();
  if (/t\.me\/c\//i.test(s)) throw new Error('Ссылки на приватные каналы (t.me/c/…) недоступны без входа в аккаунт');
  let m = /(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{4,})(?:\/(\d+))?/i.exec(s);
  if (m) return { channel: m[1], postId: m[2] ? +m[2] : null };
  m = /^@?([A-Za-z][A-Za-z0-9_]{3,})$/.exec(s);
  if (m) return { channel: m[1], postId: null };
  return null;
}

function isTelegramUrl(url) {
  return /^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i.test(String(url || '').trim());
}

function bgUrl(el) {
  const st = (el && el.getAttribute('style')) || '';
  const m = /background-image:\s*url\(['"]?([^'")]+)['"]?\)/.exec(st);
  return m ? U.absolutize(m[1], 'https://t.me/') : '';
}

/** Один .tgme_widget_message → чистый HTML + сведения. */
function messageToHtml(msg) {
  const parts = [];
  const post = msg.getAttribute('data-post') || '';
  const id = +(post.split('/')[1] || 0);
  const dateEl = msg.querySelector('.tgme_widget_message_date time[datetime], time[datetime]');
  const date = dateEl ? dateEl.getAttribute('datetime') : '';
  const linkEl = msg.querySelector('.tgme_widget_message_date');
  const url = (linkEl && linkEl.getAttribute('href')) || (post ? `https://t.me/${post}` : '');
  const author = ((msg.querySelector('.tgme_widget_message_owner_name') || {}).textContent || '').trim();

  const fwd = msg.querySelector('.tgme_widget_message_forwarded_from');
  if (fwd) parts.push(`<p><em>${U.escapeHtml(fwd.textContent.replace(/\s+/g, ' ').trim())}</em></p>`);

  const reply = msg.querySelector('.tgme_widget_message_reply');
  if (reply) {
    const rAuthor = ((reply.querySelector('.tgme_widget_message_author_name, .tgme_widget_message_author') || {}).textContent || '').trim();
    const rText = ((reply.querySelector('.tgme_widget_message_text, .js-message_reply_text') || {}).textContent || '').trim();
    const rHref = reply.getAttribute('href') || '';
    parts.push(`<blockquote><p>↩ <a href="${U.escapeHtml(rHref)}">${U.escapeHtml(rAuthor || 'Ответ')}</a>: ${U.escapeHtml(U.firstLine(rText, 160))}</p></blockquote>`);
  }

  // медиа
  for (const ph of msg.querySelectorAll('.tgme_widget_message_photo_wrap')) {
    const src = bgUrl(ph);
    if (src) parts.push(`<p><img src="${U.escapeHtml(src)}" alt="Фото"></p>`);
  }
  for (const v of msg.querySelectorAll('.tgme_widget_message_video_player, .tgme_widget_message_roundvideo_player')) {
    const video = v.querySelector('video[src]');
    const thumb = bgUrl(v.querySelector('.tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb'));
    if (video) parts.push(`<video src="${U.escapeHtml(video.getAttribute('src'))}"${thumb ? ` poster="${U.escapeHtml(thumb)}"` : ''}></video>`);
    else if (thumb) parts.push(`<p><a href="${U.escapeHtml(url)}"><img src="${U.escapeHtml(thumb)}" alt="Видео"></a></p>`);
  }
  const sticker = msg.querySelector('.tgme_widget_message_sticker[data-webp], .tgme_widget_message_sticker_wrap img');
  if (sticker) {
    const s = sticker.getAttribute('data-webp') || sticker.getAttribute('src') || bgUrl(sticker);
    if (s) parts.push(`<p><img src="${U.escapeHtml(s)}" alt="Стикер" width="160"></p>`);
  }
  for (const d of msg.querySelectorAll('.tgme_widget_message_document')) {
    const t = ((d.querySelector('.tgme_widget_message_document_title') || {}).textContent || 'Документ').trim();
    const ex = ((d.querySelector('.tgme_widget_message_document_extra') || {}).textContent || '').trim();
    parts.push(`<p>📎 <a href="${U.escapeHtml(url)}">${U.escapeHtml(t)}</a>${ex ? ` — ${U.escapeHtml(ex)}` : ''}</p>`);
  }
  const voice = msg.querySelector('.tgme_widget_message_voice');
  if (voice && voice.getAttribute('src')) parts.push(`<audio src="${U.escapeHtml(voice.getAttribute('src'))}"></audio>`);

  // текст сообщения (не цитата ответа)
  const texts = [...msg.querySelectorAll('.tgme_widget_message_text')].filter((t) => !t.closest('.tgme_widget_message_reply, .tgme_widget_message_link_preview'));
  const textEl = texts[texts.length - 1];
  let plain = '';
  if (textEl) {
    const clone = textEl.cloneNode(true);
    for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
    plain = clone.textContent.trim();
    // эмодзи-картинки → символы
    for (const e of textEl.querySelectorAll('i.emoji')) e.replaceWith(msg.ownerDocument.createTextNode(e.textContent));
    parts.push(`<div class="tg-text">${textEl.innerHTML}</div>`);
  }

  // опрос
  const poll = msg.querySelector('.tgme_widget_message_poll');
  if (poll) {
    const q = ((poll.querySelector('.tgme_widget_message_poll_question') || {}).textContent || '').trim();
    const opts = [...poll.querySelectorAll('.tgme_widget_message_poll_option')].map((o) => {
      const pct = ((o.querySelector('.tgme_widget_message_poll_option_percent') || {}).textContent || '').trim();
      const txt = ((o.querySelector('.tgme_widget_message_poll_option_text') || {}).textContent || '').trim();
      return `<li>${U.escapeHtml(txt)}${pct ? ` — ${U.escapeHtml(pct)}` : ''}</li>`;
    });
    parts.push(`<p><strong>📊 ${U.escapeHtml(q)}</strong></p><ul>${opts.join('')}</ul>`);
  }

  // превью ссылки
  const lp = msg.querySelector('.tgme_widget_message_link_preview');
  if (lp) {
    const href = lp.getAttribute('href') || '';
    const site = ((lp.querySelector('.link_preview_site_name') || {}).textContent || '').trim();
    const t = ((lp.querySelector('.link_preview_title') || {}).textContent || '').trim();
    const d = ((lp.querySelector('.link_preview_description') || {}).textContent || '').trim();
    const img = bgUrl(lp.querySelector('.link_preview_image, .link_preview_right_image'));
    parts.push(
      `<blockquote class="info"><p><strong>${U.escapeHtml(site)}</strong>${t ? ` — <a href="${U.escapeHtml(href)}">${U.escapeHtml(t)}</a>` : ''}</p>${d ? `<p>${U.escapeHtml(d)}</p>` : ''}${
        img ? `<p><img src="${U.escapeHtml(img)}" width="320"></p>` : ''
      }</blockquote>`
    );
  }

  const views = ((msg.querySelector('.tgme_widget_message_views') || {}).textContent || '').trim();
  return { id, post, url, date, author, html: parts.join('\n'), plain, views };
}

async function fetchPost(settings, channel, postId) {
  const url = `https://t.me/${channel}/${postId}?embed=1&mode=tme`;
  const { buffer, contentType } = await fetchUrl(settings, url);
  const html = U.decodeBuffer(buffer, contentType);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const msg = doc.querySelector('.tgme_widget_message');
  if (!msg || doc.querySelector('.tgme_widget_message_error')) throw new Error('Пост не найден или канал закрыт для веб-просмотра');
  if (!msg.getAttribute('data-post')) msg.setAttribute('data-post', `${channel}/${postId}`);
  const channelTitle = ((doc.querySelector('.tgme_widget_message_owner_name') || {}).textContent || channel).trim();
  return { messages: [messageToHtml(msg)], channelTitle, rawHtml: html, previewUrl: url };
}

async function fetchChannel(settings, channel, count, onProgress) {
  const collected = new Map();
  let before = null;
  let channelTitle = channel;
  let description = '';
  let firstHtml = '';
  for (let page = 0; page < 30 && collected.size < count; page++) {
    const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
    const { buffer, contentType } = await fetchUrl(settings, url);
    const html = U.decodeBuffer(buffer, contentType);
    if (!firstHtml) firstHtml = html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const titleEl = doc.querySelector('.tgme_channel_info_header_title');
    if (titleEl) channelTitle = titleEl.textContent.trim();
    const descEl = doc.querySelector('.tgme_channel_info_description');
    if (descEl) description = descEl.textContent.trim();
    const msgs = [...doc.querySelectorAll('.tgme_widget_message[data-post]')];
    if (!msgs.length) {
      if (!page) throw new Error('Лента канала недоступна (канал приватный или отключён предпросмотр)');
      break;
    }
    let minId = Infinity;
    let added = 0;
    for (const el of msgs) {
      const m = messageToHtml(el);
      if (m.id && !collected.has(m.id)) {
        collected.set(m.id, m);
        added++;
      }
      if (m.id) minId = Math.min(minId, m.id);
    }
    if (onProgress) onProgress(`Загружено постов: ${Math.min(collected.size, count)}/${count}`, Math.min(1, collected.size / count));
    if (!added || minId <= 1) break;
    before = minId;
  }
  const messages = [...collected.values()].sort((a, b) => b.id - a.id).slice(0, count).reverse();
  return { messages, channelTitle, description, rawHtml: firstHtml, previewUrl: `https://t.me/s/${channel}` };
}

function postTitle(m, channelTitle) {
  const line = U.firstLine(m.plain, 70);
  if (line) return line;
  return `${channelTitle} — ${m.date ? U.humanDate(m.date, false) : m.id}`;
}

async function createTelegramSession(plugin, input, { count, onProgress } = {}) {
  const parsed = parseTelegramInput(input);
  if (!parsed) throw new Error('Не распознал ссылку Telegram. Пример: https://t.me/durov/123 или @durov');
  const s = plugin.settings;
  const single = !!parsed.postId;
  if (onProgress) onProgress(single ? 'Загружаю пост…' : 'Загружаю ленту канала…', 0.1);
  const data = single ? await fetchPost(s, parsed.channel, parsed.postId) : await fetchChannel(s, parsed.channel, count || s.telegramCount, onProgress);
  if (!data.messages.length) throw new Error('Постов не найдено');

  const groupMeta = {};
  for (const m of data.messages) {
    groupMeta[String(m.id)] = { title: U.sanitizeFileName(postTitle(m, data.channelTitle)), source: m.url, published: m.date };
  }
  const first = data.messages[0];
  const last = data.messages[data.messages.length - 1];
  const title = single
    ? U.sanitizeFileName(postTitle(first, data.channelTitle))
    : U.sanitizeFileName(`${data.channelTitle} — ${first.date ? U.humanDate(first.date, false) : ''}${last !== first && last.date ? ` – ${U.humanDate(last.date, false)}` : ''}`);

  const session = new ImportSession(plugin, {
    kind: 'telegram',
    title,
    meta: {
      source: single ? first.url : `https://t.me/${parsed.channel}`,
      author: data.channelTitle,
      published: single ? first.date : '',
      site: 'Telegram',
      description: data.description || '',
    },
    sourceRef: single ? first.url : `https://t.me/s/${parsed.channel}`,
    size: data.messages.reduce((sum, m) => sum + m.html.length, 0),
    groupMeta: single ? null : groupMeta,
    original: { type: 'html', html: stripScriptsForPreview(data.rawHtml, 'https://t.me/'), baseUrl: data.previewUrl },
    builder: async (o, sess) => {
      const blocks = [];
      for (const m of data.messages) {
        const doc = new DOMParser().parseFromString(`<body>${m.html}</body>`, 'text/html');
        const conv = new HtmlConverter({
          baseUrl: 'https://t.me/',
          assets: sess.assets,
          tablesMarkdown: o.tablesMarkdown,
          callouts: o.callouts,
          preserveStyles: o.preserveStyles,
          latex: false,
        });
        const group = String(m.id);
        if (!single) {
          const when = m.date ? formatDate(m.date, plugin.settings.dateFormat) : `#${m.id}`;
          blocks.push({ type: 'heading', level: 3, md: `### [${when}](${m.url})`, text: when, group, meta: true });
        }
        for (const b of conv.convert(doc.body)) blocks.push(Object.assign(b, { group }));
        if (!single && m.views) blocks.push({ type: 'meta', md: `<small>👁 ${U.escapeHtml(m.views)}</small>`, text: `Просмотры: ${m.views}`, group, html: true });
      }
      return blocks;
    },
  });
  return session;
}

module.exports = { createTelegramSession, parseTelegramInput, isTelegramUrl };
