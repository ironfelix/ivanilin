/* GTD-админка — рендер и поведение. Ванильный ES-модуль, без сборки. */

import {
  state, commit, subscribe, persist,
  CONTEXTS, LISTS, LADDER,
  addTask, updateTask, toggleDone, removeTask,
  addProject, findOrCreateProject, addGoal, addNote,
  byList, projectTasks, stalledProjects, staleWaiting, overdue, dueToday,
  doneSince, openTasks, topGoalToday, topGoalStreak, logTopGoal,
  exportJSON, importJSON,
  agents, mike, readyAgents, addAgent, removeAgent, sendToAgent, mikeFetch,
  sync, onSync, syncNow, syncBoot, markDirty,
  todayISO, daysSince, plural,
} from './store.js';
import { parseQuickAdd, parseNoteLines } from './parse.js';
import { toMarkdown, fromMarkdown, sameTask, renderMarkdown } from './markdown.js';

/* ---------- утилиты ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function fmtDate(iso) {
  if (!iso) return '';
  const d = todayISO();
  if (iso === d) return 'сегодня';
  if (iso === todayISO(new Date(Date.now() + 86400000))) return 'завтра';
  if (iso === todayISO(new Date(Date.now() - 86400000))) return 'вчера';
  const [y, m, day] = iso.split('-');
  const withYear = y !== String(new Date().getFullYear());
  return `${Number(day)} ${MONTHS[Number(m) - 1]}${withYear ? ' ' + y : ''}`;
}

const ctxLabel = (id) => CONTEXTS.find((c) => c.id === id)?.label || '';
const projectTitle = (id) => state.projects.find((p) => p.id === id)?.title || '';
const dayKeys = (n) =>
  Array.from({ length: n }, (_, i) => todayISO(new Date(Date.now() - (n - 1 - i) * 86400000)));

/* ---------- навигация ---------- */

const NAV = [
  { group: 'Ритм', items: [['dashboard', 'Дашборд', '◎'], ['review', 'Ревью', '⟳']] },
  { group: 'Поток', items: [
    ['inbox', 'Инбокс', '⬓'], ['next', 'Next actions', '▸'],
    ['waiting', 'Ожидание', '⏳'], ['agenda', 'Agenda', '☰'], ['someday', 'Когда-нибудь', '∞'],
  ] },
  { group: 'Горизонты', items: [['projects', 'Проекты', '▦'], ['goals', 'Цели', '★']] },
  { group: 'База', items: [
    ['notes', 'Конспекты', '✎'], ['seo', 'SEO-пайплайн', '◈'],
    ['agents', 'Агенты', '⚡'], ['settings', 'Данные', '⚙'],
  ] },
];

const TABS = [
  ['dashboard', 'Дашборд', '◎'], ['inbox', 'Инбокс', '⬓'],
  ['next', 'Действия', '▸'], ['projects', 'Проекты', '▦'], ['more', 'Ещё', '⋯'],
];

const TITLES = {
  dashboard: ['Дашборд', 'Скоркард недели и главная цель'],
  review: ['Ревью', 'Еженедельный обзор системы'],
  inbox: ['Инбокс', 'Захватить всё, потом разобрать до нуля'],
  next: ['Next actions', 'Что делать прямо сейчас — по контекстам'],
  waiting: ['Ожидание', 'Делегировано и ждёт чужого хода'],
  agenda: ['Agenda', 'Вопросы к людям — к следующей встрече'],
  someday: ['Когда-нибудь', 'Идеи вне текущих обязательств'],
  projects: ['Проекты', 'Всё, где больше одного следующего действия'],
  goals: ['Цели', 'Горизонты выше проектов'],
  notes: ['Конспекты', 'Записи звонков и встреч'],
  seo: ['SEO-пайплайн', 'Рабочая таблица по продвижению'],
  agents: ['Агенты', 'Майк и другие исполнители — потоки наружу'],
  settings: ['Данные', 'Хранение, экспорт, оформление'],
  more: ['Ещё', 'Остальные разделы'],
};

const badgeFor = (route) => {
  if (route === 'inbox') return byList('inbox').length;
  if (route === 'next') return dueToday().length;
  if (route === 'projects') return stalledProjects().length;
  if (route === 'review') return reviewDue() ? 1 : 0;
  return 0;
};

const countFor = (route) => ({
  inbox: byList('inbox').length,
  next: byList('next').length,
  waiting: byList('waiting').length,
  agenda: byList('agenda').length,
  someday: byList('someday').length,
  projects: state.projects.filter((p) => p.status === 'active').length,
  goals: state.goals.length,
  notes: state.notes.length,
}[route] ?? null);

const reviewDue = () => (daysSince(state.review.lastAt) ?? 99) >= 7;

/* ---------- состояние интерфейса (не сохраняется) ---------- */

const ui = {
  route: 'dashboard',
  selected: null,       // { kind: 'task'|'project', id }
  openNote: null,
  ctxFilter: 'all',
  timerTick: null,
  editNote: false,      // конспект открыт на правку, а не на чтение
};

/* ---------- каркас ---------- */

