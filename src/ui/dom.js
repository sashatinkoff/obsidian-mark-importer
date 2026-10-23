'use strict';

/** Небольшие DOM-помощники для интерфейса. */

const { setIcon } = require('obsidian');

function el(parent, tag, cls, text) {
  const e = parent.createEl(tag, cls ? { cls } : {});
  if (text !== undefined && text !== null) e.setText(String(text));
  return e;
}

function div(parent, cls, text) {
  return el(parent, 'div', cls, text);
}

function icon(parent, name, cls = 'mi-icon') {
  const s = parent.createSpan({ cls });
  setIcon(s, name);
  return s;
}

function button(parent, { text, icon: ic, cls = '', title, onClick, disabled } = {}) {
  const b = parent.createEl('button', { cls: `mi-btn ${cls}`.trim() });
  if (ic) icon(b, ic);
  if (text) b.createSpan({ text });
  if (title) b.setAttr('aria-label', title);
  if (disabled) b.disabled = true;
  if (onClick) b.addEventListener('click', (e) => onClick(e, b));
  return b;
}

function chip(parent, text, cls = '') {
  return el(parent, 'span', `mi-chip ${cls}`.trim(), text);
}

function checkbox(parent, { label, checked, onChange, hint, disabled }) {
  const wrap = parent.createEl('label', { cls: 'mi-check' });
  const input = wrap.createEl('input', { type: 'checkbox' });
  input.checked = !!checked;
  if (disabled) {
    input.disabled = true;
    wrap.addClass('is-disabled');
  }
  const box = wrap.createSpan({ cls: 'mi-check-box' });
  setIcon(box, 'check');
  const text = wrap.createSpan({ cls: 'mi-check-label' });
  if (typeof label === 'function') label(text);
  else text.setText(label);
  if (hint) text.createSpan({ cls: 'mi-check-hint', text: ` ${hint}` });
  input.addEventListener('change', () => onChange && onChange(input.checked));
  return wrap;
}

function segmented(parent, { options, value, onChange, cls = '' }) {
  const wrap = div(parent, `mi-seg ${cls}`.trim());
  for (const o of options) {
    const b = wrap.createEl('button', { cls: 'mi-seg-btn' + (o.value === value ? ' is-active' : '') });
    if (o.icon) icon(b, o.icon);
    const t = b.createSpan({ cls: 'mi-seg-text' });
    t.createSpan({ text: o.label });
    if (o.hint) t.createSpan({ cls: 'mi-seg-hint', text: o.hint });
    if (o.disabled) b.disabled = true;
    b.addEventListener('click', () => onChange(o.value));
  }
  return wrap;
}

module.exports = { el, div, icon, button, chip, checkbox, segmented };
