'use strict';

/**
 * Загрузка страницы через встроенный браузер Obsidian (Electron <webview>,
 * настоящий Chromium): проходит защиты от ботов (Cloudflare, Akamai, DataDome),
 * выполняет JavaScript — работает и для сайтов, которые рисуют статью скриптами.
 * Куки сохраняются в отдельном разделе, поэтому капчу достаточно пройти один раз.
 * Только для десктопа.
 */

const { Platform, Modal, Notice } = require('obsidian');

const PARTITION = 'persist:markimporter';
const CHALLENGE_RE =
  /(cf-challenge|challenge-platform|cf_chl_|Just a moment|Checking your browser|Проверка браузера|captcha-delivery|geo\.captcha|px-captcha|_Incapsula_Resource|Access Denied|Request unsuccessful|DDoS protection|hcaptcha|recaptcha\/api)/i;

function canUseBrowser() {
  return !!Platform.isDesktopApp;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class CaptchaModal extends Modal {
  constructor(app, webview, onDone, onCancel) {
    super(app);
    this.webview = webview;
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.finished = false;
  }
  onOpen() {
    this.modalEl.addClass('mi-captcha-modal');
    this.titleEl.setText('Сайт просит подтвердить, что вы человек');
    const info = this.contentEl.createDiv({ cls: 'mi-captcha-info' });
    info.setText('Пройдите проверку в окне ниже. Когда появится статья — нажмите «Забрать страницу». Повторно проверка обычно не нужна.');
    // webview не переносим в окно (перенос перезагружает страницу) — кладём поверх области окна
    const host = this.contentEl.createDiv({ cls: 'mi-captcha-host' });
    this.place = () => {
      const r = host.getBoundingClientRect();
      Object.assign(this.webview.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    this.webview.addClass('mi-captcha-webview');
    requestAnimationFrame(this.place);
    setTimeout(this.place, 150);
    window.addEventListener('resize', this.place);
    const bar = this.contentEl.createDiv({ cls: 'mi-captcha-bar' });
    const cancel = bar.createEl('button', { text: 'Отмена' });
    const ok = bar.createEl('button', { text: 'Забрать страницу', cls: 'mod-cta' });
    cancel.onclick = () => this.close();
    ok.onclick = () => {
      this.finished = true;
      this.onDone();
      this.close();
    };
  }
  onClose() {
    window.removeEventListener('resize', this.place);
    this.webview.removeClass('mi-captcha-webview');
    this.webview.addClass('mi-hidden-webview');
    this.webview.removeAttribute('style');
    if (!this.finished) this.onCancel();
  }
}

/**
 * @returns {Promise<{html:string, url:string, title:string}>}
 */
function fetchViaBrowser(app, settings, url, { onProgress, timeout = 45000 } = {}) {
  if (!canUseBrowser()) return Promise.reject(new Error('Встроенный браузер доступен только в настольной версии Obsidian'));
  return new Promise((resolve, reject) => {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('useragent', settings.userAgent);
    wv.setAttribute('src', url);
    wv.addClass('mi-hidden-webview');
    let settled = false;
    let modal = null;
    let status = 0;
    let timer = null;
    let checking = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (modal) {
        modal.finished = true;
        modal.close();
      }
      setTimeout(() => wv.remove(), 50);
    };
    const finish = (val, err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(val);
    };
    const grab = async () => {
      const data = await wv.executeJavaScript(
        `(() => { window.scrollTo(0, document.body.scrollHeight); return { html: document.documentElement.outerHTML, url: location.href, title: document.title }; })()`
      );
      return data;
    };
    const showCaptcha = () => {
      if (modal || settled) return;
      if (onProgress) onProgress('Нужна проверка «я не робот» — открыл окно', 0.5);
      wv.removeClass('mi-hidden-webview');
      wv.addClass('mi-captcha-webview');
      modal = new CaptchaModal(
        app,
        wv,
        async () => {
          try {
            finish(await grab());
          } catch (e) {
            finish(null, e);
          }
        },
        () => finish(null, new Error('Проверка отменена'))
      );
      modal.open();
    };

    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        await sleep(1500); // даём скриптам дорисовать статью
        if (settled) return;
        const data = await grab();
        const text = data.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
        const isChallenge = CHALLENGE_RE.test(data.title) || (CHALLENGE_RE.test(data.html) && text.replace(/\s+/g, ' ').length < 3000);
        if (isChallenge || status === 403 || status === 429) {
          if (onProgress) onProgress('Сайт проверяет браузер…', 0.4);
          setTimeout(() => {
            if (!settled && !modal) showCaptcha();
          }, 6000);
          return;
        }
        if (modal) return; // пользователь сам нажмёт «Забрать»
        await sleep(800);
        finish(await grab());
      } catch (e) {
        /* страница ещё грузится — дождёмся следующего события */
      } finally {
        checking = false;
      }
    };

    wv.addEventListener('did-navigate', (e) => {
      status = e.httpResponseCode || 0;
    });
    wv.addEventListener('did-finish-load', check);
    wv.addEventListener('did-fail-load', (e) => {
      if (e.isMainFrame && e.errorCode !== -3) finish(null, new Error(`Браузер не открыл страницу: ${e.errorDescription || e.errorCode}`));
    });
    timer = setTimeout(() => {
      if (!settled && !modal) showCaptcha();
      setTimeout(() => {
        if (!settled && !modal) finish(null, new Error('Страница не загрузилась за отведённое время'));
      }, timeout);
    }, timeout);

    document.body.appendChild(wv);
    if (onProgress) onProgress('Открываю страницу во встроенном браузере…', 0.25);
  });
}

module.exports = { fetchViaBrowser, canUseBrowser, CHALLENGE_RE, Notice };
