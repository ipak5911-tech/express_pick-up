#!/usr/bin/env node
'use strict';
/**
 * Печать документа проекта в PDF.
 *
 * Внешних конвертеров в системе нет, поэтому разметка переводится в HTML
 * здесь же, а PDF печатает Chrome. Поддерживается то подмножество Markdown,
 * которым написаны документы проекта, — делать универсальный конвертер ради
 * двух файлов незачем.
 *
 *   node scripts/md-to-pdf.js docs/ЗАЩИТА.md
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Формулы заменяются читаемой записью: движка вёрстки формул здесь нет. */
const MATH = {
  'C = R \\times T \\times S': 'C = R × T × S',
  'G=\\frac{Q_{\\text{пилот}}-Q_{\\text{база}}}{Q_{\\text{база}}}\\times100\\%':
    'G = (Q_пилот − Q_база) ÷ Q_база × 100 %'
};

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
  out = out.replace(/\$([^$]+)\$/g, (m, tex) => `<span class="math">${MATH[tex] || tex}</span>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function convert(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;

  const closeList = state => { if (state.list) { html.push(`</${state.list}>`); state.list = null; } };
  const state = { list: null };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList(state);
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }

    if (/^\$\$/.test(line.trim())) {
      closeList(state);
      const body = [];
      i++;
      while (i < lines.length && !/^\$\$/.test(lines[i].trim())) body.push(lines[i++]);
      i++;
      const tex = body.join(' ').trim();
      html.push(`<div class="formula">${escapeHtml(MATH[tex] || tex)}</div>`);
      continue;
    }

    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      closeList(state);
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList(state);
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) { closeList(state); html.push('<hr>'); i++; continue; }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList(state);
      const body = [quote[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${inline(body.join(' ').trim())}</blockquote>`);
      continue;
    }

    /**
     * Продолжение пункта списка — строки с отступом до следующего пункта или
     * пустой строки. Без этого многострочный пункт рвался на абзацы, а
     * нумерация начиналась заново с единицы.
     */
    const takeContinuation = () => {
      const extra = [];
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
             !/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        extra.push(lines[i++].trim());
      }
      return extra.length ? ' ' + extra.join(' ') : '';
    };

    const task = line.match(/^- \[([ x])\]\s+(.*)$/);
    if (task) {
      if (state.list !== 'ul') { closeList(state); html.push('<ul class="tasks">'); state.list = 'ul'; }
      i++;
      html.push(`<li><span class="box">${task[1] === 'x' ? '✓' : ''}</span>${inline(task[2] + takeContinuation())}</li>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (state.list !== 'ul') { closeList(state); html.push('<ul>'); state.list = 'ul'; }
      i++;
      html.push(`<li>${inline(bullet[1] + takeContinuation())}</li>`);
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      if (state.list !== 'ol') { closeList(state); html.push('<ol>'); state.list = 'ol'; }
      i++;
      html.push(`<li>${inline(numbered[1] + takeContinuation())}</li>`);
      continue;
    }

    if (!line.trim()) { closeList(state); i++; continue; }

    // Абзац: собираем до пустой строки, чтобы переносы внутри не рвали текст
    closeList(state);
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^([#>`|-]|\d+\.)/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  closeList(state);
  return html.join('\n');
}

const STYLE = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Arial, sans-serif; color: #16191d; margin: 0; }
h1 { font-size: 21pt; letter-spacing: -.02em; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-top: 6pt; border-top: 1px solid #e2e5ea; page-break-after: avoid; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; page-break-after: avoid; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
li { margin-bottom: 3pt; }
ul.tasks { list-style: none; padding-left: 0; }
ul.tasks .box { display: inline-block; width: 11pt; height: 11pt; border: 1px solid #8b95a3;
  border-radius: 2pt; margin-right: 7pt; vertical-align: -1pt; text-align: center; font-size: 8pt; line-height: 10pt; }
code { font: 9.5pt ui-monospace, Menlo, monospace; background: #f0f2f5; padding: 1pt 3pt; border-radius: 3pt; }
pre { font: 9pt/1.45 ui-monospace, Menlo, monospace; background: #f5f6f8; border: 1px solid #e2e5ea;
  border-radius: 4pt; padding: 8pt 10pt; margin: 0 0 9pt; white-space: pre-wrap; page-break-inside: avoid; }
blockquote { margin: 0 0 9pt; padding: 7pt 11pt; background: #fff1e8; border-left: 3pt solid #e8590c;
  border-radius: 0 4pt 4pt 0; font-weight: 600; page-break-inside: avoid; }
table { width: 100%; border-collapse: collapse; margin: 0 0 10pt; font-size: 9.5pt; page-break-inside: avoid; }
th { text-align: left; background: #f0f2f5; border-bottom: 1.5pt solid #cbd1da; padding: 4pt 6pt; }
td { border-bottom: 1px solid #e2e5ea; padding: 4pt 6pt; vertical-align: top; }
hr { border: 0; border-top: 1px solid #e2e5ea; margin: 14pt 0; }
a { color: #b8460a; text-decoration: none; }
.formula { font: 12pt ui-monospace, Menlo, monospace; text-align: center; background: #f5f6f8;
  border: 1px solid #e2e5ea; border-radius: 4pt; padding: 10pt; margin: 0 0 10pt; }
.math { font-family: ui-monospace, Menlo, monospace; }
`;

const source = process.argv[2];
if (!source) {
  console.error('Укажите файл: node scripts/md-to-pdf.js docs/ЗАЩИТА.md');
  process.exit(1);
}

const md = fs.readFileSync(source, 'utf8');
const title = path.basename(source, '.md');
const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${convert(md)}</body></html>`;

const tmp = path.join(os.tmpdir(), `epu-print-${process.pid}.html`);
fs.writeFileSync(tmp, page);

const out = source.replace(/\.md$/, '.pdf');
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--no-pdf-header-footer', '--print-to-pdf-no-header',
  `--print-to-pdf=${path.resolve(out)}`,
  'file://' + tmp
], { stdio: 'ignore' });

const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
child.on('exit', () => {
  clearTimeout(killer);
  try { fs.unlinkSync(tmp); } catch (e) { /* уже удалён */ }
  if (fs.existsSync(out)) {
    console.log(`Готово: ${out} (${Math.round(fs.statSync(out).size / 1024)} КБ)`);
  } else {
    console.error('Chrome не создал файл PDF');
    process.exit(1);
  }
});
