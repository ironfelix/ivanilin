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