function shell() {
  const [title, sub] = TITLES[ui.route] || TITLES.dashboard;
  const nav = NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    ${g.items.map(([r, label, icon]) => {
      const n = countFor(r);
      const alert = badgeFor(r) > 0 && r !== 'next';
      return `<a class="nav-item ${ui.route === r ? 'is-active' : ''}" href="#/${r}">
        <span class="nav-icon">${icon}</span>
        <span class="nav-label">${label}</span>
        ${n ? `<span class="nav-count ${alert ? 'is-alert' : ''}">${n}</span>` : ''}
      </a>`;
    }).join('')}
  `).join('');

  const tabs = TABS.map(([r, label, icon]) => {
    const b = badgeFor(r) || (r === 'more' ? badgeFor('review') : 0);
    return `<a class="tab ${ui.route === r ? 'is-active' : ''}" href="#/${r}">
      <span class="tab-icon">${icon}</span>${label}
      ${b ? `<span class="tab-badge">${b > 9 ? '9+' : b}</span>` : ''}
    </a>`;
  }).join('');

  const showCapture = !['settings', 'agents', 'goals', 'more'].includes(ui.route);

  return `
  <div class="app ${ui.selected ? 'has-detail' : ''}">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">И</div>
        <div><div class="brand-name">Пульт</div><div class="brand-sub">ivanilin.ru/pult</div></div>
      </div>
      ${nav}
      <div class="sidebar-foot">
        <button class="btn btn-sm" data-action="theme">◐ Тема</button>
        <button class="btn btn-sm" data-action="export">↓ JSON</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div><h1>${esc(title)}</h1><div class="topbar-sub">${esc(sub)}</div></div>
        <div class="topbar-spacer"></div>
        ${syncChip()}
        <button class="btn btn-sm desktop-only" data-action="focus-capture">+ Задача <span style="color:var(--faint)">N</span></button>
      </header>
      ${showCapture ? captureBar() : ''}
      <div class="view">${renderView()}</div>
    </main>

    ${ui.selected ? detailPanel() : ''}
  </div>
  ${ui.selected ? '<div class="sheet-backdrop" data-action="close-detail"></div>' : ''}
  <nav class="tabbar">${tabs}</nav>
  <button class="fab" data-action="focus-capture" aria-label="Новая задача">+</button>`;
}

/** Состояние базы одной строкой: человеку важно знать, уехали ли правки. */
function syncChip() {
  const pending = ['tasks', 'projects', 'goals', 'notes']
    .reduce((n, k) => n + sync.dirty[k].size, 0) + (sync.dirty.kv ? 1 : 0);
  const map = {
    off:     ['', 'только этот браузер', 'Данные не синхронизируются: задайте токен Майка в разделе «Агенты»'],
    syncing: ['is-sync', 'синхронизация…', ''],
    ok:      ['is-ok', pending ? `${pending} в очереди` : 'на сервере', 'Данные в базе на сервере'],
    error:   ['is-err', 'нет связи', sync.error],
    idle:    ['', '…', ''],
  };
  const [cls, text, title] = map[sync.status] || map.idle;
  return `<button class="syncchip ${cls}" data-action="sync-now" title="${esc(title)}">
    <span class="dot ${cls === 'is-ok' ? 'is-ok' : cls === 'is-err' ? 'is-err' : ''}"></span>${esc(text)}</button>`;
}

function captureBar() {
  return `
  <div class="capture">
    <div class="capture-box">
      <span style="color:var(--faint)">+</span>
      <input id="capture" type="text" autocomplete="off" enterkeyhint="done"
             placeholder="Что нужно сделать? Enter — в инбокс">
    </div>
    <div class="capture-hint">
      <code>@звонки</code> контекст · <code>#Проект</code> · <code>!завтра</code> срок ·
      <code>?Петя</code> ожидание · <code>&gt;Петя</code> в повестку ·
      <code>~</code> когда-нибудь · <code>+30м</code> · <code>*</code> главная цель
    </div>
  </div>`;
}

/* ---------- строка задачи ---------- */

function taskRow(t) {
  const chips = [];
  if (t.topGoal) chips.push('<span class="chip is-top">★ цель</span>');
  if (t.context) chips.push(`<span class="chip">${esc(ctxLabel(t.context))}</span>`);
  if (t.projectId) chips.push(`<span class="chip">▦ ${esc(projectTitle(t.projectId))}</span>`);
  if (t.person) chips.push(`<span class="chip">${t.list === 'agenda' ? '☰' : '⏳'} ${esc(t.person)}</span>`);
  if (t.due) {
    const cls = t.due < todayISO() ? 'is-overdue' : t.due === todayISO() ? 'is-due' : '';
    chips.push(`<span class="chip ${cls}">◷ ${fmtDate(t.due)}</span>`);
  }
  if (t.minutes) chips.push(`<span class="chip">${t.minutes} мин</span>`);
  if (t.list === 'waiting') {
    const d = daysSince(t.updatedAt) ?? 0;
    if (d >= 7) chips.push(`<span class="chip is-stale">висит ${d} ${plural(d, 'день', 'дня', 'дней')}</span>`);
  }

  return `
  <div class="row ${t.list === 'done' ? 'is-done' : ''} ${ui.selected?.id === t.id ? 'is-selected' : ''}"
       data-task="${t.id}">
    <button class="check" data-action="toggle" data-id="${t.id}" aria-label="Готово">✓</button>
    <div class="row-body">
      <div class="row-title">${esc(t.title)}</div>
      ${chips.length ? `<div class="row-meta">${chips.join('')}</div>` : ''}
    </div>
  </div>`;
}

const taskList = (tasks, emptyText, emoji = '○') =>
  tasks.length
    ? `<div class="rows">${tasks.map(taskRow).join('')}</div>`
    : `<div class="empty"><span class="empty-emoji">${emoji}</span><p>${esc(emptyText)}</p></div>`;

/* ---------- дашборд ---------- */

function viewDashboard() {
  const inbox = byList('inbox').length;
  const stalled = stalledProjects().length;
  const stale = staleWaiting().length;
  const od = overdue().length;
  const closed7 = doneSince(7).length;
  const sinceReview = daysSince(state.review.lastAt);

  const tile = (label, value, note, cls = '', route = '') => `
    <a class="tile ${cls}" href="#/${route}">
      <div class="tile-label">${label}</div>
      <div class="tile-value">${value}</div>
      <div class="tile-note">${note}</div>
    </a>`;

  const alerts = [];
  if (inbox > 0) alerts.push(`инбокс не разобран (${inbox})`);
  if (stalled > 0) alerts.push(`${stalled} ${plural(stalled, 'проект', 'проекта', 'проектов')} без следующего действия`);
  if (stale > 0) alerts.push(`${stale} в ожидании больше недели`);
  if (reviewDue()) alerts.push('пора провести недельное ревью');

  return `
  ${topGoalBlock()}

  <div class="tiles">
    ${tile('Инбокс', inbox, inbox ? 'разобрать до нуля' : 'чисто', inbox ? 'is-alert' : 'is-ok', 'inbox')}
    ${tile('Next actions', byList('next').length, `${dueToday().length} на сегодня`, '', 'next')}
    ${tile('Ожидание', byList('waiting').length, stale ? `${stale} висит >7 дней` : 'всё свежее', stale ? 'is-alert' : '', 'waiting')}
    ${tile('Проекты', state.projects.filter((p) => p.status === 'active').length,
      stalled ? `${stalled} без next action` : 'у всех есть ход', stalled ? 'is-alert' : 'is-ok', 'projects')}
    ${tile('Просрочено', od, od ? 'разберитесь сегодня' : 'сроки в порядке', od ? 'is-alert' : 'is-ok', 'next')}
    ${tile('Закрыто за 7 дней', closed7, 'выполненных действий', '', 'dashboard')}
    ${tile('Ревью', sinceReview === null ? '—' : sinceReview,
      sinceReview === null ? 'ещё ни разу' : `${plural(sinceReview, 'день', 'дня', 'дней')} назад`,
      reviewDue() ? 'is-alert' : 'is-ok', 'review')}
    ${tile('Agenda', byList('agenda').length, 'вопросов к людям', '', 'agenda')}
  </div>

  ${alerts.length ? `
    <div class="card is-alert" style="margin-bottom:22px">
      <h3>Система просит внимания</h3>
      <p>${alerts.map(esc).join(' · ')}</p>
      <div class="card-foot"><a class="btn btn-sm" href="#/review">Открыть ревью →</a></div>
    </div>` : ''}

  <div class="section-head"><h2>Сегодня и просрочено</h2>
    <span class="count">${dueToday().length}</span><span class="spacer"></span>
    <a class="btn btn-sm btn-ghost" href="#/next">Все действия →</a>
  </div>
  ${taskList(dueToday().sort((a, b) => (a.due < b.due ? -1 : 1)), 'На сегодня ничего не назначено — берите из Next actions.', '☀')}

  <div class="section-head"><h2>Двигают главную цель</h2>
    <span class="count">${openTasks().filter((t) => t.topGoal).length}</span></div>
  ${taskList(openTasks().filter((t) => t.topGoal),
    'Ни одно действие не помечено как работа над главной целью. Пометьте звёздочкой (*) хотя бы одно.', '★')}`;
}

function topGoalBlock() {
  const goal = state.goals.find((g) => g.isTop);
  const target = state.topGoal.ladder;
  const done = topGoalToday();
  const running = state.topGoal.timerStartedAt;
  const elapsed = running ? Math.floor((Date.now() - new Date(running).getTime()) / 1000) : 0;
  const shown = done + Math.floor(elapsed / 60);
  const pct = Math.min(100, Math.round((shown / target) * 100));
  const streak = topGoalStreak();

  const clock = running
    ? `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
    : `${shown} / ${target} мин`;

  const strip = dayKeys(14).map((d) => {
    const m = state.topGoal.log[d] || 0;
    const cls = m >= target ? 'hit' : m > 0 ? 'part' : '';
    const h = m ? Math.max(20, Math.min(100, (m / target) * 100)) : 8;
    return `<div class="${cls}" style="height:${h}%" title="${d}: ${m} мин"></div>`;
  }).join('');

  return `
  <div class="topgoal">
    <div class="topgoal-head">
      <span class="topgoal-title">★ Top Goal — ${target} мин в день</span>
      <span class="topgoal-goal">${goal ? esc(goal.title) : '<a href="#/goals">задайте главную цель →</a>'}</span>
    </div>
    <div class="topgoal-clock ${running ? 'is-running' : ''}">${clock}</div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="hint">
      ${streak ? `${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд с выполненной нормой · ` : ''}
      лесенка: начните с 30 минут и поднимайте ступень, когда норма держится неделю
    </div>
    <div class="ladder">
      ${LADDER.map((m) => `<button data-action="ladder" data-min="${m}" class="${m === target ? 'is-on' : ''}">${m}м</button>`).join('')}
    </div>
    <div class="topgoal-actions">
      <button class="btn ${running ? '' : 'btn-primary'}" data-action="timer">${running ? '■ Остановить и записать' : '▶ Запустить сессию'}</button>
      <button class="btn" data-action="add-min" data-min="15">+15 мин</button>
      <button class="btn" data-action="add-min" data-min="30">+30 мин</button>
      ${done ? `<button class="btn btn-ghost btn-danger" data-action="add-min" data-min="-${done}">сбросить день</button>` : ''}
    </div>
    <div class="strip-label"><span>последние 14 дней</span><span>норма ${target} мин</span></div>
    <div class="strip">${strip}</div>
  </div>`;
}

/* ---------- списки GTD ---------- */

function viewList(list) {
  const all = byList(list);

  if (list === 'next') {
    const used = CONTEXTS.filter((c) => all.some((t) => t.context === c.id));
    const noCtx = all.filter((t) => !t.context);
    const filtered = ui.ctxFilter === 'all' ? all : all.filter((t) => t.context === ui.ctxFilter);
    const groups = ui.ctxFilter === 'all'
      ? [...used.map((c) => [c.label, all.filter((t) => t.context === c.id)]),
         ...(noCtx.length ? [['Без контекста', noCtx]] : [])]
      : [[ctxLabel(ui.ctxFilter) || 'Все', filtered]];

    return `
    <div class="filters">
      <button data-action="ctx" data-ctx="all" class="${ui.ctxFilter === 'all' ? 'is-on' : ''}">Все · ${all.length}</button>
      ${CONTEXTS.map((c) => {
        const n = all.filter((t) => t.context === c.id).length;
        return `<button data-action="ctx" data-ctx="${c.id}" class="${ui.ctxFilter === c.id ? 'is-on' : ''}">${c.label} · ${n}</button>`;
      }).join('')}
    </div>
    ${all.length === 0
      ? `<div class="empty"><span class="empty-emoji">▸</span><p>Пусто. Действие — это конкретный физический шаг: «позвонить», «написать», «открыть файл».</p></div>`
      : groups.map(([label, tasks]) => tasks.length ? `
        <div class="section-head"><h2>${esc(label)}</h2><span class="count">${tasks.length}</span></div>
        ${taskList(tasks, '')}` : '').join('')}`;
  }

  if (list === 'waiting') {
    const sorted = [...all].sort((a, b) => (daysSince(b.updatedAt) ?? 0) - (daysSince(a.updatedAt) ?? 0));
    return `
    <p class="hint" style="margin-bottom:14px">Всё, что вы передали другим. Строки, висящие дольше недели, помечены — их надо пнуть на ревью.</p>
    ${taskList(sorted, 'Ничего не ждёте. Делегируйте смелее: «?Имя» в строке захвата.', '⏳')}`;
  }

  if (list === 'agenda') {
    const people = [...new Set(all.map((t) => t.person || 'Без адресата'))];
    return `
    <p class="hint" style="margin-bottom:14px">Вопросы, которые надо задать конкретному человеку при следующей встрече. Захват: <code>&gt;Имя вопрос</code>.</p>
    ${all.length === 0
      ? `<div class="empty"><span class="empty-emoji">☰</span><p>Повесток нет. Копите вопросы здесь вместо того, чтобы дёргать людей по одному.</p></div>`
      : people.map((p) => {
          const tasks = all.filter((t) => (t.person || 'Без адресата') === p);
          return `<div class="section-head"><h2>${esc(p)}</h2><span class="count">${tasks.length}</span></div>${taskList(tasks, '')}`;
        }).join('')}`;
  }

  if (list === 'inbox') {
    return `
    <p class="hint" style="margin-bottom:14px">Правило разбора: если действие займёт меньше 2 минут — сделайте сразу. Иначе решите: действие, проект, ожидание, повестка или когда-нибудь.</p>
    ${taskList(all, 'Инбокс пуст. Это и есть цель.', '✓')}`;
  }

  return `
  <p class="hint" style="margin-bottom:14px">Идеи и обязательства, к которым вы сознательно не приступаете. Перечитывайте на недельном ревью.</p>
  ${taskList(all, 'Пока пусто. Захват: символ ~ в строке.', '∞')}`;
}

/* ---------- проекты ---------- */

function viewProjects() {
  const active = state.projects.filter((p) => p.status === 'active');
  const done = state.projects.filter((p) => p.status !== 'active');

  const card = (p) => {
    const next = state.tasks.filter((t) => t.projectId === p.id && t.list === 'next');
    const open = projectTasks(p.id).length;
    const stalled = next.length === 0;
    return `
    <button class="card ${stalled ? 'is-alert' : ''}" data-action="open-project" data-id="${p.id}">
      <h3>${esc(p.title)}</h3>
      <p>${p.outcome ? esc(p.outcome) : '<span style="color:var(--faint)">результат не сформулирован</span>'}</p>
      <div class="card-foot">
        <span class="chip">${open} ${plural(open, 'задача', 'задачи', 'задач')}</span>
        ${stalled
          ? '<span class="chip is-stale">нет next action</span>'
          : `<span class="chip">▸ ${esc(next[0].title.slice(0, 40))}</span>`}
      </div>
    </button>`;
  };

  return `
  <div class="section-head"><h2>Активные</h2><span class="count">${active.length}</span><span class="spacer"></span>
    <button class="btn btn-sm btn-primary" data-action="new-project">+ Проект</button></div>
  ${active.length
    ? `<div class="cards">${active.map(card).join('')}</div>`
    : `<div class="empty"><span class="empty-emoji">▦</span><p>Проект в GTD — любой результат, требующий больше одного шага. Ремонт, найм, запуск лендинга.</p></div>`}
  ${done.length ? `
    <div class="section-head"><h2>Завершённые</h2><span class="count">${done.length}</span></div>
    <div class="cards">${done.map(card).join('')}</div>` : ''}`;
}

/* ---------- цели ---------- */

function viewGoals() {
  return `
  <p class="hint" style="margin-bottom:14px">Горизонты выше проектов. Одна цель помечается как <b>главная</b> — именно на неё вы отдаёте ежедневные два часа по Top Goal.</p>
  <div class="section-head"><h2>Цели</h2><span class="count">${state.goals.length}</span><span class="spacer"></span>
    <button class="btn btn-sm btn-primary" data-action="new-goal">+ Цель</button></div>
  ${state.goals.length ? `<div class="cards">${state.goals.map((g) => {
    const projects = state.projects.filter((p) => p.goalId === g.id);
    return `
    <div class="card ${g.isTop ? '' : ''}" ${g.isTop ? 'style="border-color:var(--accent)"' : ''}>
      <h3>${g.isTop ? '★ ' : ''}<span contenteditable="true" data-edit="goal-title" data-id="${g.id}">${esc(g.title)}</span></h3>
      <p>${projects.length} ${plural(projects.length, 'проект', 'проекта', 'проектов')} · горизонт: ${g.horizon === 'year' ? 'год' : 'квартал'}</p>
      <div class="card-foot">
        ${g.isTop ? '<span class="chip is-top">главная цель</span>'
          : `<button class="btn btn-sm" data-action="set-top" data-id="${g.id}">Сделать главной</button>`}
        <button class="btn btn-sm btn-ghost" data-action="toggle-horizon" data-id="${g.id}">${g.horizon === 'year' ? 'в квартал' : 'в год'}</button>
        <button class="btn btn-sm btn-ghost btn-danger" data-action="del-goal" data-id="${g.id}">Удалить</button>
      </div>
    </div>`;
  }).join('')}</div>` : `<div class="empty"><span class="empty-emoji">★</span><p>Без цели верхнего уровня дашборд превращается в список дел. Добавьте хотя бы одну.</p></div>`}

  <div class="divider"></div>
  <div class="card">
    <h3>Про загруженность</h3>
    <p>Загруженность не всегда означает эффективность. Часто она показывает, что не хватает ясных правил, ролей и ответственности. Если список Next actions растёт быстрее, чем закрывается — вопрос не к тайм-менеджменту, а к делегированию.</p>
  </div>`;
}

/* ---------- еженедельное ревью ---------- */

const REVIEW_STEPS = [
  ['Собрать', 'Вынести всё из головы, блокнотов, мессенджеров в инбокс.', () => null, 'inbox'],
  ['Разобрать инбокс до нуля', 'Каждая строка: действие, проект, ожидание, повестка, когда-нибудь или в корзину.', () => byList('inbox').length, 'inbox'],
  ['Пройти Next actions', 'Всё ещё актуально? Что можно вычеркнуть или делегировать?', () => byList('next').length, 'next'],
  ['Проверить Ожидание', 'Что висит дольше недели — напомнить или забрать обратно.', () => staleWaiting().length, 'waiting'],
  ['Проверить проекты', 'У каждого активного проекта должно быть хотя бы одно следующее действие.', () => stalledProjects().length, 'projects'],
  ['Пройти Agenda', 'Кому и что нужно задать на ближайших встречах.', () => byList('agenda').length, 'agenda'],
  ['Перечитать «Когда-нибудь»', 'Что-то стало актуальным? Поднимите в проекты.', () => byList('someday').length, 'someday'],
  ['Свериться с целями', 'Двигают ли текущие проекты главную цель? Сколько часов ушло на Top Goal?', () => null, 'goals'],
];

function viewReview() {
  const checked = ui.reviewChecked || (ui.reviewChecked = new Set());
  const since = daysSince(state.review.lastAt);

  return `
  <div class="card ${reviewDue() ? 'is-alert' : ''}" style="margin-bottom:20px">
    <h3>${since === null ? 'Ревью ещё не проводилось' : `Последнее ревью: ${fmtDate(state.review.lastAt.slice(0, 10))}`}</h3>
    <p>${reviewDue()
      ? 'Прошло больше недели. Система теряет доверие к себе, когда обзор откладывается — вы перестаёте верить спискам.'
      : 'Система свежая. Следующий обзор — через ' + (7 - since) + ' ' + plural(7 - since, 'день', 'дня', 'дней') + '.'}</p>
  </div>

  ${REVIEW_STEPS.map(([title, desc, count, route], i) => {
    const n = count();
    const isDone = checked.has(i);
    return `
    <div class="review-step ${isDone ? 'is-done' : ''}">
      <button class="check" data-action="review-step" data-i="${i}" style="${isDone ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">✓</button>
      <div style="flex:1;min-width:0">
        <div class="review-title">${esc(title)}${n ? ` <span class="chip ${n && i > 0 ? 'is-stale' : ''}">${n}</span>` : ''}</div>
        <div class="review-desc">${esc(desc)}</div>
      </div>
      <a class="btn btn-sm btn-ghost" href="#/${route}">→</a>
    </div>`;
  }).join('')}

  <div style="display:flex;gap:8px;margin-top:20px;flex-wrap:wrap">
    <button class="btn btn-primary" data-action="finish-review">Ревью завершено</button>
    <button class="btn btn-ghost" data-action="reset-review">Сбросить галочки</button>
  </div>

  ${state.review.history.length ? `
    <div class="section-head"><h2>История</h2></div>
    <p class="hint">${state.review.history.slice(0, 12).map((h) => fmtDate(h.slice(0, 10))).join(' · ')}</p>` : ''}`;
}

/* ---------- конспекты звонков ---------- */

function viewNotes() {
  if (ui.openNote) {
    const n = state.notes.find((x) => x.id === ui.openNote);
    if (!n) { ui.openNote = null; return viewNotes(); }
    const found = parseNoteLines(n.body).length;

    // конспект — это markdown-файл, поэтому по умолчанию его читают, а не правят
    if (!ui.editNote) {
      return `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn btn-sm" data-action="close-note">← Все конспекты</button>
        ${n.mdFile ? `<span class="chip" title="Файл у Майка">✎ ${esc(n.mdFile)}</span>` : ''}
        <div style="flex:1"></div>
        <button class="btn btn-sm" data-action="edit-note">Править</button>
        <button class="btn btn-sm btn-primary" data-action="extract" data-id="${n.id}" ${found ? '' : 'disabled'}>
          Извлечь действия${found ? ` (${found})` : ''}</button>
      </div>
      <article class="md">${renderMarkdown(n.body || '_Пусто._')}</article>`;
    }

    return `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <button class="btn btn-sm" data-action="read-note">← Читать</button>
      <div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost btn-danger" data-action="del-note" data-id="${n.id}">Удалить</button>
    </div>
    <div class="field"><label>Заголовок</label>
      <input data-edit="note-title" data-id="${n.id}" value="${esc(n.title)}" placeholder="Звонок с ..."></div>
    <div class="field-row" style="margin-top:12px">
      <div class="field"><label>Кто</label>
        <input data-edit="note-person" data-id="${n.id}" value="${esc(n.person)}" placeholder="Имя, компания"></div>
      <div class="field"><label>Дата</label>
        <input type="date" data-edit="note-date" data-id="${n.id}" value="${esc(n.date)}"></div>
    </div>
    <div class="field" style="margin-top:12px"><label>Проект</label>
      <select data-edit="note-project" data-id="${n.id}">
        <option value="">— без проекта —</option>
        ${state.projects.map((p) => `<option value="${p.id}" ${p.id === n.projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
      </select></div>
    <div class="field" style="margin-top:12px"><label>Конспект</label>
      <textarea data-edit="note-body" data-id="${n.id}" rows="16"
        placeholder="Свободный текст.&#10;&#10;Строки, начинающиеся с символа, станут задачами при разборе:&#10;- подготовить смету @комп !завтра&#10;? Петя пришлёт договор&#10;> спросить у Ани про бюджет">${esc(n.body)}</textarea></div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" data-action="extract" data-id="${n.id}" ${found ? '' : 'disabled'}>
        Извлечь действия${found ? ` (${found})` : ''}</button>
      ${mike()?.token.trim() ? `<button class="btn" data-action="send-note" data-id="${n.id}">⚡ Майку</button>` : ''}
      <span class="hint">Строки с <code>-</code> → действие, <code>?</code> → ожидание, <code>&gt;</code> → повестка</span>
    </div>`;
  }

  return `
  <div class="section-head"><h2>Конспекты</h2><span class="count">${state.notes.length}</span><span class="spacer"></span>
    <button class="btn btn-sm btn-primary" data-action="new-note">+ Конспект</button></div>
  ${state.notes.length ? `<div class="cards">${state.notes.map((n) => `
    <button class="card" data-action="open-note" data-id="${n.id}">
      <h3>${esc(n.title || 'Без названия')}</h3>
      <p>${esc((n.body || '').slice(0, 120) || 'Пусто')}${n.body.length > 120 ? '…' : ''}</p>
      <div class="card-foot">
        <span class="chip">${fmtDate(n.date)}</span>
        ${n.person ? `<span class="chip">${esc(n.person)}</span>` : ''}
        ${n.projectId ? `<span class="chip">▦ ${esc(projectTitle(n.projectId))}</span>` : ''}
      </div>
    </button>`).join('')}</div>`
    : `<div class="empty"><span class="empty-emoji">✎</span><p>Записывайте звонки сюда, а решения из них разбирайте в действия одной кнопкой.</p></div>`}`;
}


/* ---------- SEO-пайплайн ---------- */

function viewSeo() {
  const url = (state.settings.seoUrl || '').trim();
  return `
  <p class="hint" style="margin-bottom:14px">Ваш рабочий SEO-пайплайн живёт отдельной страницей. Укажите её адрес — и она откроется прямо здесь, не выходя из пульта.</p>

  <div class="card" style="margin-bottom:16px">
    <div class="field"><label>Адрес страницы</label>
      <input data-edit="seo-url" value="${esc(url)}" placeholder="/seo-status/ или https://…"></div>
    <div class="card-foot">
      <span class="hint">Если пайплайн лежит на том же домене, хватит относительного пути вроде <code>/seo-status/</code>.</span>
      ${url ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Открыть отдельно ↗</a>` : ''}
    </div>
  </div>

  ${url
    ? `<iframe class="frame" src="${esc(url)}" title="SEO-пайплайн" loading="lazy"></iframe>`
    : `<div class="empty"><span class="empty-emoji">◈</span><p>Адрес не задан. Вставьте ссылку выше — страница появится в этом разделе.</p></div>`}`;
}

/* ---------- агенты ---------- */

const EVENT_LABELS = {
  ping: 'проверка связи', 'task.send': 'задача', 'note.send': 'конспект', errand: 'поручение',
};

/** Последний результат связи с агентом — из журнала, без отдельного состояния. */
function agentStatus(id) {
  const last = state.outbox.find((e) => e.agentId === id && e.status !== 'pending');
  return last ? last.status : null;
}

function viewAgents() {
  const m = mike();
  const others = agents().filter((a) => a.kind !== 'mike');
  const log = state.outbox.slice(0, 15);
  const st = agentStatus('mike');
  const dot = st === 'ok' ? '<span class="dot is-ok"></span>на связи'
    : st === 'error' ? '<span class="dot is-err"></span>ошибка — см. журнал'
    : '<span class="dot"></span>связь не проверялась';

  return `
  <div class="card is-main-agent" style="margin-bottom:18px">
    <h3>Майк — главный агент <span class="agent-status">${dot}</span></h3>
    <p>Hermes-агент на этом же сервере, круглосуточно на связи в Telegram. Пульт говорит с ним напрямую — задачи, конспекты и поручения уходят ему, ответ приходит в журнал ниже.</p>
    <div class="field" style="margin-top:12px"><label>Токен моста</label>
      <input class="secret" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-form-type="other" name="mike-bridge-token" data-edit="agent-token" data-id="mike"
             value="${esc(m.token)}" placeholder="pult-… — лежит на сервере в /root/.hermes/pult-token.txt"></div>
    <div class="card-foot">
      <button class="btn btn-sm btn-primary" data-action="ping" data-id="mike">Проверить связь</button>
      <span class="hint">Потоки: задача → Майку · конспект → Майку · поручение · задачи из его TODO.md · его конспекты — в разделе «Конспекты»</span>
    </div>
  </div>

  ${m.token.trim() ? `
  <div class="card" style="margin-bottom:18px">
    <h3>Поручить Майку</h3>
    <p>Свободный текст — Майк возьмёт в работу и ответит в Telegram. Здесь появится строка в «Ожидании», чтобы поручение не потерялось.</p>
    <div class="field" style="margin-top:12px">
      <textarea id="errand-text" rows="3" placeholder="Например: собери сводку по упоминаниям crmgroup за неделю и пришли в Telegram"></textarea></div>
    <div class="card-foot"><button class="btn btn-primary" data-action="send-errand">⚡ Отправить Майку</button></div>
  </div>` : ''}

  <div class="section-head"><h2>Другие агенты</h2><span class="count">${others.length}</span><span class="spacer"></span>
    <button class="btn btn-sm" data-action="agent-add">+ Агент</button></div>
  ${others.length ? others.map((a) => `
    <div class="card" style="margin-bottom:12px">
      <div class="field-row">
        <div class="field"><label>Название</label>
          <input data-edit="agent-name" data-id="${a.id}" value="${esc(a.name)}"></div>
        <div class="field"><label>URL вебхука</label>
          <input data-edit="agent-url" data-id="${a.id}" value="${esc(a.url)}" placeholder="https://…"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Токен (уйдёт в теле запроса)</label>
        <input class="secret" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-form-type="other" name="agent-token-${a.id}" data-edit="agent-token" data-id="${a.id}"
               value="${esc(a.token)}" placeholder="необязательно"></div>
      <div class="card-foot">
        <button class="btn btn-sm" data-action="ping" data-id="${a.id}">Проверить связь</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost btn-danger" data-action="agent-del" data-id="${a.id}">Удалить</button>
      </div>
    </div>`).join('')
    : '<p class="hint" style="margin-bottom:18px">Кроме Майка пока никого. Агент — это любой вебхук (n8n, свой обработчик): пульт шлёт ему POST <code>{ event, token, payload }</code>.</p>'}

  <div class="section-head"><h2>Журнал</h2><span class="count">${state.outbox.length}</span></div>
  ${log.length ? `<div class="rows">${log.map((e) => `
    <div class="row" style="cursor:default">
      <span class="check" style="border:0;color:${e.status === 'ok' ? 'var(--ok)' : e.status === 'error' ? 'var(--danger)' : 'var(--faint)'}">
        ${e.status === 'ok' ? '✓' : e.status === 'error' ? '✕' : '·'}</span>
      <div class="row-body">
        <div class="row-title">${esc(EVENT_LABELS[e.event] || e.event)}${e.agentName ? ` → ${esc(e.agentName)}` : ''}</div>
        <div class="row-meta">
          <span class="chip">${new Date(e.at).toLocaleString('ru-RU')}</span>
          ${e.response ? `<span class="chip ${e.status === 'error' ? 'is-stale' : ''}">${esc(e.response.slice(0, 120))}</span>` : ''}
        </div>
      </div>
    </div>`).join('')}</div>`
    : `<div class="empty"><span class="empty-emoji">⚡</span><p>Отправок ещё не было.</p></div>`}`;
}

/* ---------- данные ---------- */

function viewSettings() {
  const size = new Blob([JSON.stringify(state)]).size;
  return `
  <div class="card" style="margin-bottom:18px">
    <h3>Где лежат данные</h3>
    <p>Всё хранится в localStorage этого браузера — на сервер ничего не уходит, и конспекты звонков не видны никому, кто откроет адрес. Обратная сторона: телефон и ноутбук не синхронизируются сами. Пока переносите файлом.</p>
    <div class="card-foot">
      <span class="chip">${(size / 1024).toFixed(1)} КБ</span>
      <span class="chip">${state.tasks.length} задач</span>
      <span class="chip">${state.notes.length} конспектов</span>
      ${state.updatedAt ? `<span class="chip">изменено ${new Date(state.updatedAt).toLocaleString('ru-RU')}</span>` : ''}
    </div>
  </div>

  <div class="card" style="margin-bottom:18px">
    <h3>Экспорт и импорт</h3>
    <p>Скачайте JSON на одном устройстве и загрузите на другом. Импорт заменяет текущие данные целиком.</p>
    <div class="card-foot">
      <button class="btn btn-sm btn-primary" data-action="export">↓ Скачать JSON</button>
      <label class="btn btn-sm">↑ Загрузить<input type="file" accept="application/json" data-action="import" hidden></label>
    </div>
  </div>

  <div class="card" style="margin-bottom:18px">
    <h3>Синхронизация с todo.md</h3>
    <p>Пульт читает и пишет обычный Markdown, поэтому его можно держать в паре с любым файлом задач. Вливание добавляет недостающие строки и не трогает то, что уже есть.</p>
    <div class="field" style="margin-top:12px"><label>Вставьте содержимое todo.md</label>
      <textarea id="md-in" rows="6" placeholder="## Next actions&#10;- [ ] Позвонить Пете @звонки #Ремонт_офиса !завтра&#10;- [x] Уже сделано"></textarea></div>
    <div class="card-foot">
      <button class="btn btn-sm btn-primary" data-action="md-import">Влить в пульт</button>
      <button class="btn btn-sm" data-action="md-export">↓ Скачать todo.md</button>
      <button class="btn btn-sm btn-ghost" data-action="md-preview">Показать текущий</button>
      ${mike()?.token.trim() ? '<button class="btn btn-sm" data-action="mike-pull-todo">← Задачи от Майка</button>' : ''}
    </div>
  </div>

  <div class="card" style="margin-bottom:18px">
    <h3>Оформление</h3>
    <div class="card-foot">
      ${['auto', 'dark', 'light'].map((t) => `
        <button class="btn btn-sm ${state.settings.theme === t ? 'btn-primary' : ''}" data-action="set-theme" data-theme="${t}">
          ${{ auto: 'Системная', dark: 'Тёмная', light: 'Светлая' }[t]}</button>`).join('')}
    </div>
  </div>

  <div class="card is-alert">
    <h3>Опасная зона</h3>
    <p>Полная очистка удалит задачи, проекты, цели и конспекты без возможности отката.</p>
    <div class="card-foot"><button class="btn btn-sm btn-danger" data-action="wipe">Очистить всё</button></div>
  </div>`;
}

function viewMore() {
  const items = NAV.flatMap((g) => g.items).filter(([r]) => !TABS.some(([t]) => t === r));
  return `<div class="cards">${items.map(([r, label, icon]) => {
    const n = countFor(r);
    return `<a class="card" href="#/${r}"><h3>${icon} ${esc(label)}</h3>
      <p>${esc(TITLES[r][1])}${n ? ` · ${n}` : ''}</p></a>`;
  }).join('')}
  <button class="card" data-action="theme"><h3>◐ Сменить тему</h3><p>Тёмная, светлая или системная</p></button>
  </div>`;
}

function renderView() {
  switch (ui.route) {
    case 'dashboard': return viewDashboard();
    case 'review': return viewReview();
    case 'projects': return viewProjects();
    case 'goals': return viewGoals();
    case 'notes': return viewNotes();
    case 'seo': return viewSeo();
    case 'agents': return viewAgents();
    case 'settings': return viewSettings();
    case 'more': return viewMore();
    default: return viewList(ui.route);
  }
}

/* ---------- панель деталей ---------- */

function detailPanel() {
  const { kind, id } = ui.selected;
  return kind === 'project' ? projectDetail(id) : taskDetail(id);
}

function taskDetail(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) { ui.selected = null; return ''; }
  return `
  <aside class="detail">
    <div class="detail-head">
      <h3>Действие</h3><div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost" data-action="close-detail">✕</button>
    </div>

    <div class="field"><label>Формулировка</label>
      <textarea data-edit="task-title" data-id="${id}" rows="2">${esc(t.title)}</textarea></div>

    <div class="field-row">
      <div class="field"><label>Список</label>
        <select data-edit="task-list" data-id="${id}">
          ${Object.entries(LISTS).map(([k, v]) => `<option value="${k}" ${t.list === k ? 'selected' : ''}>${v.title}</option>`).join('')}
        </select></div>
      <div class="field"><label>Контекст</label>
        <select data-edit="task-context" data-id="${id}">
          <option value="">— нет —</option>
          ${CONTEXTS.map((c) => `<option value="${c.id}" ${t.context === c.id ? 'selected' : ''}>${c.label} · ${c.hint}</option>`).join('')}
        </select></div>
    </div>

    <div class="field"><label>Проект</label>
      <select data-edit="task-project" data-id="${id}">
        <option value="">— без проекта —</option>
        ${state.projects.map((p) => `<option value="${p.id}" ${t.projectId === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
      </select></div>

    <div class="field-row">
      <div class="field"><label>${t.list === 'agenda' ? 'Кому задать' : 'От кого ждём'}</label>
        <input data-edit="task-person" data-id="${id}" value="${esc(t.person)}" placeholder="Имя"></div>
      <div class="field"><label>Срок</label>
        <input type="date" data-edit="task-due" data-id="${id}" value="${esc(t.due || '')}"></div>
    </div>

    <div class="field"><label>Минут на задачу</label>
      <input type="number" min="0" step="5" data-edit="task-minutes" data-id="${id}" value="${t.minutes ?? ''}" placeholder="15"></div>

    <div class="field"><label>Заметка</label>
      <textarea data-edit="task-note" data-id="${id}" rows="4" placeholder="Контекст, ссылки, договорённости">${esc(t.note)}</textarea></div>

    <button class="btn ${t.topGoal ? 'btn-primary' : ''}" data-action="toggle-top" data-id="${id}">
      ★ ${t.topGoal ? 'Работает на главную цель' : 'Отметить как работу над целью'}</button>

    <div class="divider" style="margin:6px 0"></div>
    <button class="btn" data-action="to-project" data-id="${id}">▦ Превратить в проект</button>
    ${readyAgents().map((a) => `
      <button class="btn" data-action="send-task" data-id="${id}" data-agent="${a.id}">⚡ Отправить ${a.kind === 'mike' ? 'Майку' : esc(a.name)}</button>`).join('')}

    <div class="detail-foot">
      <button class="btn btn-danger" data-action="del-task" data-id="${id}">Удалить</button>
      <div style="flex:1"></div>
      <button class="btn btn-primary" data-action="close-detail">Готово</button>
    </div>
  </aside>`;
}

function projectDetail(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) { ui.selected = null; return ''; }
  const tasks = projectTasks(id);
  return `
  <aside class="detail">
    <div class="detail-head">
      <h3>Проект</h3><div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost" data-action="close-detail">✕</button>
    </div>

    <div class="field"><label>Название</label>
      <input data-edit="project-title" data-id="${id}" value="${esc(p.title)}"></div>
    <div class="field"><label>Желаемый результат</label>
      <textarea data-edit="project-outcome" data-id="${id}" rows="3"
        placeholder="Как выглядит «готово»? Опишите в прошедшем времени.">${esc(p.outcome)}</textarea></div>

    <div class="field-row">
      <div class="field"><label>Цель</label>
        <select data-edit="project-goal" data-id="${id}">
          <option value="">— без цели —</option>
          ${state.goals.map((g) => `<option value="${g.id}" ${p.goalId === g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}
        </select></div>
      <div class="field"><label>Статус</label>
        <select data-edit="project-status" data-id="${id}">
          <option value="active" ${p.status === 'active' ? 'selected' : ''}>Активен</option>
          <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>На паузе</option>
          <option value="done" ${p.status === 'done' ? 'selected' : ''}>Завершён</option>
        </select></div>
    </div>

    <div class="field"><label>Добавить следующее действие</label>
      <input data-project-add="${id}" placeholder="Enter — добавить в Next actions"></div>

    <div class="section-head" style="margin:6px 0 0"><h2>Задачи</h2><span class="count">${tasks.length}</span></div>
    ${tasks.length ? `<div class="rows">${tasks.map(taskRow).join('')}</div>`
      : '<p class="hint">Нет открытых задач. Проект без следующего действия — заглохший проект.</p>'}

    <div class="detail-foot">
      <button class="btn btn-danger" data-action="del-project" data-id="${id}">Удалить</button>
      <div style="flex:1"></div>
      <button class="btn btn-primary" data-action="close-detail">Готово</button>
    </div>
  </aside>`;
}

/* ---------- рендер с сохранением фокуса ---------- */

const root = document.getElementById('root');
let quiet = false;

function focusKey() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  if (a.id) return { sel: '#' + a.id, pos: a.selectionStart };
  const edit = a.getAttribute?.('data-edit');
  if (edit) return { sel: `[data-edit="${edit}"][data-id="${a.getAttribute('data-id')}"]`, pos: a.selectionStart };
  const padd = a.getAttribute?.('data-project-add');
  if (padd) return { sel: `[data-project-add="${padd}"]`, pos: a.selectionStart };
  return null;
}

/** Пока фокус в текстовом поле, полная перерисовка уничтожила бы то,
    что человек редактирует (и цель следующего тапа на мобилке).
    В этом случае перерисовку откладываем до ухода фокуса. */
function isTyping() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable) return true;
  if (a.tagName === 'TEXTAREA') return true;
  return a.tagName === 'INPUT' && !['date', 'checkbox', 'file'].includes(a.type);
}

let renderPending = false;

/** Перерисовка по действию пользователя — всегда немедленно. */
function render() {
  renderPending = false;
  renderNow();
}

/** Перерисовка вслед за изменением данных — откладывается, если человек печатает. */
function renderSoft() {
  if (isTyping()) { renderPending = true; return; }
  render();
}

document.addEventListener('focusout', () => {
  setTimeout(() => { if (renderPending && !isTyping()) render(); }, 0);
});

function renderNow() {
  const focus = focusKey();
  const scroll = $('.main')?.scrollTop;
  root.innerHTML = shell();
  if (focus) {
    const el = $(focus.sel);
    if (el) {
      el.focus();
      if (focus.pos != null && el.setSelectionRange) {
        try { el.setSelectionRange(focus.pos, focus.pos); } catch {}
      }
    }
  }
  if (scroll) { const m = $('.main'); if (m) m.scrollTop = scroll; }
}

subscribe(() => { if (!quiet) renderSoft(); });
const quietly = (fn) => { quiet = true; try { fn(); } finally { quiet = false; } };

/* ---------- тема ---------- */

const mq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = state.settings.theme;
  const eff = t === 'auto' ? (mq.matches ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', eff);
}
mq.addEventListener('change', applyTheme);

function download(text, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- захват ---------- */

function capture(text) {
  const p = parseQuickAdd(text);
  if (!p.title) return;
  const projectId = p.projectName ? findOrCreateProject(p.projectName).id : null;
  addTask({
    title: p.title, list: p.list, context: p.context, projectId,
    person: p.person, due: p.due, minutes: p.minutes, topGoal: p.topGoal,
  });
}

/* ---------- обработка кликов ---------- */

const ACTIONS = {
  'focus-capture'() {
    const el = $('#capture');
    if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else location.hash = '#/inbox';
  },
  toggle: (el) => toggleDone(el.dataset.id),
  'close-detail': () => { ui.selected = null; render(); },
  ctx: (el) => { ui.ctxFilter = el.dataset.ctx; render(); },

  ladder: (el) => { markDirty('kv'); commit((s) => { s.topGoal.ladder = Number(el.dataset.min); }); },
  'add-min': (el) => logTopGoal(Number(el.dataset.min)),
  timer() {
    const started = state.topGoal.timerStartedAt;
    if (started) {
      const start = new Date(started);
      const mins = Math.max(1, Math.round((Date.now() - start.getTime()) / 60000));
      commit((s) => { s.topGoal.timerStartedAt = null; }); markDirty('kv');
      const startDay = todayISO(start);
      if (startDay === todayISO()) {
        logTopGoal(mins);
      } else {
        // сессия перевалила полночь: до полуночи — в день старта, остаток — в сегодня
        const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
        const before = Math.max(0, Math.round((midnight - start) / 60000));
        if (before) logTopGoal(before, startDay);
        logTopGoal(Math.max(1, mins - before));
      }
    } else {
      commit((s) => { s.topGoal.timerStartedAt = new Date().toISOString(); }); markDirty('kv');
    }
  },

  'new-project'() { const p = addProject({ title: 'Новый проект' }); ui.selected = { kind: 'project', id: p.id }; render(); },
  'open-project': (el) => { ui.selected = { kind: 'project', id: el.dataset.id }; render(); },
  'del-project': (el) => {
    if (!confirm('Удалить проект? Задачи останутся, но потеряют привязку.')) return;
    commit((s) => {
      s.projects = s.projects.filter((p) => p.id !== el.dataset.id);
      s.tasks.forEach((t) => {
        if (t.projectId === el.dataset.id) { t.projectId = null; markDirty('tasks', t.id); }
      });
    });
    markDirty('projects', el.dataset.id);
    ui.selected = null; render();
  },
  'to-project': (el) => {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    if (!t) return;
    const p = addProject({ title: t.title, outcome: '' });
    updateTask(t.id, { projectId: p.id, list: 'next' });
    ui.selected = { kind: 'project', id: p.id };
    render();
  },

  'new-goal': () => addGoal({ title: 'Новая цель' }),
  'set-top': (el) => commit((s) => s.goals.forEach((g) => {
    g.isTop = g.id === el.dataset.id;
    markDirty('goals', g.id);
  })),
  'toggle-horizon': (el) => editGoal(el.dataset.id, (g) => {
    g.horizon = g.horizon === 'year' ? 'quarter' : 'year';
  }),
  'del-goal': (el) => {
    if (!confirm('Удалить цель?')) return;
    commit((s) => { s.goals = s.goals.filter((g) => g.id !== el.dataset.id); });
    markDirty('goals', el.dataset.id);
  },

  'toggle-top': (el) => {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    if (t) updateTask(t.id, { topGoal: !t.topGoal });
  },
  'del-task': (el) => { removeTask(el.dataset.id); ui.selected = null; render(); },

  'review-step': (el) => {
    const i = Number(el.dataset.i);
    ui.reviewChecked.has(i) ? ui.reviewChecked.delete(i) : ui.reviewChecked.add(i);
    render();
  },
  'finish-review'() {
    markDirty('kv');
    commit((s) => {
      s.review.lastAt = new Date().toISOString();
      s.review.history.unshift(s.review.lastAt);
      s.review.history = s.review.history.slice(0, 52);
    });
    ui.reviewChecked = new Set();
    render();
  },
  'reset-review'() { ui.reviewChecked = new Set(); render(); },

  'new-note'() { const n = addNote({ title: '' }); ui.openNote = n.id; ui.editNote = true; render(); },
  'open-note': (el) => { ui.openNote = el.dataset.id; ui.editNote = false; render(); },
  'close-note': () => { ui.openNote = null; ui.editNote = false; render(); },
  'edit-note': () => { ui.editNote = true; render(); },
  'read-note': () => { ui.editNote = false; render(); },
  'del-note': (el) => {
    if (!confirm('Удалить конспект?')) return;
    commit((s) => { s.notes = s.notes.filter((n) => n.id !== el.dataset.id); });
    markDirty('notes', el.dataset.id);
    ui.openNote = null; ui.editNote = false; render();
  },
  extract: (el) => {
    const n = state.notes.find((x) => x.id === el.dataset.id);
    if (!n) return;
    const parsed = parseNoteLines(n.body);
    parsed.forEach((p) => {
      const projectId = p.projectName ? findOrCreateProject(p.projectName).id : n.projectId;
      addTask({
        title: p.title, list: p.list, context: p.context, projectId,
        person: p.person || (p.list !== 'next' ? n.person : ''),
        due: p.due, minutes: p.minutes, topGoal: p.topGoal,
        note: `Из конспекта: ${n.title || fmtDate(n.date)}`,
      });
    });
    alert(`Создано действий: ${parsed.length}`);
  },

  async ping(el) {
    const a = agents().find((x) => x.id === el.dataset.id);
    if (a) await sendToAgent(a, 'ping', { from: 'pult', at: new Date().toISOString() });
  },
  'sync-now': () => { syncNow(); },
  'agent-add': () => addAgent(),
  'agent-del': (el) => {
    if (!confirm('Удалить агента? Журнал отправок останется.')) return;
    removeAgent(el.dataset.id);
  },
  async 'send-errand'() {
    const text = $('#errand-text')?.value.trim();
    if (!text) { alert('Напишите, что поручаете'); return; }
    const m = mike();
    addTask({
      title: `Поручение Майку: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`,
      list: 'waiting', person: 'Майк', note: text,
    });
    $('#errand-text').value = '';
    const entry = await sendToAgent(m, 'errand', { text });
    if (entry.status === 'error') alert('Отправить не удалось: ' + entry.response + '\nСтрока в «Ожидании» всё равно создана.');
  },
  async 'send-task'(el) {
    const a = agents().find((x) => x.id === el.dataset.agent);
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    if (!a || !t) return;
    const entry = await sendToAgent(a, 'task.send', a.kind === 'mike'
      ? { title: t.title, note: t.note, due: t.due, person: t.person,
          minutes: t.minutes, projectTitle: projectTitle(t.projectId) || '' }
      : t);
    alert(entry.status === 'ok'
      ? `Ушло. Ответ: ${entry.response || 'ок'}`
      : 'Не ушло: ' + entry.response);
  },
  async 'send-note'(el) {
    const n = state.notes.find((x) => x.id === el.dataset.id);
    if (!n) return;
    const entry = await sendToAgent(mike(), 'note.send',
      { title: n.title, person: n.person, date: n.date, body: n.body });
    alert(entry.status === 'ok'
      ? `Конспект у Майка. Ответ: ${entry.response || 'ок'}`
      : 'Не ушло: ' + entry.response);
  },
  async 'mike-pull-todo'() {
    try {
      const parsed = fromMarkdown(await mikeFetch('TODO.md'))
        .filter((t) => !t.done); // выполненное у Майка не тащим — его история, не наша
      let added = 0, skipped = 0;
      parsed.forEach((t) => {
        if (state.tasks.some((x) => sameTask(x, t.title))) { skipped++; return; }
        addTask({
          title: t.title, list: t.list === 'done' ? 'next' : t.list, context: t.context,
          projectId: t.projectName ? findOrCreateProject(t.projectName).id : null,
          person: t.person, due: t.due, minutes: t.minutes, topGoal: t.topGoal,
        });
        added++;
      });
      alert(`TODO.md Майка: добавлено ${added}, уже было ${skipped}.`);
      render();
    } catch (e) { alert(String(e.message || e)); }
  },

  theme() {
    const order = ['auto', 'dark', 'light'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % 3];
    commit((s) => { s.settings.theme = next; });
    applyTheme();
  },
  'set-theme': (el) => { commit((s) => { s.settings.theme = el.dataset.theme; }); applyTheme(); },

  export: () => exportJSON(),

  'md-export'() { download(toMarkdown(), 'todo.md', 'text/markdown'); },
  'md-preview'() {
    const box = $('#md-in');
    if (box) { box.value = toMarkdown(); box.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  },
  'md-import'() {
    const parsed = fromMarkdown($('#md-in')?.value || '');
    if (!parsed.length) { alert('В тексте не нашлось строк задач. Строка должна начинаться с «- » или «- [ ] ».'); return; }
    let added = 0, skipped = 0;
    parsed.forEach((t) => {
      if (state.tasks.some((x) => sameTask(x, t.title))) { skipped++; return; }
      addTask({
        title: t.title, list: t.list, context: t.context,
        projectId: t.projectName ? findOrCreateProject(t.projectName).id : null,
        person: t.person, due: t.due, minutes: t.minutes, topGoal: t.topGoal,
        // выполненным при импорте doneAt не ставим: дата закрытия неизвестна,
        // а «сейчас» раздуло бы счётчик «Закрыто за 7 дней»
        doneAt: null,
      });
      added++;
    });
    alert(`Добавлено: ${added}. Уже было: ${skipped}.`);
    render();
  },
  wipe() {
    if (!confirm('Удалить все данные без возможности восстановления?')) return;
    if (!confirm('Точно? Сначала лучше выгрузить JSON.')) return;
    localStorage.removeItem('ivanilin.gtd.v1');
    location.reload();
  },
};

document.addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-action]');
  if (actEl && ACTIONS[actEl.dataset.action]) {
    if (actEl.tagName !== 'LABEL' && actEl.tagName !== 'INPUT') e.preventDefault();
    ACTIONS[actEl.dataset.action](actEl);
    return;
  }
  const row = e.target.closest('[data-task]');
  if (row) { ui.selected = { kind: 'task', id: row.dataset.task }; render(); }
});

/* ---------- редактирование полей ---------- */

/* Правка сущности + отметка «отправить на сервер». Конспекты и проекты
   получают updatedAt: по нему сервер разводит одновременные правки. */
const editEntity = (kind, id, fn) => commit((s) => {
  const item = s[kind].find((x) => x.id === id);
  if (!item) return;
  fn(item);
  if ('updatedAt' in item) item.updatedAt = new Date().toISOString();
  markDirty(kind, id);
});
const editProject = (id, fn) => editEntity('projects', id, fn);
const editGoal = (id, fn) => editEntity('goals', id, fn);
const editNote = (id, fn) => editEntity('notes', id, fn);

const EDITS = {
  'task-title': (id, v) => updateTask(id, { title: v }),
  'task-note': (id, v) => updateTask(id, { note: v }),
  'task-list': (id, v) => updateTask(id, { list: v }),
  'task-context': (id, v) => updateTask(id, { context: v || null }),
  'task-project': (id, v) => updateTask(id, { projectId: v || null }),
  'task-person': (id, v) => updateTask(id, { person: v }),
  'task-due': (id, v) => updateTask(id, { due: v || null }),
  'task-minutes': (id, v) => updateTask(id, { minutes: v ? Number(v) : null }),
  'project-title': (id, v) => editProject(id, (p) => { p.title = v; }),
  'project-outcome': (id, v) => editProject(id, (p) => { p.outcome = v; }),
  'project-goal': (id, v) => editProject(id, (p) => { p.goalId = v || null; }),
  'project-status': (id, v) => editProject(id, (p) => { p.status = v; }),
  'goal-title': (id, v) => editGoal(id, (g) => { g.title = v; }),
  'note-title': (id, v) => editNote(id, (n) => { n.title = v; }),
  'note-person': (id, v) => editNote(id, (n) => { n.person = v; }),
  'note-date': (id, v) => editNote(id, (n) => { n.date = v; }),
  'note-project': (id, v) => editNote(id, (n) => { n.projectId = v || null; }),
  'note-body': (id, v) => editNote(id, (n) => { n.body = v; }),
  'agent-name': (id, v) => commit((s) => { const a = s.settings.agents.find((x) => x.id === id); if (a) a.name = v; }),
  'agent-url': (id, v) => commit((s) => { const a = s.settings.agents.find((x) => x.id === id); if (a) a.url = v; }),
  'agent-token': (id, v) => commit((s) => { const a = s.settings.agents.find((x) => x.id === id); if (a) a.token = v; }),
  'seo-url': (_, v) => commit((s) => { s.settings.seoUrl = v; }),
};

/** Мелкие живые обновления, ради которых не стоит трогать весь DOM. */
function liveTouch(el) {
  const key = el.getAttribute('data-edit');
  const id = el.dataset.id;
  if (key === 'note-body') {
    const btn = $('[data-action="extract"]');
    if (btn) {
      const n = parseNoteLines(el.value).length;
      btn.disabled = !n;
      btn.textContent = `Извлечь действия${n ? ` (${n})` : ''}`;
    }
  }
  if (key === 'task-title') {
    const row = $(`[data-task="${id}"] .row-title`);
    if (row) row.textContent = el.value;
  }
  if (key === 'project-title') {
    const h = $(`[data-action="open-project"][data-id="${id}"] h3`);
    if (h) h.textContent = el.value;
  }
}

function applyEdit(el, silent) {
  const key = el.getAttribute('data-edit');
  if (!EDITS[key]) return;
  const value = el.isContentEditable ? el.textContent : el.value;
  silent ? quietly(() => EDITS[key](el.dataset.id, value)) : EDITS[key](el.dataset.id, value);
}

document.addEventListener('input', (e) => {
  if (e.target.matches?.('[data-edit]')) { applyEdit(e.target, true); liveTouch(e.target); }
});
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-edit]')) {
    // change приходит в момент blur — до того, как фокус дойдёт до следующего поля.
    // Перерисовать сейчас значит снести поле, в которое человек переходит по Tab,
    // поэтому у текстовых полей ждём, пока фокус окончательно уйдёт из формы.
    const isSelect = e.target.tagName === 'SELECT';
    applyEdit(e.target, !isSelect);
    if (isSelect) render(); else renderPending = true;
  }
  if (e.target.matches?.('input[data-action="import"]') && e.target.files[0]) {
    importJSON(e.target.files[0])
      .then(() => { render(); alert('Данные загружены'); })
      .catch((err) => alert('Не удалось прочитать файл: ' + err.message));
  }
});
document.addEventListener('blur', (e) => {
  if (e.target.matches?.('[contenteditable][data-edit]')) applyEdit(e.target, false);
}, true);

