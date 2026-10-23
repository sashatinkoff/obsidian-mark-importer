'use strict';

/** TXT / Markdown → блоки. */

const U = require('../util');
const { escText, escapeLineStarts } = require('./html2md');

function classifyMd(md) {
  const t = md.trimStart();
  if (/^#{1,6}\s/.test(t)) return { type: 'heading', level: /^#+/.exec(t)[0].length };
  if (/^(```|~~~)/.test(t)) return { type: 'code' };
  if (/^\$\$/.test(t)) return { type: 'math' };
  if (/^>/.test(t)) return { type: 'quote' };
  if (/^\|.*\|/.test(t)) return { type: 'table' };
  if (/^([-*+]|\d+[.)])\s/.test(t)) return { type: 'list' };
  if (/^(!\[\[|!\[)/.test(t) && !/\n\S/.test(t.replace(/^!\[[^\n]*\n?/, ''))) return { type: 'image' };
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) return { type: 'hr' };
  if (/^</.test(t)) return { type: 'html' };
  return { type: 'paragraph' };
}

function markdownToBlocks(md) {
  const text = String(md).replace(/\r\n?/g, '\n');
  let body = text;
  let frontmatter = '';
  const fm = /^---\n[\s\S]*?\n---\n/.exec(body);
  if (fm) {
    frontmatter = fm[0];
    body = body.slice(fm[0].length);
  }
  const blocks = [];
  const lines = body.split('\n');
  let buf = [];
  let fence = null;
  let mathFence = false;
  const flush = () => {
    const chunk = buf.join('\n').replace(/^\n+|\n+$/g, '');
    buf = [];
    if (!chunk.trim()) return;
    const c = classifyMd(chunk);
    blocks.push(Object.assign({ md: chunk, text: U.stripMarkdown(chunk).slice(0, 300) }, c));
  };
  for (const line of lines) {
    if (fence) {
      buf.push(line);
      if (line.trimStart().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (mathFence) {
      buf.push(line);
      if (line.trim().endsWith('$$')) {
        mathFence = false;
        flush();
      }
      continue;
    }
    const fm2 = /^\s*(```+|~~~+)/.exec(line);
    if (fm2) {
      flush();
      fence = fm2[1];
      buf.push(line);
      continue;
    }
    if (line.trim() === '$$' || (line.trim().startsWith('$$') && !line.trim().slice(2).includes('$$'))) {
      flush();
      mathFence = true;
      buf.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      buf.push(line);
      flush();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return { blocks, frontmatter };
}

const LIST_LINE = /^\s*([•◦▪●○■□►–—*-]|\d{1,3}[.)])\s+/;

function textToBlocks(text, { keepLineBreaks = true } = {}) {
  const clean = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const paras = clean.split(/\n\s*\n+/);
  const blocks = [];
  for (const p of paras) {
    const lines = p.split('\n').map((l) => l.replace(/\s+$/, ''));
    if (!lines.some((l) => l.trim())) continue;
    if (lines.every((l) => !l.trim() || LIST_LINE.test(l))) {
      const md = lines
        .filter((l) => l.trim())
        .map((l) => {
          const m = LIST_LINE.exec(l);
          const indent = '\t'.repeat(Math.min(3, Math.floor((/^\s*/.exec(l)[0].length || 0) / 2)));
          const marker = /\d/.test(m[1]) ? `${m[1].replace(/\D/g, '')}.` : '-';
          return `${indent}${marker} ${escText(l.slice(m[0].length))}`;
        })
        .join('\n');
      blocks.push({ type: 'list', md, text: p.slice(0, 200) });
      continue;
    }
    // моноширинные блоки (выравнивание пробелами) — как код
    if (lines.length > 1 && lines.filter((l) => /\S {3,}\S/.test(l) || /^ {4,}\S/.test(l)).length >= Math.ceil(lines.length * 0.6)) {
      blocks.push({ type: 'code', md: '```\n' + lines.join('\n') + '\n```', text: p.slice(0, 200) });
      continue;
    }
    const joiner = keepLineBreaks ? '  \n' : ' ';
    const md = escapeLineStarts(lines.map((l) => escText(l.trim())).filter(Boolean).join(joiner));
    blocks.push({ type: 'paragraph', md, text: lines.join(' ').trim().slice(0, 300) });
  }
  return blocks;
}

function looksLikeMarkdown(text) {
  const t = String(text);
  let score = 0;
  if (/^#{1,6}\s/m.test(t)) score += 2;
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) score += 2;
  if (/^```/m.test(t)) score += 2;
  if (/\*\*[^*]+\*\*/.test(t)) score += 1;
  if (/^\s*[-*]\s+\S/m.test(t)) score += 1;
  if (/^>\s/m.test(t)) score += 1;
  if (/\[\[[^\]]+\]\]/.test(t)) score += 2;
  return score >= 3;
}

module.exports = { markdownToBlocks, textToBlocks, looksLikeMarkdown, classifyMd };
