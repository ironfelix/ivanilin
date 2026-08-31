/* Совместимость с todo.md: пульт умеет и отдавать список Markdown-ом,
   и вливать чужой файл обратно. Формат обычный, читается глазами
   и понимается любым другим инструментом. */

import { state, CONTEXTS, todayISO } from './store.js';
import { parseQuickAdd } from './parse.js';

const SECTIONS = [
  ['next', 'Next actions'],
  ['inbox', 'Инбокс'],
  ['waiting', 'Ожидание'],
  ['agenda', 'Agenda'],
  ['someday', 'Когда-нибудь'],
  ['done', 'Сделано'],
];

const HEADINGS = {
  'next actions': 'next', 'действия': 'next', 'todo': 'next', 'задачи': 'next',
  'инбокс': 'inbox', 'inbox': 'inbox', 'входящие': 'inbox',
  'ожидание': 'waiting', 'waiting': 'waiting', 'waiting for': 'waiting', 'ждём': 'waiting',
  'agenda': 'agenda', 'повестка': 'agenda',
  'когда-нибудь': 'someday', 'someday': 'someday', 'потом': 'someday',
  'сделано': 'done', 'done': 'done', 'выполнено': 'done',
};

const contextLabel = (id) => CONTEXTS.find((c) => c.id === id)?.label || '';

/** Задача → строка Markdown с тем же синтаксисом, что и строка захвата. */
function taskLine(t) {
  const bits = [t.title];
  if (t.context) bits.push(contextLabel(t.context));
  const project = state.projects.find((p) => p.id === t.projectId);
  if (project) bits.push('#' + project.title.replace(/\s+/g, '_'));
  if (t.person) bits.push((t.list === 'agenda' ? '>' : '?') + t.person.replace(/\s+/g, '_'));
  if (t.due) bits.push('!' + t.due);
  if (t.minutes) bits.push('+' + t.minutes + 'м');
  if (t.topGoal) bits.push('*');
  return `- [${t.list === 'done' ? 'x' : ' '}] ${bits.filter(Boolean).join(' ')}`;
}

export function toMarkdown() {
  const out = [`# Пульт — ${todayISO()}`, ''];

  const goal = state.goals.find((g) => g.isTop);
  if (goal) out.push(`> Главная цель: ${goal.title}`, '');

  for (const [list, title] of SECTIONS) {
    const tasks = state.tasks.filter((t) => t.list === list);
    if (!tasks.length) continue;
    out.push(`## ${title}`, '');
    // задачи проекта держим вместе — так файл читается как план, а не как свалка
    const byProject = new Map();
    for (const t of tasks) {
      const key = t.projectId || '';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(t);
    }
    const ordered = [...byProject].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0));
    for (const [pid, group] of ordered) {
      const project = state.projects.find((p) => p.id === pid);
      if (project) out.push(`### ${project.title}`);
      group.forEach((t) => out.push(taskLine(t)));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Разбирает todo.md. Возвращает список задач в виде патчей — решение
 * о добавлении принимает вызывающий код, чтобы импорт можно было показать
 * человеку до применения.
 */
export function fromMarkdown(text) {
  const tasks = [];
  let list = 'inbox';
  let projectName = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2 && !line.startsWith('###')) {
      list = HEADINGS[h2[1].trim().toLowerCase()] || 'inbox';
      projectName = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) { projectName = h3[1].trim(); continue; }
    if (/^#\s/.test(line) || line.startsWith('>')) continue;

    const item = line.match(/^[-*+]\s+(?:\[([ xX])\]\s*)?(.+)$/);
    if (!item) continue;

    const checked = (item[1] || '').toLowerCase() === 'x';
    const parsed = parseQuickAdd(item[2]);
    if (!parsed.title) continue;

    tasks.push({
      ...parsed,
      projectName: parsed.projectName || projectName,
      list: checked ? 'done' : (parsed.list === 'inbox' ? list : parsed.list),
      done: checked,
    });
  }
  return tasks;
}

/** Одинаковой считаем задачу с тем же текстом — этого хватает, чтобы
    повторный импорт того же файла не плодил дубли. */
export const sameTask = (a, title) =>
  a.title.trim().toLowerCase() === title.trim().toLowerCase();

/* ---------- показ конспекта ---------- */

/**
 * Маленький рендерер Markdown для чтения конспектов. Своя реализация, а не
 * библиотека: страница грузится без сборки, тянуть внешний скрипт ради
 * заголовков и списков незачем.
 *
 * Экранируем ДО разбора разметки — иначе `<script>` из чужого файла попал бы
 * в документ как тег. Всё, что рендерер потом вставляет, — его собственные теги.
 */
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // ссылки: только http(s) и внутренние — javascript: в href не пропускаем
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(text) {
  const out = [];
  let list = null;      // 'ul' | 'ol'
  let code = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of escHtml(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line.trim())) {
      closeList();
      out.push(code ? '</pre>' : '<pre>');
      code = !code;
      continue;
    }
    if (code) { out.push(line); continue; }

    if (!line.trim()) { closeList(); continue; }

    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      closeList();
      const lvl = Math.min(6, h[1].length + 1);   // # в файле — это h2 на странице
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (/^&gt;\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
      continue;
    }

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      if (list !== 'ul') { closeList(); out.push('<ul class="md-tasks">'); list = 'ul'; }
      const done = task[1].toLowerCase() === 'x';
      out.push(`<li class="${done ? 'is-done' : ''}"><span class="md-box">${done ? '✓' : ''}</span>${inline(task[2])}</li>`);
      continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.+)$/);
    if (li) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    const oli = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (oli) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(oli[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) out.push('</pre>');
  return out.join('\n');
}
