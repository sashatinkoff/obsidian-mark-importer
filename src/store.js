'use strict';

/** Журнал импортов и агрегаты для вкладки «Статистика». */

const U = require('./util');

const MAX_ENTRIES = 5000;

class Journal {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get entries() {
    if (!Array.isArray(this.plugin.data.journal)) this.plugin.data.journal = [];
    return this.plugin.data.journal;
  }

  async add(entry) {
    const full = Object.assign({ id: U.uid(), date: new Date().toISOString(), status: 'ok' }, entry);
    this.entries.unshift(full);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    await this.plugin.persist();
    return full;
  }

  async remove(id) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i >= 0) {
      this.entries.splice(i, 1);
      await this.plugin.persist();
    }
  }

  async clear() {
    this.plugin.data.journal = [];
    await this.plugin.persist();
  }

  /** Обновляет пути после переименования заметок. */
  async renamePath(oldPath, newPath) {
    let changed = false;
    for (const e of this.entries) {
      if (e.path === oldPath) {
        e.path = newPath;
        changed = true;
      }
    }
    if (changed) await this.plugin.persist();
  }

  aggregate(rangeDays) {
    const all = this.entries;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 864e5);

    const total = all.length;
    const lastWeek = all.filter((e) => new Date(e.date) >= weekAgo).length;
    const words = all.reduce((s, e) => s + (e.words || 0), 0);
    const pdfPages = all.reduce((s, e) => s + (e.type === 'pdf' ? e.pages || 0 : 0), 0);
    const avgWords = total ? Math.round(words / total) : 0;
    const blocks = all.reduce((s, e) => s + (e.blocks || 0), 0);

    // Оценка сэкономленного времени: ручной перенос ≈ 40 слов/мин + 20 с на блок разметки
    const minutes = words / 40 + (blocks * 20) / 60;
    const hours = minutes / 60;

    const byType = {};
    for (const e of all) byType[e.type] = (byType[e.type] || 0) + 1;

    const blockTypes = {};
    for (const e of all) {
      for (const [k, v] of Object.entries(e.blockTypes || {})) blockTypes[k] = (blockTypes[k] || 0) + v;
    }

    const tags = {};
    for (const e of all) for (const t of e.tags || []) tags[t] = (tags[t] || 0) + 1;

    // Ряд по дням
    let days = rangeDays;
    if (!days) {
      const oldest = all.length ? new Date(all[all.length - 1].date) : now;
      days = Math.max(7, Math.min(365, Math.ceil((now - oldest) / 864e5) + 1));
    }
    const series = [];
    const index = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = U.dateKey(d);
      const point = { key, date: d, notes: 0, blocks: 0 };
      index.set(key, point);
      series.push(point);
    }
    for (const e of all) {
      const p = index.get(U.dateKey(new Date(e.date)));
      if (p) {
        p.notes++;
        p.blocks += e.blocks || 0;
      }
    }

    return { total, lastWeek, words, pdfPages, avgWords, blocks, hours, byType, blockTypes, tags, series };
  }

  toCsv() {
    const head = ['date', 'title', 'type', 'source', 'path', 'words', 'blocks', 'pages', 'size', 'tags', 'status'];
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = this.entries.map((e) =>
      [e.date, e.title, e.type, e.source, e.path, e.words, e.blocks, e.pages, e.size, (e.tags || []).join(' '), e.status]
        .map(esc)
        .join(',')
    );
    return [head.join(','), ...rows].join('\n');
  }
}

module.exports = { Journal };
