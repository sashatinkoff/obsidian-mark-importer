'use strict';

/** Создание заметок в хранилище из сессии импорта. */

const { Notice, TFile } = require('obsidian');
const U = require('./util');

async function saveOriginalFile(plugin, session, notePath) {
  if (!session.rawBuffer) return null;
  const app = plugin.app;
  const folder = session.assets.attachmentFolder(app, notePath, 'image');
  await U.ensureFolder(app, folder);
  const name = (session.fileName || `${U.slugify(session.title)}.pdf`).replace(/\.pdf$/i, '');
  const path = U.availablePath(app, folder, U.sanitizeFileName(name), 'pdf');
  return app.vault.createBinary(path, session.rawBuffer);
}

/**
 * @param {object} plugin  PluginCore
 * @param {ImportSession} session
 * @param {{folder:string, title:string, onProgress?:Function}} opts
 * @returns {Promise<TFile[]>}
 */
async function createNotes(plugin, session, { folder, title, onProgress } = {}) {
  const app = plugin.app;
  const s = plugin.settings;
  folder = (folder || '').replace(/^\/+|\/+$/g, '');
  title = (title || session.title || 'Без названия').trim();
  session.title = title;
  await U.ensureFolder(app, folder);

  const groups =
    session.options.split && session.hasGroups && session.rawOverride === null
      ? Object.keys(session.groupMeta).filter((g) => session.activeBlocks(g).length)
      : [undefined];

  const created = [];
  let failedAssets = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const gm = group !== undefined ? session.groupMeta[group] : null;
    const noteTitle = gm && gm.title ? gm.title : title;
    const base = U.sanitizeFileName(
      U.applyTemplate(s.fileNameTemplate || '{{title}}', {
        title: noteTitle,
        date: U.dateKey(gm && gm.published ? new Date(gm.published) : new Date()),
        source: session.label,
        site: session.meta.site || '',
      })
    );
    const path = U.availablePath(app, folder, base, 'md');

    const extraFm = {};
    if (session.kind === 'pdf' && session.options.saveOriginalPdf && gi === 0) {
      try {
        const pdf = await saveOriginalFile(plugin, session, path);
        if (pdf) extraFm.file = `[[${pdf.name}]]`;
      } catch (e) {
        console.warn('MarkImporter: не удалось сохранить исходный PDF', e);
      }
    }

    const { md, stats } = session.compose({ group, extraFm });
    session.assets.downloadOverride = session.options.downloadImages;
    if (onProgress) onProgress(`Сохраняю вложения ${gi + 1}/${groups.length}…`);
    const res = await session.assets.materialize(app, md, path, noteTitle, (n, total) => {
      if (onProgress) onProgress(`Вложения: ${n}/${total}`);
    });
    failedAssets += res.failed;
    const file = await app.vault.create(path, res.md);
    created.push(file);

    await plugin.journal.add({
      title: noteTitle,
      path: file.path,
      type: session.kind,
      source: (gm && gm.source) || session.sourceRef || session.meta.source || session.fileName || '',
      size: session.size,
      pages: session.kind === 'pdf' ? session.pages : 0,
      words: stats.words,
      blocks: stats.blocks,
      blockTypes: stats.blockTypes,
      images: res.saved.length,
      tags: session.tags(),
      excluded: session.disabled.size,
      status: session.rawOverride !== null ? 'edited' : session.disabled.size ? 'partial' : 'ok',
      mode: session.options.mode,
    });
  }

  if (failedAssets) new Notice(`MarkImporter: ${failedAssets} вложений не скачались — оставлены внешние ссылки`);
  if (s.openAfterCreate && created[0] instanceof TFile) {
    await app.workspace.getLeaf('tab').openFile(created[0]);
  }
  return created;
}

module.exports = { createNotes };
