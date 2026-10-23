'use strict';

/** Редактор раздела «Атрибуты»: свои названия свойств, порядок, свои атрибуты, предпросмотр YAML. */

const { AbstractInputSuggest, setIcon } = require('obsidian');
const D = require('./dom');
const U = require('../util');
const A = require('../attributes');
const { SOURCE_LABELS } = require('../constants');

class PropertySuggest extends AbstractInputSuggest {
  constructor(app, inputEl, names, onPick) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.names = names;
    this.onPick = onPick;
  }
  getSuggestions(q) {
    const query = q.toLowerCase();
    return this.names.filter((n) => n.toLowerCase().includes(query)).slice(0, 40);
  }
  renderSuggestion(name, el) {
    el.setText(name);
  }
  selectSuggestion(name) {
    this.setValue(name);
    this.inputEl.value = name;
    if (this.onPick) this.onPick(name);
    this.close();
  }
}

const SAMPLE = {
  title: 'Как устроен трансформер',
  originalTitle: 'Как устроен трансформер — Хабр',
  source: 'https://habr.com/ru/articles/123456/',
  author: 'Иван Петров',
  published: '2025-05-18T10:14:00',
  site: 'Хабр',
  description: 'Разбираем архитектуру трансформера по шагам',
  kind: 'web',
  pages: 0,
  words: 1420,
  file: '',
};