/* ---------- клавиатура ---------- */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  if (e.target.id === 'capture' && e.key === 'Enter') {
    e.preventDefault();
    capture(e.target.value);
    e.target.value = '';
    render();
    return;
  }
  const padd = e.target.getAttribute?.('data-project-add');
  if (padd && e.key === 'Enter') {
    e.preventDefault();
    const p = parseQuickAdd(e.target.value);
    if (p.title) {
      const { projectName, ...fields } = p;
      addTask({ ...fields, projectId: padd, list: p.list === 'inbox' ? 'next' : p.list });
    }
    e.target.value = '';
    render();
    return;
  }
  if (e.key === 'Escape') {
    if (ui.selected) { ui.selected = null; render(); }
    else if (typing) e.target.blur();
    return;
  }
  if (!typing && (e.key === 'n' || e.key === 'т')) { e.preventDefault(); ACTIONS['focus-capture'](); }
});

/* ---------- роутер ---------- */

const ROUTES = new Set([...NAV.flatMap((g) => g.items.map(([r]) => r)), 'more']);

function route() {
  // при переходе в другой раздел фокус не должен оставаться в поле захвата
  document.activeElement?.blur?.();
  let r = location.hash.replace(/^#\/?/, '') || 'dashboard';
  if (r === 'bots') r = 'agents'; // старые закладки на «Боты и Make»
  ui.route = ROUTES.has(r) ? r : 'dashboard';
  ui.selected = null;
  if (ui.route !== 'notes') { ui.openNote = null; ui.editNote = false; }
  render();
  window.scrollTo(0, 0);
  const m = $('.main'); if (m) m.scrollTop = 0;
}

window.addEventListener('hashchange', route);

/* ---------- запуск ---------- */

applyTheme();
route();

// база на сервере: подтянуть чужое и отдать своё; перерисовываем по смене статуса
onSync(() => renderSoft());
syncBoot();
// возвращаемся к вкладке — забираем правки, сделанные на другом устройстве
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });

// тикающие часы, пока идёт сессия Top Goal
setInterval(() => {
  if (state.topGoal.timerStartedAt && ui.route === 'dashboard' && !ui.selected) render();
}, 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
