'use strict';

/** Вкладка «Настройки» в окне плагина: навигация по разделам слева, раздел справа. */

const D = require('./dom');
const { renderSettings, SECTIONS } = require('../settings');

const HINTS = {
  save: 'Папки для заметок, фото и видео',
  attachments: 'Скачивание, имена файлов, формат ссылок',
  attributes: 'Свойства frontmatter: свои названия, порядок, свои атрибуты',
  parse: 'Режимы и правила разбора по умолчанию',
  telegram: 'Лента каналов и разбивка на заметки',
  network: 'User-Agent и закладка для браузера',
  journal: 'История импорта',
};

function renderSettingsTab(view, root) {
  const section = view.ui.settingsSection || 'save';

  const head = D.div(root, 'mi-stats-head');
  const left = D.div(head, 'mi-stats-titles');
  const crumbs = D.div(left, 'mi-crumbs');
  D.chip(crumbs, 'НАСТРОЙКИ', 'mi-chip-mono mi-chip-accent');
  D.el(crumbs, 'span', 'mi-label', `/ ${SECTIONS.find((s) => s.id === section).label}`);
  D.el(left, 'h1', 'mi-h1', 'Настройки MarkImporter');
  D.el(left, 'p', 'mi-sub', 'Изменения сохраняются сразу. Эти же настройки доступны в «Настройки → Сторонние плагины → MarkImporter».');

  const layout = D.div(root, 'mi-settings-layout');
  const nav = D.div(layout, 'mi-card mi-settings-nav');
  for (const s of SECTIONS) {
    const b = nav.createEl('button', { cls: 'mi-settings-nav-item' + (s.id === section ? ' is-active' : '') });
    const ib = D.div(b, 'mi-icon-box mi-icon-box-sm');
    D.icon(ib, s.icon);
    const t = D.div(b, 'mi-settings-nav-text');
    D.div(t, 'mi-settings-nav-title', s.label);
    D.div(t, 'mi-settings-nav-hint', HINTS[s.id] || '');
    b.addEventListener('click', () => {
      view.ui.settingsSection = s.id;
      view.render();
    });
  }

  const body = D.div(layout, 'mi-card mi-settings-body');
  const title = D.div(body, 'mi-settings-body-head');
  const ib = D.div(title, 'mi-icon-box');
  D.icon(ib, SECTIONS.find((s) => s.id === section).icon);
  const tt = D.div(title, '');
  D.el(tt, 'h3', 'mi-h3', SECTIONS.find((s) => s.id === section).label);
  D.el(tt, 'p', 'mi-sub', HINTS[section] || '');
  const content = D.div(body, 'mi-settings-content');
  renderSettings(content, { app: view.app, core: view.core, section, redraw: () => view.render() });
}

module.exports = { renderSettingsTab };