function renderAttributesEditor(root, ctx) {
  const { app, core } = ctx;
  const s = core.settings;
  A.normalizeAttributes(s);
  const save = U.debounce(() => core.persist(), 300);
  const names = A.vaultPropertyNames(app);
  let lastValueInput = null;

  const draw = () => {
    root.empty();
    root.addClass('mi-attrs');

    // ── общие ──
    const top = D.div(root, 'mi-attrs-top');
    D.checkbox(top, {
      label: 'Генерировать YAML-frontmatter (свойства заметки)',
      checked: s.frontmatter,
      onChange: (v) => {
        s.frontmatter = v;
        save();
        updatePreview();
      },
    });
    const df = D.div(top, 'mi-attrs-date');
    D.el(df, 'span', 'mi-label', 'Формат даты');
    df.title = 'Токены: D DD — день, MMMM — мая, MMM — мая (кратко), MM M — номер месяца, YYYY YY — год, dddd ddd — день недели, HH H — часы, mm — минуты, ss — секунды, [текст] — как есть';
    const dfInput = df.createEl('input', { type: 'text', cls: 'mi-attr-input mi-mono' });
    dfInput.value = s.dateFormat;
    dfInput.placeholder = A.DEFAULT_DATE_FORMAT;
    const dfSample = D.el(df, 'span', 'mi-attrs-sample', A.formatDate(new Date(), s.dateFormat));
    dfInput.addEventListener('input', () => {
      s.dateFormat = dfInput.value.trim() || A.DEFAULT_DATE_FORMAT;
      s.dateFormatTouched = true;
      dfSample.setText(A.formatDate(new Date(), s.dateFormat));
      save();
      updatePreview();
    });
    const presets = D.div(df, 'mi-attrs-presets');
    const ex = new Date(2026, 4, 6, 12, 30);
    for (const f of ['D MMMM YYYY, HH:mm', 'D MMMM YYYY', 'DD.MM.YYYY HH:mm', 'DD.MM.YYYY', 'dddd, D MMMM YYYY', 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm:ss']) {
      const b = presets.createEl('button', { cls: 'mi-mini-chip' + (s.dateFormat === f ? ' is-active' : ''), text: A.formatDate(ex, f) });
      b.title = f;
      b.addEventListener('click', () => {
        dfInput.value = f;
        dfInput.dispatchEvent(new Event('input'));
      });
    }

    // ── таблица атрибутов ──
    const head = D.div(root, 'mi-attr-row mi-attr-head');
    ['', '', 'Атрибут', 'Название в заметке', 'Значение', ''].forEach((t) => D.div(head, 'mi-attr-cell', t));

    const list = D.div(root, 'mi-attr-list');
    const keys = s.attributes.filter((a) => a.enabled).map((a) => (a.key || '').trim());
    s.attributes.forEach((a, idx) => {
      const info = a.builtin ? A.builtinInfo(a.id) : null;
      const row = D.div(list, 'mi-attr-row' + (a.enabled ? '' : ' is-off') + (a.builtin ? '' : ' is-custom'));
      row.draggable = true;

      // порядок
      const ord = D.div(row, 'mi-attr-cell mi-attr-order');
      D.icon(ord, 'grip-vertical', 'mi-icon mi-grip');
      const up = D.button(ord, { icon: 'chevron-up', cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs', title: 'Выше', disabled: idx === 0, onClick: () => move(idx, idx - 1) });
      const down = D.button(ord, {
        icon: 'chevron-down',
        cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs',
        title: 'Ниже',
        disabled: idx === s.attributes.length - 1,
        onClick: () => move(idx, idx + 1),
      });
      void up;
      void down;

      // вкл/выкл
      const tg = D.div(row, 'mi-attr-cell');
      D.checkbox(tg, {
        label: '',
        checked: a.enabled,
        onChange: (v) => {
          a.enabled = v;
          save();
          draw();
        },
      });

      // описание
      const desc = D.div(row, 'mi-attr-cell mi-attr-desc');
      D.div(desc, 'mi-attr-label', info ? info.label : 'Свой атрибут');
      D.div(desc, 'mi-attr-hint', info ? info.hint : 'Значение по шаблону');

      // имя ключа
      const keyCell = D.div(row, 'mi-attr-cell');
      const keyInput = keyCell.createEl('input', { type: 'text', cls: 'mi-attr-input mi-mono' });
      keyInput.value = a.key || '';
      keyInput.placeholder = info ? info.key : 'project';
      const dup = a.enabled && a.key && keys.filter((k) => k === a.key.trim()).length > 1;
      const bad = a.key && /[:#[\]{}]|^\s|\s$/.test(a.key);
      if (dup || bad || (a.enabled && !String(a.key || '').trim())) keyInput.addClass('is-invalid');
      keyInput.title = dup ? 'Такое имя уже используется — значения будут перезаписаны' : bad ? 'Недопустимые символы: : # [ ] { }' : '';
      keyInput.addEventListener('input', () => {
        a.key = keyInput.value;
        save();
        updatePreview();
      });
      keyInput.addEventListener('change', () => draw());
      new PropertySuggest(app, keyInput, names, (v) => {
        a.key = v;
        save();
        draw();
      });

      // значение
      const valCell = D.div(row, 'mi-attr-cell mi-attr-value');
      if (a.builtin) {
        const sample = sampleValue(a.id);
        D.el(valCell, 'span', 'mi-attr-sample', sample === '' ? '—' : sample);
        if (info && a.key !== info.key) {
          D.button(valCell, {
            icon: 'rotate-ccw',
            cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs',
            title: `Вернуть «${info.key}»`,
            onClick: () => {
              a.key = info.key;
              save();
              draw();
            },
          });
        }
      } else {
        const vInput = valCell.createEl('input', { type: 'text', cls: 'mi-attr-input mi-mono' });
        vInput.value = a.value || '';
        vInput.placeholder = '{{site}} или статичный текст';
        vInput.addEventListener('focus', () => (lastValueInput = { input: vInput, attr: a }));
        vInput.addEventListener('input', () => {
          a.value = vInput.value;
          save();
          updatePreview();
        });
        const lc = valCell.createEl('label', { cls: 'mi-attr-list-toggle' });
        const lcb = lc.createEl('input', { type: 'checkbox' });
        lcb.checked = !!a.list;
        lc.appendText('список');
        lc.title = 'Значения через запятую станут списком YAML';
        lcb.addEventListener('change', () => {
          a.list = lcb.checked;
          save();
          updatePreview();
        });
      }

      // удалить
      const del = D.div(row, 'mi-attr-cell');
      if (!a.builtin) {
        D.button(del, {
          icon: 'trash-2',
          cls: 'mi-btn-ghost mi-btn-icon mi-btn-xs',
          title: 'Удалить атрибут',
          onClick: () => {
            s.attributes.splice(idx, 1);
            save();
            draw();
          },
        });
      }

      // drag & drop
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(idx));
        row.addClass('is-dragging');
      });
      row.addEventListener('dragend', () => row.removeClass('is-dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.addClass('drop-before');
      });
      row.addEventListener('dragleave', () => row.removeClass('drop-before'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.removeClass('drop-before');
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(from) && from !== idx) move(from, idx);
      });
    });

    // ── действия ──
    const actions = D.div(root, 'mi-attrs-actions');
    D.button(actions, {
      icon: 'plus',
      text: 'Добавить свой атрибут',
      cls: 'mi-btn-outline',
      onClick: () => {
        s.attributes.push({ id: `c_${U.uid()}`, key: '', value: '', enabled: true, builtin: false, list: false });
        save();
        draw();
        const inputs = root.querySelectorAll('.mi-attr-row.is-custom .mi-attr-input');
        if (inputs.length) inputs[inputs.length - 2].focus();
      },
    });
    D.button(actions, {
      icon: 'rotate-ccw',
      text: 'Сбросить к стандартным',
      cls: 'mi-btn-ghost',
      onClick: () => {
        s.attributes = A.defaultAttributes({});
        save();
        draw();
      },
    });

    const vars = D.div(root, 'mi-attrs-vars');
    D.el(vars, 'span', 'mi-label', 'Переменные для своих атрибутов:');
    for (const v of A.VARS) {
      const b = vars.createEl('button', { cls: 'mi-mini-chip mi-mono', text: `{{${v}}}` });
      b.title = 'Вставить в последнее поле значения';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (!lastValueInput || !lastValueInput.input.isConnected) return;
        const inp = lastValueInput.input;
        const pos = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
        inp.value = inp.value.slice(0, pos) + `{{${v}}}` + inp.value.slice(pos);
        inp.dispatchEvent(new Event('input'));
        inp.focus();
      });
    }

    // ── теги ──
    const tagsBox = D.div(root, 'mi-attrs-group');
    D.div(tagsBox, 'mi-attrs-group-title', 'Теги');
    const tagRow = D.div(tagsBox, 'mi-attrs-inline');
    D.el(tagRow, 'span', 'mi-attr-label', 'Теги по умолчанию');
    const tagInput = tagRow.createEl('input', { type: 'text', cls: 'mi-attr-input mi-mono' });
    tagInput.value = s.defaultTags;
    tagInput.placeholder = 'import, inbox';
    tagInput.addEventListener('input', () => {
      s.defaultTags = tagInput.value;
      save();
      updatePreview();
    });
    D.checkbox(tagsBox, {
      label: 'Добавлять тег источника: source/pdf, source/web, source/telegram…',
      checked: s.addSourceTag,
      onChange: (v) => {
        s.addSourceTag = v;
        save();
        updatePreview();
      },
    });

    // ── названия типов ──
    const typesBox = D.div(root, 'mi-attrs-group');
    D.div(typesBox, 'mi-attrs-group-title', 'Значения атрибута «Тип источника»');
    const grid = D.div(typesBox, 'mi-attrs-types');
    for (const kind of Object.keys(A.DEFAULT_TYPE_NAMES)) {
      const cell = D.div(grid, 'mi-attrs-type');
      D.el(cell, 'span', 'mi-label', SOURCE_LABELS[kind] || kind);
      const inp = cell.createEl('input', { type: 'text', cls: 'mi-attr-input' });
      inp.value = s.typeNames[kind] || '';
      inp.placeholder = A.DEFAULT_TYPE_NAMES[kind];
      inp.addEventListener('input', () => {
        s.typeNames[kind] = inp.value.trim() || A.DEFAULT_TYPE_NAMES[kind];
        save();
        updatePreview();
      });
    }

    // ── предпросмотр ──
    const pv = D.div(root, 'mi-attrs-preview');
    const pvHead = D.div(pv, 'mi-fm-head');
    pvHead.createSpan({ cls: 'mi-dot' });
    D.el(pvHead, 'span', 'mi-label mi-accent', 'ПРЕДПРОСМОТР FRONTMATTER (пример статьи)');
    previewEl = pv.createEl('pre', { cls: 'mi-attrs-yaml' });
    updatePreview();
  };

  let previewEl = null;

  const sampleValue = (id) => {
    const fm = A.buildAttributes(
      Object.assign({}, s, { attributes: [{ id, key: '__v', enabled: true, builtin: true }] }),
      Object.assign({}, SAMPLE, { tags: tagsSample() })
    );
    const v = fm.__v;
    if (v === undefined) return '';
    return Array.isArray(v) ? v.join(', ') : String(v);
  };

  const tagsSample = () => {
    const tags = String(s.defaultTags || '')
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, ''))
      .filter(Boolean);
    if (s.addSourceTag) tags.push('source/web');
    return tags;
  };

  function updatePreview() {
    if (!previewEl) return;
    if (!s.frontmatter) {
      previewEl.setText('Frontmatter выключен');
      return;
    }
    const fm = A.buildAttributes(s, Object.assign({}, SAMPLE, { tags: tagsSample() }));
    previewEl.setText(U.buildFrontmatter(fm) || '---\n---');
  }

  const move = (from, to) => {
    if (to < 0 || to >= s.attributes.length) return;
    const [x] = s.attributes.splice(from, 1);
    s.attributes.splice(to, 0, x);
    save();
    draw();
  };

  draw();
  void setIcon;
}

module.exports = { renderAttributesEditor };
