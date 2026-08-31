/* Пульт — рендер и поведение. Ванильный ES-модуль, без сборки.

   Главное решение интерфейса: у задачи нет отдельной панели и модалки.
   Строка раскрывается на месте — одинаково на десктопе и на телефоне,
   поэтому привычка работает на обоих устройствах. */

import {
  state, commit, subscribe,
  CONTEXTS, LISTS, LADDER,
  addTask, updateTask, toggleDone, removeTask,
  addProject, findOrCreateProject, addGoal, addNote,
  byList, projectTasks, stalledProjects, staleWaiting, overdue, dueToday,
  doneSince, openTasks, topGoalToday, topGoalStreak, logTopGoal,
  exportJSON, importJSON, sendToWebhook,
  todayISO, daysSince, plural, uid,
} from './store.js';
import { parseQuickAdd, parseNoteLines } from './parse.js';
import { toMarkdown, fromMarkdown, sameTask } from './markdown.js';

/* ---------- утилиты ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function fmtDate(iso) {
  if (!iso) return '';
  if (iso === todayISO()) return 'сегодня';
  if (iso === todayISO(new Date(Date.now() + 86400000))) return 'завтра';
  if (iso === todayISO(new Date(Date.now() - 86400000))) return 'вчера';
  const [y, m, d] = iso.split('-');
  const withYear = y !== String(new Date().getFullYear());
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${withYear ? ' ' + y : ''}`;
}

const ctxLabel = (id) => CONTEXTS.find((c) => c.id === id)?.label || '';
const projectTitle = (id) => state.projects.find((p) => p.id === id)?.title || '';
const dayKeys = (n) => Array.from({ length: n }, (_, i) =>
  todayISO(new Date(Date.now() - (n - 1 - i) * 86400000)));
const hhmm = (min) => min >= 60 ? `${Math.floor(min / 60)}ч ${String(min % 60).padStart(2, '0')}м` : `${min}м`;

/* ---------- разделы ---------- */

const NAV = [
  { group: 'Ритм', items: [
    ['today', 'Сегодня', '◉'], ['dashboard', 'Скоркард', '◧'], ['review', 'Ревью', '⟳'],
  ] },
  { group: 'Поток', items: [
    ['inbox', 'Инбокс', '⬓'], ['next', 'Next actions', '▸'],
    ['waiting', 'Ожидание', '◷'], ['agenda', 'Agenda', '☰'], ['someday', 'Когда-нибудь', '∞'],
  ] },
  { group: 'Горизонты', items: [['projects', 'Проекты', '▦'], ['goals', 'Цели', '★']] },
  { group: 'База', items: [
    ['notes', 'Конспекты', '✎'], ['seo', 'SEO-пайплайн', '◈'],
    ['bots', 'Боты и Make', '⚡'], ['settings', 'Данные', '⚙'],
  ] },
];

const TABS = [
  ['today', 'Сегодня', '◉'], ['inbox', 'Инбокс', '⬓'],
  ['next', 'Действия', '▸'], ['projects', 'Проекты', '▦'], ['more', 'Ещё', '⋯'],
];

const TITLES = {
  today: ['Сегодня', 'Что делать прямо сейчас'],
  dashboard: ['Скоркард', 'Состояние системы за неделю'],
  review: ['Ревью', 'Еженедельный обзор'],
  inbox: ['Инбокс', 'Захватить всё, разобрать до нуля'],
  next: ['Next actions', 'Действия по контекстам'],
  waiting: ['Ожидание', 'Делегировано и ждёт чужого хода'],
  agenda: ['Agenda', 'Вопросы к людям'],
  someday: ['Когда-нибудь', 'Идеи вне обязательств'],
  projects: ['Проекты', 'Где больше одного шага'],
  goals: ['Цели', 'Горизонты выше проектов'],
  notes: ['Конспекты', 'Звонки и встречи'],
  seo: ['SEO-пайплайн', 'Рабочая таблица по продвижению'],
  bots: ['Боты и Make', 'Сценарии наружу'],
  settings: ['Данные', 'Хранение, перенос, оформление'],
  more: ['Ещё', 'Остальные разделы'],
};

const countFor = (r) => ({
  today: dueToday().length,
  inbox: byList('inbox').length,
  next: byList('next').length,
  waiting: byList('waiting').length,
  agenda: byList('agenda').length,
  someday: byList('someday').length,
  projects: state.projects.filter((p) => p.status === 'active').length,
  goals: state.goals.length,
  notes: state.notes.length,
}[r] ?? null);

const reviewDue = () => (daysSince(state.review.lastAt) ?? 99) >= 7;

const badgeFor = (r) => ({
  inbox: byList('inbox').length,
  today: overdue().length,
  projects: stalledProjects().length,
  review: reviewDue() ? 1 : 0,
}[r] || 0);

/* ---------- состояние интерфейса (в память, не сохраняется) ---------- */

const ui = {
  route: 'today',
  open: null,          // id раскрытой задачи
  openProject: null,
  openNote: null,
  cursor: null,        // id строки под клавиатурным курсором
  ctxFilter: 'all',
  collapsed: new Set(),
  reviewChecked: new Set(),
};

/* ==========================================================================
   Каркас
   ========================================================================== */

function shell() {
  const [title, sub] = TITLES[ui.route] || TITLES.today;

  const nav = NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    ${g.items.map(([r, label, icon]) => {
      const n = countFor(r);
      const alert = badgeFor(r) > 0;
      return `<a class="nav-item ${ui.route === r ? 'is-active' : ''}" href="#/${r}">
        <span class="nav-icon">${icon}</span>
        <span class="nav-label">${label}</span>
        ${n ? `<span class="nav-count ${alert ? 'is-alert' : ''}">${n}</span>` : ''}
      </a>`;
    }).join('')}`).join('');

  const tabs = TABS.map(([r, label, icon]) => {
    const b = r === 'more' ? badgeFor('review') : badgeFor(r);
    return `<a class="tab ${ui.route === r ? 'is-active' : ''}" href="#/${r}">
      <span class="tab-icon">${icon}</span>${label}
      ${b ? `<span class="tab-badge">${b > 9 ? '9+' : b}</span>` : ''}
    </a>`;
  }).join('');

  const withCapture = ['today', 'inbox', 'next', 'waiting', 'agenda', 'someday', 'dashboard'].includes(ui.route);

  return `
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">И</div>
        <div><div class="brand-name">Пульт</div><div class="brand-sub">ivanilin.ru/pult</div></div>
      </div>
      ${nav}
      <div class="sidebar-foot">
        <button class="btn btn-sm btn-ghost" data-action="theme">◐ Тема</button>
        <button class="btn btn-sm btn-ghost" data-action="export">↓ JSON</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div><h1>${esc(title)}</h1><div class="topbar-sub">${esc(sub)}</div></div>
      </header>
      ${withCapture ? captureBar() : ''}
      <div class="view">${renderView()}</div>
    </main>
  </div>
  <nav class="tabbar">${tabs}</nav>
  <button class="fab" data-action="focus-capture" aria-label="Новая задача">+</button>`;
}

function captureBar() {
  return `
  <div class="capture">
    <div class="capture-box">
      <span class="capture-plus">+</span>
      <input id="capture" type="text" autocomplete="off" enterkeyhint="done"
             placeholder="Что нужно сделать?">
      <span class="capture-kbd">N</span>
    </div>
    <div class="capture-hint">
      <code>@звонки</code><code>#Проект</code><code>!завтра</code>
      <code>?Петя</code> ждём<code>&gt;Петя</code> повестка<code>~</code> потом
      <code>+30м</code><code>*</code> главная цель
    </div>
  </div>`;
}

/* ==========================================================================
   Строка задачи и раскрытый редактор
   ========================================================================== */

function taskRow(t) {
  const chips = [];
  if (t.context) chips.push(`<span class="chip"><span class="chip-dot"></span>${esc(ctxLabel(t.context))}</span>`);
  if (t.projectId) chips.push(`<span class="chip is-project">${esc(projectTitle(t.projectId))}</span>`);
  if (t.person) chips.push(`<span class="chip">${t.list === 'agenda' ? '☰' : '◷'} ${esc(t.person)}</span>`);
  if (t.minutes) chips.push(`<span class="chip">${t.minutes} мин</span>`);
  if (t.list === 'waiting') {
    const d = daysSince(t.updatedAt) ?? 0;
    if (d >= 7) chips.push(`<span class="chip is-danger">висит ${d} ${plural(d, 'день', 'дня', 'дней')}</span>`);
  }

  let aside = '';
  if (t.due) {
    const cls = t.due < todayISO() ? 'is-overdue' : t.due === todayISO() ? 'is-due' : '';
    aside = `<div class="row-aside ${cls}">${fmtDate(t.due)}</div>`;
  }

  const open = ui.open === t.id;

  return `
  <div class="row-wrap" data-wrap="${t.id}">
    <div class="row-swipe"><span>✓ Готово</span><span>Завтра →</span></div>
    <div class="row ${t.list === 'done' ? 'is-done' : ''} ${open ? 'is-open' : ''} ${ui.cursor === t.id ? 'is-cursor' : ''}"
         data-task="${t.id}">
      <button class="check" data-action="toggle" data-id="${t.id}" aria-label="Отметить выполненным">✓</button>
      <div class="row-body">
        ${open
          ? `<textarea class="row-title-input" data-edit="task-title" data-id="${t.id}" rows="1"
                       placeholder="Конкретный физический шаг">${esc(t.title)}</textarea>`
          : `<div class="row-title">${t.topGoal ? '<span class="row-star">★</span>' : ''}${esc(t.title)}</div>
             ${chips.length ? `<div class="row-meta">${chips.join('')}</div>` : ''}`}
      </div>
      ${open ? '' : aside}
    </div>
    ${open ? taskEditor(t) : ''}
  </div>`;
}

function taskEditor(t) {
  const lists = [['inbox', 'Инбокс'], ['next', 'Действие'], ['waiting', 'Ждём'], ['agenda', 'Повестка'], ['someday', 'Потом']];
  return `
  <div class="editor">
    <div class="segmented">
      ${lists.map(([k, label]) =>
        `<button data-action="set-list" data-id="${t.id}" data-list="${k}"
                 class="${t.list === k ? 'is-on' : ''}">${label}</button>`).join('')}
    </div>

    <div class="editor-grid">
      <div class="field"><label>Контекст</label>
        <select data-edit="task-context" data-id="${t.id}">
          <option value="">— нет —</option>
          ${CONTEXTS.map((c) => `<option value="${c.id}" ${t.context === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select></div>
      <div class="field"><label>Проект</label>
        <select data-edit="task-project" data-id="${t.id}">
          <option value="">— нет —</option>
          ${state.projects.map((p) => `<option value="${p.id}" ${t.projectId === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select></div>
      <div class="field"><label>Срок</label>
        <input type="date" data-edit="task-due" data-id="${t.id}" value="${esc(t.due || '')}"></div>
      <div class="field"><label>Минут</label>
        <input type="number" min="0" step="5" placeholder="—" data-edit="task-minutes" data-id="${t.id}" value="${t.minutes ?? ''}"></div>
      ${['waiting', 'agenda'].includes(t.list) ? `
        <div class="field"><label>${t.list === 'agenda' ? 'Кому задать' : 'От кого ждём'}</label>
          <input data-edit="task-person" data-id="${t.id}" value="${esc(t.person)}" placeholder="Имя"></div>` : ''}
    </div>

    <div class="field"><label>Заметка</label>
      <textarea data-edit="task-note" data-id="${t.id}" rows="3"
                placeholder="Контекст, ссылки, договорённости">${esc(t.note)}</textarea></div>

    <div class="editor-foot">
      <button class="btn btn-sm ${t.topGoal ? 'btn-primary' : ''}" data-action="toggle-top" data-id="${t.id}">★ Главная цель</button>
      <button class="btn btn-sm" data-action="to-project" data-id="${t.id}">▦ В проект</button>
      <button class="btn btn-sm" data-action="send-task" data-id="${t.id}">⚡ В Make</button>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost btn-danger" data-action="del-task" data-id="${t.id}">Удалить</button>
      <button class="btn btn-sm btn-primary" data-action="close-editor">Готово</button>
    </div>
  </div>`;
}

const rows = (list) => `<div class="rows">${list.map(taskRow).join('')}</div>`;

/** Группа с сворачиванием. key нужен, чтобы запомнить состояние между перерисовками. */
function group(key, title, list, extra = '') {
  if (!list.length) return '';
  const collapsed = ui.collapsed.has(key);
  return `
  <section class="group ${collapsed ? 'is-collapsed' : ''}">
    <button class="group-head" data-action="collapse" data-key="${esc(key)}">
      <span class="group-caret">▾</span>
      <span class="group-title">${esc(title)}</span>
      <span class="group-count">${list.length}</span>
      <span class="spacer"></span>${extra}
    </button>
    ${rows(list)}
  </section>`;
}

const empty = (mark, text) =>
  `<div class="empty"><span class="empty-mark">${mark}</span><p>${text}</p></div>`;

/* ==========================================================================
   Сегодня
   ========================================================================== */

function viewToday() {
  const od = overdue();
  const today = dueToday().filter((t) => t.due === todayISO());
  const starred = openTasks().filter((t) => t.topGoal && !t.due);
  const inbox = byList('inbox').length;
  const nothing = !od.length && !today.length && !starred.length;

  return `
  ${topGoalBlock(true)}

  ${inbox ? `
    <a class="banner" href="#/inbox" style="background:var(--warn-soft)">
      <span class="banner-mark" style="color:var(--warn)">⬓</span>
      <div><h3 style="color:var(--warn)">В инбоксе ${inbox} ${plural(inbox, 'запись', 'записи', 'записей')}</h3>
      <p>Разберите до нуля — иначе система перестаёт быть надёжной.</p></div>
    </a>` : ''}

  ${group('today-overdue', 'Просрочено', od)}
  ${group('today-due', 'На сегодня', today)}
  ${group('today-star', 'Двигают главную цель', starred)}

  ${nothing ? empty('◉', 'На сегодня ничего не назначено. Откройте <b>Next actions</b> и возьмите то, что подходит по контексту и времени.') : ''}`;
}

/* ==========================================================================
   Скоркард
   ========================================================================== */

function viewDashboard() {
  const inbox = byList('inbox').length;
  const stalled = stalledProjects().length;
  const stale = staleWaiting().length;
  const od = overdue().length;
  const closed7 = doneSince(7).length;
  const closed14 = doneSince(14).length - closed7;
  const since = daysSince(state.review.lastAt);

  const tile = (label, value, note, cls = '', route = 'today') => `
    <a class="tile ${cls}" href="#/${route}">
      <div class="tile-label">${label}</div>
      <div class="tile-value">${value}</div>
      <div class="tile-note">${note}</div>
    </a>`;

  const trend = closed14 ? (closed7 >= closed14
    ? `<span style="color:var(--ok)">+${closed7 - closed14}</span> к прошлой`
    : `<span style="color:var(--danger)">−${closed14 - closed7}</span> к прошлой`) : 'за неделю';

  return `
  ${topGoalBlock(false)}

  <div class="tiles">
    ${tile('Инбокс', inbox, inbox ? 'разобрать' : 'чисто', inbox ? 'is-alert' : 'is-ok', 'inbox')}
    ${tile('Действий', byList('next').length, `${dueToday().length} на сегодня`, '', 'next')}
    ${tile('Ожидание', byList('waiting').length, stale ? `${stale} висит >7 дней` : 'всё свежее', stale ? 'is-alert' : '', 'waiting')}
    ${tile('Проекты', state.projects.filter((p) => p.status === 'active').length,
      stalled ? `${stalled} без хода` : 'у всех есть ход', stalled ? 'is-alert' : 'is-ok', 'projects')}
    ${tile('Просрочено', od, od ? 'разберите сегодня' : 'сроки в порядке', od ? 'is-alert' : 'is-ok', 'today')}
    ${tile('Закрыто', closed7, trend, '', 'today')}
    ${tile('Ревью', since === null ? '—' : since,
      since === null ? 'ещё ни разу' : `${plural(since, 'день', 'дня', 'дней')} назад`,
      reviewDue() ? 'is-alert' : 'is-ok', 'review')}
    ${tile('Agenda', byList('agenda').length, 'вопросов к людям', '', 'agenda')}
  </div>

  ${(inbox || stalled || stale || reviewDue()) ? `
    <div class="banner">
      <span class="banner-mark">▲</span>
      <div>
        <h3>Система просит внимания</h3>
        <p>${[
          inbox ? `инбокс не разобран (${inbox})` : '',
          stalled ? `${stalled} ${plural(stalled, 'проект', 'проекта', 'проектов')} без следующего действия` : '',
          stale ? `${stale} в ожидании дольше недели` : '',
          reviewDue() ? 'пора провести недельное ревью' : '',
        ].filter(Boolean).join(' · ')}</p>
      </div>
    </div>` : ''}

  ${group('dash-today', 'Сегодня и просрочено', dueToday())}`;
}

function topGoalBlock(compact) {
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
    : hhmm(shown);

  return `
  <div class="topgoal">
    <div class="topgoal-eyebrow"><span class="topgoal-star">★</span> Главная цель · ${target} мин в день</div>
    <div class="topgoal-goal">${goal ? esc(goal.title) : '<a href="#/goals">Задайте главную цель →</a>'}</div>

    <div class="topgoal-meter">
      <span class="topgoal-clock ${running ? 'is-running' : ''}">${clock}</span>
      <span class="topgoal-target">из ${hhmm(target)}${streak ? ` · ${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд` : ''}</span>
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>

    <div class="topgoal-actions">
      <button class="btn ${running ? '' : 'btn-primary'}" data-action="timer">${running ? '■ Остановить и записать' : '▶ Начать сессию'}</button>
      <button class="btn" data-action="add-min" data-min="15">+15</button>
      <button class="btn" data-action="add-min" data-min="30">+30</button>
      ${done ? `<button class="btn btn-ghost btn-danger" data-action="add-min" data-min="-${done}">сброс</button>` : ''}
    </div>

    ${compact ? '' : `
      <div class="ladder">
        ${LADDER.map((m) => `<button data-action="ladder" data-min="${m}" class="${m === target ? 'is-on' : ''}">${m} мин</button>`).join('')}
      </div>
      <div class="strip-head"><span>последние 14 дней</span><span>норма ${target} мин</span></div>
      <div class="strip">${dayKeys(14).map((d) => {
        const m = state.topGoal.log[d] || 0;
        const cls = m >= target ? 'hit' : m > 0 ? 'part' : '';
        const h = m ? Math.max(22, Math.min(100, (m / target) * 100)) : 12;
        return `<div class="${cls}" style="height:${h}%" title="${d}: ${m} мин"></div>`;
      }).join('')}</div>`}
  </div>`;
}

/* ==========================================================================
   Списки потока
   ========================================================================== */

function viewList(list) {
  const all = byList(list);

  if (list === 'next') {
    const filtered = ui.ctxFilter === 'all' ? all : all.filter((t) => t.context === ui.ctxFilter);
    const noCtx = filtered.filter((t) => !t.context);

    return `
    <div class="filters">
      <button data-action="ctx" data-ctx="all" class="${ui.ctxFilter === 'all' ? 'is-on' : ''}">
        Все<span class="f-count">${all.length}</span></button>
      ${CONTEXTS.map((c) => {
        const n = all.filter((t) => t.context === c.id).length;
        if (!n && ui.ctxFilter !== c.id) return '';
        return `<button data-action="ctx" data-ctx="${c.id}" class="${ui.ctxFilter === c.id ? 'is-on' : ''}">
          ${c.label}<span class="f-count">${n}</span></button>`;
      }).join('')}
    </div>
    ${all.length === 0
      ? empty('▸', 'Пусто. Действие — это конкретный физический шаг: «позвонить», «написать», «открыть файл». Не «подумать про сайт».')
      : CONTEXTS.map((c) => group('next-' + c.id, c.label + ' · ' + c.hint,
          filtered.filter((t) => t.context === c.id))).join('') +
        group('next-none', 'Без контекста', noCtx)}`;
  }

  if (list === 'waiting') {
    const sorted = [...all].sort((a, b) => (daysSince(b.updatedAt) ?? 0) - (daysSince(a.updatedAt) ?? 0));
    const stale = sorted.filter((t) => (daysSince(t.updatedAt) ?? 0) >= 7);
    const fresh = sorted.filter((t) => (daysSince(t.updatedAt) ?? 0) < 7);
    return `
    <p class="lede">Всё, что вы передали другим. То, что висит дольше недели, стоит пнуть или забрать обратно.</p>
    ${group('wait-stale', 'Пора напомнить', stale)}
    ${group('wait-fresh', 'Ждём спокойно', fresh)}
    ${all.length ? '' : empty('◷', 'Ничего не ждёте. Делегируйте смелее — <code>?Имя</code> в строке захвата.')}`;
  }

  if (list === 'agenda') {
    const people = [...new Set(all.map((t) => t.person || 'Без адресата'))];
    return `
    <p class="lede">Вопросы, которые надо задать конкретному человеку при следующей встрече. Захват: <code>&gt;Имя вопрос</code>.</p>
    ${all.length
      ? people.map((p) => group('ag-' + p, p, all.filter((t) => (t.person || 'Без адресата') === p))).join('')
      : empty('☰', 'Повесток нет. Копите вопросы здесь, вместо того чтобы дёргать людей по одному.')}`;
  }

  if (list === 'inbox') {
    return `
    <p class="lede">Правило разбора: если займёт меньше двух минут — сделайте сразу. Иначе решите, что это: действие, проект, ожидание, повестка или «когда-нибудь».</p>
    ${all.length ? rows(all) : empty('✓', 'Инбокс пуст. Это и есть цель.')}`;
  }

  return `
  <p class="lede">Идеи и обязательства, к которым вы сознательно не приступаете. Перечитывайте на недельном ревью.</p>
  ${all.length ? rows(all) : empty('∞', 'Пока пусто. Захват: <code>~</code> в начале строки.')}`;
}

/* ==========================================================================
   Проекты
   ========================================================================== */

function viewProjects() {
  const active = state.projects.filter((p) => p.status === 'active');
  const closed = state.projects.filter((p) => p.status !== 'active');

  const card = (p) => {
    if (ui.openProject === p.id) return projectEditor(p);
    const open = projectTasks(p.id);
    const next = open.filter((t) => t.list === 'next');
    const total = state.tasks.filter((t) => t.projectId === p.id).length;
    const done = total - open.length;
    return `
    <button class="card ${next.length ? '' : 'is-alert'}" data-action="open-project" data-id="${p.id}">
      <h3>${esc(p.title)}</h3>
      <p>${p.outcome ? esc(p.outcome) : '<span style="color:var(--ink-3)">результат не сформулирован</span>'}</p>
      ${total ? `<div class="card-progress"><div style="width:${Math.round((done / total) * 100)}%"></div></div>` : ''}
      <div class="card-foot">
        <span class="chip">${done}/${total} сделано</span>
        ${next.length
          ? `<span class="chip is-project">▸ ${esc(next[0].title.slice(0, 32))}${next[0].title.length > 32 ? '…' : ''}</span>`
          : '<span class="chip is-danger">нет следующего действия</span>'}
      </div>
    </button>`;
  };

  return `
  <div class="section-head"><h2>Активные</h2><span class="count">${active.length}</span>
    <span class="spacer"></span>
    <button class="btn btn-sm btn-primary" data-action="new-project">+ Проект</button></div>
  ${active.length
    ? `<div class="cards">${active.map(card).join('')}</div>`
    : empty('▦', 'Проект — любой результат, требующий больше одного шага: ремонт, найм, запуск лендинга.')}
  ${closed.length ? `
    <div class="section-head"><h2>Завершённые</h2><span class="count">${closed.length}</span></div>
    <div class="cards">${closed.map(card).join('')}</div>` : ''}`;
}

function projectEditor(p) {
  const tasks = projectTasks(p.id);
  return `
  <div class="card is-accent" style="grid-column:1/-1">
    <div class="field"><label>Проект</label>
      <input data-edit="project-title" data-id="${p.id}" value="${esc(p.title)}"></div>
    <div class="field" style="margin-top:10px"><label>Желаемый результат</label>
      <textarea data-edit="project-outcome" data-id="${p.id}" rows="2"
        placeholder="Как выглядит «готово»? Опишите в прошедшем времени.">${esc(p.outcome)}</textarea></div>

    <div class="editor-grid" style="margin-top:10px">
      <div class="field"><label>Цель</label>
        <select data-edit="project-goal" data-id="${p.id}">
          <option value="">— нет —</option>
          ${state.goals.map((g) => `<option value="${g.id}" ${p.goalId === g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}
        </select></div>
      <div class="field"><label>Статус</label>
        <select data-edit="project-status" data-id="${p.id}">
          <option value="active" ${p.status === 'active' ? 'selected' : ''}>Активен</option>
          <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>На паузе</option>
          <option value="done" ${p.status === 'done' ? 'selected' : ''}>Завершён</option>
        </select></div>
    </div>

    <div class="field" style="margin-top:10px"><label>Следующее действие</label>
      <input data-project-add="${p.id}" placeholder="Enter — добавить в Next actions"></div>

    ${tasks.length ? `<div style="margin-top:12px">${rows(tasks)}</div>`
      : '<p class="hint" style="margin-top:12px">Нет открытых задач. Проект без следующего действия — заглохший проект.</p>'}

    <div class="editor-foot" style="margin-top:14px">
      <button class="btn btn-sm btn-ghost btn-danger" data-action="del-project" data-id="${p.id}">Удалить</button>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" data-action="close-project">Готово</button>
    </div>
  </div>`;
}

/* ==========================================================================
   Цели
   ========================================================================== */

function viewGoals() {
  return `
  <p class="lede">Горизонт выше проектов. Одна цель помечается главной — именно на неё уходят ежедневные часы по Top Goal.</p>
  <div class="section-head"><h2>Цели</h2><span class="count">${state.goals.length}</span>
    <span class="spacer"></span>
    <button class="btn btn-sm btn-primary" data-action="new-goal">+ Цель</button></div>

  ${state.goals.length ? `<div class="cards">${state.goals.map((g) => {
    const projects = state.projects.filter((p) => p.goalId === g.id);
    return `
    <div class="card ${g.isTop ? 'is-accent' : ''}">
      <div class="field"><label>${g.isTop ? '★ главная цель' : 'цель'}</label>
        <input data-edit="goal-title" data-id="${g.id}" value="${esc(g.title)}" placeholder="Чего хотите достичь"></div>
      <div class="card-foot">
        <span class="chip">${projects.length} ${plural(projects.length, 'проект', 'проекта', 'проектов')}</span>
        <button class="btn btn-sm btn-ghost" data-action="toggle-horizon" data-id="${g.id}">${g.horizon === 'year' ? 'год' : 'квартал'}</button>
        ${g.isTop ? '' : `<button class="btn btn-sm" data-action="set-top" data-id="${g.id}">Сделать главной</button>`}
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost btn-danger" data-action="del-goal" data-id="${g.id}">✕</button>
      </div>
    </div>`;
  }).join('')}</div>` : empty('★', 'Без цели верхнего уровня пульт превращается в список дел. Добавьте хотя бы одну.')}

  <div class="divider"></div>
  <div class="card">
    <h3>Про загруженность</h3>
    <p>Загруженность не всегда означает эффективность. Часто она показывает, что не хватает ясных правил, ролей и ответственности. Если Next actions растут быстрее, чем закрываются — вопрос не к тайм-менеджменту, а к делегированию.</p>
  </div>`;
}

/* ==========================================================================
   Ревью
   ========================================================================== */

const REVIEW_STEPS = [
  ['Собрать', 'Вынести всё из головы, блокнотов и мессенджеров в инбокс.', () => null, 'inbox'],
  ['Разобрать инбокс до нуля', 'Каждая строка: действие, проект, ожидание, повестка, потом или в корзину.', () => byList('inbox').length, 'inbox'],
  ['Пройти Next actions', 'Всё ещё актуально? Что вычеркнуть или делегировать?', () => byList('next').length, 'next'],
  ['Проверить Ожидание', 'Что висит дольше недели — напомнить или забрать обратно.', () => staleWaiting().length, 'waiting'],
  ['Проверить проекты', 'У каждого активного проекта — хотя бы одно следующее действие.', () => stalledProjects().length, 'projects'],
  ['Пройти Agenda', 'Кому и что задать на ближайших встречах.', () => byList('agenda').length, 'agenda'],
  ['Перечитать «Когда-нибудь»', 'Что-то стало актуальным? Поднимите в проекты.', () => byList('someday').length, 'someday'],
  ['Свериться с целями', 'Двигают ли проекты главную цель? Сколько часов ушло на Top Goal?', () => null, 'goals'],
];

function viewReview() {
  const since = daysSince(state.review.lastAt);
  const doneCount = ui.reviewChecked.size;

  return `
  <div class="card ${reviewDue() ? 'is-alert' : ''}" style="margin-bottom:18px">
    <h3>${since === null ? 'Ревью ещё не проводилось' : `Последнее ревью — ${fmtDate(state.review.lastAt.slice(0, 10))}`}</h3>
    <p>${reviewDue()
      ? 'Прошло больше недели. Система теряет доверие к себе, когда обзор откладывается: вы перестаёте верить спискам и снова держите всё в голове.'
      : `Система свежая. Следующий обзор — через ${7 - since} ${plural(7 - since, 'день', 'дня', 'дней')}.`}</p>
    <div class="card-progress"><div style="width:${Math.round((doneCount / REVIEW_STEPS.length) * 100)}%"></div></div>
    <div class="card-foot"><span class="chip">${doneCount} из ${REVIEW_STEPS.length} шагов</span></div>
  </div>

  ${REVIEW_STEPS.map(([title, desc, count, route], i) => {
    const n = count();
    const isDone = ui.reviewChecked.has(i);
    return `
    <div class="review-step ${isDone ? 'is-done' : ''}">
      <button class="check" data-action="review-step" data-i="${i}"
              style="${isDone ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">✓</button>
      <div style="flex:1;min-width:0">
        <div class="review-title">${esc(title)}${n ? `<span class="chip ${i > 0 ? 'is-danger' : ''}">${n}</span>` : ''}</div>
        <div class="review-desc">${esc(desc)}</div>
      </div>
      <a class="btn btn-sm btn-ghost" href="#/${route}">→</a>
    </div>`;
  }).join('')}

  <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
    <button class="btn btn-primary" data-action="finish-review">Ревью завершено</button>
    <button class="btn btn-ghost" data-action="reset-review">Сбросить галочки</button>
  </div>

  ${state.review.history.length ? `
    <div class="section-head"><h2>История</h2></div>
    <p class="hint">${state.review.history.slice(0, 12).map((h) => fmtDate(h.slice(0, 10))).join(' · ')}</p>` : ''}`;
}

/* ==========================================================================
   Конспекты
   ========================================================================== */

function viewNotes() {
  if (ui.openNote) {
    const n = state.notes.find((x) => x.id === ui.openNote);
    if (!n) { ui.openNote = null; return viewNotes(); }
    const found = parseNoteLines(n.body).length;
    return `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <button class="btn btn-sm" data-action="close-note">← Все конспекты</button>
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-ghost btn-danger" data-action="del-note" data-id="${n.id}">Удалить</button>
    </div>

    <div class="card">
      <div class="field"><label>Заголовок</label>
        <input data-edit="note-title" data-id="${n.id}" value="${esc(n.title)}" placeholder="Звонок с…"></div>
      <div class="editor-grid" style="margin-top:10px">
        <div class="field"><label>Кто</label>
          <input data-edit="note-person" data-id="${n.id}" value="${esc(n.person)}" placeholder="Имя, компания"></div>
        <div class="field"><label>Дата</label>
          <input type="date" data-edit="note-date" data-id="${n.id}" value="${esc(n.date)}"></div>
        <div class="field"><label>Проект</label>
          <select data-edit="note-project" data-id="${n.id}">
            <option value="">— нет —</option>
            ${state.projects.map((p) => `<option value="${p.id}" ${p.id === n.projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
          </select></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Конспект</label>
        <textarea data-edit="note-body" data-id="${n.id}" rows="15"
          placeholder="Свободный текст.&#10;&#10;Строки с маркером станут задачами:&#10;- подготовить смету @комп !завтра&#10;? Петя пришлёт договор&#10;> спросить у Ани про бюджет">${esc(n.body)}</textarea></div>
      <div class="editor-foot" style="margin-top:12px">
        <button class="btn btn-primary" data-action="extract" data-id="${n.id}" ${found ? '' : 'disabled'}>
          Извлечь действия${found ? ` (${found})` : ''}</button>
        <span class="hint"><code>-</code> действие · <code>?</code> ожидание · <code>&gt;</code> повестка</span>
      </div>
    </div>`;
  }

  return `
  <div class="section-head"><h2>Конспекты</h2><span class="count">${state.notes.length}</span>
    <span class="spacer"></span>
    <button class="btn btn-sm btn-primary" data-action="new-note">+ Конспект</button></div>
  ${state.notes.length ? `<div class="cards">${state.notes.map((n) => `
    <button class="card" data-action="open-note" data-id="${n.id}">
      <h3>${esc(n.title || 'Без названия')}</h3>
      <p>${esc((n.body || '').slice(0, 110)) || '<span style="color:var(--ink-3)">пусто</span>'}${n.body.length > 110 ? '…' : ''}</p>
      <div class="card-foot">
        <span class="chip">${fmtDate(n.date)}</span>
        ${n.person ? `<span class="chip">${esc(n.person)}</span>` : ''}
        ${n.projectId ? `<span class="chip is-project">${esc(projectTitle(n.projectId))}</span>` : ''}
      </div>
    </button>`).join('')}</div>`
    : empty('✎', 'Записывайте звонки сюда, а решения из них разбирайте в действия одной кнопкой.')}`;
}

/* ==========================================================================
   SEO-пайплайн
   ========================================================================== */

function viewSeo() {
  const url = (state.settings.seoUrl || '').trim();
  return `
  <p class="lede">Ваш рабочий SEO-пайплайн живёт отдельной страницей. Укажите её адрес — и она откроется прямо здесь, не выходя из пульта.</p>

  <div class="card" style="margin-bottom:16px">
    <div class="field"><label>Адрес страницы</label>
      <input data-edit="seo-url" value="${esc(url)}" placeholder="/seo-status/ или https://…"></div>
    <div class="card-foot">
      <span class="hint">Если пайплайн лежит рядом в репозитории — хватит относительного пути вроде <code>/seo-status/</code>.</span>
      ${url ? `<span class="spacer"></span><a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Открыть отдельно ↗</a>` : ''}
    </div>
  </div>

  ${url
    ? `<iframe class="frame" src="${esc(url)}" title="SEO-пайплайн" loading="lazy"></iframe>`
    : empty('◈', 'Адрес не задан. Вставьте ссылку выше — страница появится в этом разделе.')}`;
}

/* ==========================================================================
   Боты и Make
   ========================================================================== */

function viewBots() {
  const s = state.settings;
  const log = state.outbox.slice(0, 12);
  return `
  <div class="card" style="margin-bottom:16px">
    <h3>Куда уходят запросы</h3>
    <p>Пульт статический, поэтому наружу он ходит одним способом — POST-запросом на вебхук. Подойдёт Custom webhook в Make, n8n или свой обработчик. Пока поле пустое, кнопки «Отправить в Make» никуда не отправляют.</p>
    <div class="editor-grid" style="margin-top:12px">
      <div class="field"><label>URL вебхука</label>
        <input data-edit="webhook-url" value="${esc(s.webhookUrl)}" placeholder="https://hook.eu2.make.com/…"></div>
      <div class="field"><label>Токен (уйдёт в теле)</label>
        <input data-edit="webhook-token" value="${esc(s.webhookToken)}" placeholder="необязательно"></div>
    </div>
    <div class="card-foot">
      <button class="btn btn-sm btn-primary" data-action="ping">Проверить связь</button>
      <span class="hint">Тело: <code>{ event, token, payload }</code></span>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <h3>Создать ботика</h3>
    <p>Отправит сценарию задание и заведёт строку в «Ожидании», чтобы запрос не потерялся.</p>
    <div class="field" style="margin-top:12px"><label>Название</label>
      <input id="bot-name" placeholder="Бот-квалификатор лидов"></div>
    <div class="field" style="margin-top:10px"><label>Задача бота</label>
      <textarea id="bot-brief" rows="3" placeholder="Что делает, на каких данных, куда пишет результат"></textarea></div>
    <div class="editor-grid" style="margin-top:10px">
      <div class="field"><label>Канал</label>
        <select id="bot-channel"><option>Telegram</option><option>WhatsApp</option><option>Web-виджет</option><option>Внутренний</option></select></div>
      <div class="field"><label>Модель</label>
        <select id="bot-model"><option>claude-sonnet-5</option><option>claude-opus-5</option><option>claude-haiku-4-5</option></select></div>
    </div>
    <div class="card-foot"><button class="btn btn-primary" data-action="create-bot">Отправить в Make</button></div>
  </div>

  <div class="section-head"><h2>Журнал отправок</h2><span class="count">${state.outbox.length}</span></div>
  ${log.length ? `<div class="rows">${log.map((e) => `
    <div class="row" style="cursor:default">
      <span class="check" style="border:0;color:${e.status === 'ok' ? 'var(--ok)' : e.status === 'error' ? 'var(--danger)' : 'var(--ink-3)'}">
        ${e.status === 'ok' ? '✓' : e.status === 'error' ? '✕' : '·'}</span>
      <div class="row-body">
        <div class="row-title">${esc(e.event)}</div>
        <div class="row-meta">
          <span class="chip">${new Date(e.at).toLocaleString('ru-RU')}</span>
          ${e.response ? `<span class="chip ${e.status === 'error' ? 'is-danger' : ''}">${esc(e.response.slice(0, 70))}</span>` : ''}
        </div>
      </div>
    </div>`).join('')}</div>` : empty('⚡', 'Отправок ещё не было.')}`;
}

/* ==========================================================================
   Данные
   ========================================================================== */

function viewSettings() {
  const size = new Blob([JSON.stringify(state)]).size;
  return `
  <div class="card" style="margin-bottom:16px">
    <h3>Где лежат данные</h3>
    <p>Всё хранится в localStorage этого браузера — на сервер ничего не уходит, и конспекты звонков не увидит тот, кто просто откроет адрес. Обратная сторона: телефон и ноутбук не синхронизируются сами, переносите файлом.</p>
    <div class="card-foot">
      <span class="chip">${(size / 1024).toFixed(1)} КБ</span>
      <span class="chip">${state.tasks.length} задач</span>
      <span class="chip">${state.projects.length} проектов</span>
      <span class="chip">${state.notes.length} конспектов</span>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <h3>Перенос между устройствами</h3>
    <p>Скачайте JSON на одном устройстве и загрузите на другом. Импорт заменяет данные целиком.</p>
    <div class="card-foot">
      <button class="btn btn-sm btn-primary" data-action="export">↓ Скачать JSON</button>
      <label class="btn btn-sm">↑ Загрузить<input type="file" accept="application/json" data-action="import" hidden></label>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <h3>Синхронизация с todo.md</h3>
    <p>Пульт читает и пишет обычный Markdown, поэтому его можно держать в паре с любым файлом задач. Вливание добавляет недостающие строки и не трогает то, что уже есть.</p>
    <div class="field" style="margin-top:12px"><label>Вставьте содержимое todo.md</label>
      <textarea id="md-in" rows="6" placeholder="## Next actions&#10;- [ ] Позвонить Пете @звонки #Ремонт_офиса !завтра&#10;- [x] Уже сделано"></textarea></div>
    <div class="card-foot">
      <button class="btn btn-sm btn-primary" data-action="md-import">Влить в пульт</button>
      <button class="btn btn-sm" data-action="md-export">↓ Скачать todo.md</button>
      <button class="btn btn-sm btn-ghost" data-action="md-preview">Показать текущий</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <h3>Оформление</h3>
    <div class="card-foot">
      ${[['auto', 'Как в системе'], ['dark', 'Тёмная'], ['light', 'Светлая']].map(([t, label]) =>
        `<button class="btn btn-sm ${state.settings.theme === t ? 'btn-primary' : ''}" data-action="set-theme" data-theme="${t}">${label}</button>`).join('')}
    </div>
  </div>

  <div class="card is-alert">
    <h3 style="color:var(--danger)">Опасная зона</h3>
    <p>Полная очистка удалит задачи, проекты, цели и конспекты без возможности отката.</p>
    <div class="card-foot"><button class="btn btn-sm btn-danger" data-action="wipe">Очистить всё</button></div>
  </div>`;
}

function viewMore() {
  const items = NAV.flatMap((g) => g.items).filter(([r]) => !TABS.some(([t]) => t === r));
  return `<div class="cards">
    ${items.map(([r, label, icon]) => {
      const n = countFor(r);
      return `<a class="card" href="#/${r}"><h3>${icon}&nbsp; ${esc(label)}</h3>
        <p>${esc(TITLES[r][1])}${n ? ` · ${n}` : ''}</p></a>`;
    }).join('')}
    <button class="card" data-action="theme"><h3>◐&nbsp; Сменить тему</h3><p>Светлая, тёмная или как в системе</p></button>
  </div>`;
}

function renderView() {
  switch (ui.route) {
    case 'today': return viewToday();
    case 'dashboard': return viewDashboard();
    case 'review': return viewReview();
    case 'projects': return viewProjects();
    case 'goals': return viewGoals();
    case 'notes': return viewNotes();
    case 'seo': return viewSeo();
    case 'bots': return viewBots();
    case 'settings': return viewSettings();
    case 'more': return viewMore();
    default: return viewList(ui.route);
  }
}

/* ==========================================================================
   Рендер
   ========================================================================== */

const root = document.getElementById('root');
let quiet = false;
let renderPending = false;

/** Пока человек печатает, полная перерисовка снесла бы поле под курсором —
    и цель следующего тапа на мобилке. Откладываем до ухода фокуса. */
function isTyping() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
  return a.tagName === 'INPUT' && !['date', 'checkbox', 'file'].includes(a.type);
}

function focusKey() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  const pos = a.selectionStart;
  if (a.id) return { sel: '#' + a.id, pos };
  const edit = a.getAttribute?.('data-edit');
  if (edit) return { sel: `[data-edit="${edit}"][data-id="${a.getAttribute('data-id')}"]`, pos };
  const padd = a.getAttribute?.('data-project-add');
  if (padd) return { sel: `[data-project-add="${padd}"]`, pos };
  return null;
}

function renderNow() {
  const focus = focusKey();
  const scroll = $('.main')?.scrollTop ?? window.scrollY;
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
  if (scroll) {
    const m = $('.main');
    if (m && m.scrollHeight > m.clientHeight) m.scrollTop = scroll;
    else window.scrollTo(0, scroll);
  }
}

function render() { renderPending = false; renderNow(); }
function renderSoft() { if (isTyping()) { renderPending = true; return; } render(); }

document.addEventListener('focusout', () => {
  setTimeout(() => { if (renderPending && !isTyping()) render(); }, 0);
});

subscribe(() => { if (!quiet) renderSoft(); });
const quietly = (fn) => { quiet = true; try { fn(); } finally { quiet = false; } };

/* ---------- тема ---------- */

const mq = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = state.settings.theme || 'auto';
  document.documentElement.setAttribute('data-theme', t === 'auto' ? (mq.matches ? 'light' : 'dark') : t);
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

/* ==========================================================================
   Действия
   ========================================================================== */

const tomorrow = () => todayISO(new Date(Date.now() + 86400000));

const ACTIONS = {
  'focus-capture'() {
    const el = $('#capture');
    if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else location.hash = '#/inbox';
  },
  toggle: (el) => toggleDone(el.dataset.id),
  'close-editor': () => { ui.open = null; render(); },
  collapse: (el) => {
    const k = el.dataset.key;
    ui.collapsed.has(k) ? ui.collapsed.delete(k) : ui.collapsed.add(k);
    render();
  },
  ctx: (el) => { ui.ctxFilter = el.dataset.ctx; render(); },
  'set-list': (el) => updateTask(el.dataset.id, { list: el.dataset.list }),

  ladder: (el) => commit((s) => { s.topGoal.ladder = Number(el.dataset.min); }),
  'add-min': (el) => logTopGoal(Number(el.dataset.min)),
  timer() {
    const started = state.topGoal.timerStartedAt;
    if (started) {
      const mins = Math.max(1, Math.round((Date.now() - new Date(started).getTime()) / 60000));
      commit((s) => { s.topGoal.timerStartedAt = null; });
      logTopGoal(mins);
    } else {
      commit((s) => { s.topGoal.timerStartedAt = new Date().toISOString(); });
    }
  },

  'new-project'() { const p = addProject({ title: '' }); ui.openProject = p.id; render(); },
  'open-project': (el) => { ui.openProject = el.dataset.id; render(); },
  'close-project': () => { ui.openProject = null; render(); },
  'del-project': (el) => {
    if (!confirm('Удалить проект? Задачи останутся, но потеряют привязку.')) return;
    const id = el.dataset.id;
    commit((s) => {
      s.projects = s.projects.filter((p) => p.id !== id);
      s.tasks.forEach((t) => { if (t.projectId === id) t.projectId = null; });
    });
    ui.openProject = null; render();
  },
  'to-project': (el) => {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    if (!t) return;
    const p = addProject({ title: t.title });
    updateTask(t.id, { projectId: p.id, list: 'next' });
    ui.open = null; ui.openProject = p.id;
    location.hash = '#/projects';
  },

  'new-goal': () => addGoal({ title: '' }),
  'set-top': (el) => commit((s) => s.goals.forEach((g) => { g.isTop = g.id === el.dataset.id; })),
  'toggle-horizon': (el) => commit((s) => {
    const g = s.goals.find((x) => x.id === el.dataset.id);
    if (g) g.horizon = g.horizon === 'year' ? 'quarter' : 'year';
  }),
  'del-goal': (el) => {
    if (!confirm('Удалить цель?')) return;
    commit((s) => { s.goals = s.goals.filter((g) => g.id !== el.dataset.id); });
  },

  'toggle-top': (el) => {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    if (t) updateTask(t.id, { topGoal: !t.topGoal });
  },
  'del-task': (el) => { removeTask(el.dataset.id); ui.open = null; render(); },

  'review-step': (el) => {
    const i = Number(el.dataset.i);
    ui.reviewChecked.has(i) ? ui.reviewChecked.delete(i) : ui.reviewChecked.add(i);
    render();
  },
  'finish-review'() {
    commit((s) => {
      s.review.lastAt = new Date().toISOString();
      s.review.history.unshift(s.review.lastAt);
      s.review.history = s.review.history.slice(0, 52);
    });
    ui.reviewChecked = new Set();
    render();
  },
  'reset-review'() { ui.reviewChecked = new Set(); render(); },

  'new-note'() { const n = addNote({}); ui.openNote = n.id; render(); },
  'open-note': (el) => { ui.openNote = el.dataset.id; render(); },
  'close-note': () => { ui.openNote = null; render(); },
  'del-note': (el) => {
    if (!confirm('Удалить конспект?')) return;
    commit((s) => { s.notes = s.notes.filter((n) => n.id !== el.dataset.id); });
    ui.openNote = null; render();
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

  async ping() { await sendToWebhook('ping', { from: 'pult', at: new Date().toISOString() }); },
  async 'create-bot'() {
    const name = $('#bot-name')?.value.trim();
    if (!name) { alert('Укажите название бота'); return; }
    const payload = {
      name,
      brief: $('#bot-brief')?.value.trim() || '',
      channel: $('#bot-channel')?.value,
      model: $('#bot-model')?.value,
      requestedAt: new Date().toISOString(),
      requestId: uid(),
    };
    const entry = await sendToWebhook('bot.create', payload);
    addTask({
      title: `Ботик «${name}» — ждём сборку`,
      list: 'waiting', person: 'Make', note: JSON.stringify(payload, null, 2),
    });
    if (entry.status === 'error') {
      alert('Отправить не удалось: ' + entry.response + '\nЗадача в «Ожидании» всё равно создана.');
    }
  },
  async 'send-task'(el) {
    const t = state.tasks.find((x) => x.id === el.dataset.id);
    if (t) await sendToWebhook('task.send', t);
  },

  theme() {
    const order = ['auto', 'dark', 'light'];
    commit((s) => { s.settings.theme = order[(order.indexOf(s.settings.theme || 'auto') + 1) % 3]; });
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
    const text = $('#md-in')?.value || '';
    const parsed = fromMarkdown(text);
    if (!parsed.length) { alert('В тексте не нашлось строк задач. Строка должна начинаться с «- » или «- [ ] ».'); return; }

    let added = 0, skipped = 0;
    parsed.forEach((t) => {
      if (state.tasks.some((x) => sameTask(x, t.title))) { skipped++; return; }
      const projectId = t.projectName ? findOrCreateProject(t.projectName).id : null;
      addTask({
        title: t.title, list: t.list, context: t.context, projectId,
        person: t.person, due: t.due, minutes: t.minutes, topGoal: t.topGoal,
        doneAt: t.done ? new Date().toISOString() : null,
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

/* ---------- клики ---------- */

let swallowClick = false;

document.addEventListener('click', (e) => {
  if (swallowClick) { swallowClick = false; e.preventDefault(); return; }

  const actEl = e.target.closest('[data-action]');
  if (actEl && ACTIONS[actEl.dataset.action]) {
    if (!['LABEL', 'INPUT'].includes(actEl.tagName)) e.preventDefault();
    ACTIONS[actEl.dataset.action](actEl);
    return;
  }
  const row = e.target.closest('[data-task]');
  if (row) {
    ui.open = ui.open === row.dataset.task ? null : row.dataset.task;
    ui.cursor = row.dataset.task;
    render();
  }
});

/* ---------- редактирование полей ---------- */

const setTask = (k) => (id, v) => updateTask(id, { [k]: v });
const setIn = (coll, k, cast = (v) => v) => (id, v) => commit((s) => {
  const item = s[coll].find((x) => x.id === id);
  if (item) item[k] = cast(v);
});

const EDITS = {
  'task-title': setTask('title'),
  'task-note': setTask('note'),
  'task-context': (id, v) => updateTask(id, { context: v || null }),
  'task-project': (id, v) => updateTask(id, { projectId: v || null }),
  'task-person': setTask('person'),
  'task-due': (id, v) => updateTask(id, { due: v || null }),
  'task-minutes': (id, v) => updateTask(id, { minutes: v ? Number(v) : null }),

  'project-title': setIn('projects', 'title'),
  'project-outcome': setIn('projects', 'outcome'),
  'project-goal': setIn('projects', 'goalId', (v) => v || null),
  'project-status': setIn('projects', 'status'),

  'goal-title': setIn('goals', 'title'),

  'note-title': setIn('notes', 'title'),
  'note-person': setIn('notes', 'person'),
  'note-date': setIn('notes', 'date'),
  'note-project': setIn('notes', 'projectId', (v) => v || null),
  'note-body': setIn('notes', 'body'),

  'webhook-url': (_, v) => commit((s) => { s.settings.webhookUrl = v; }),
  'webhook-token': (_, v) => commit((s) => { s.settings.webhookToken = v; }),
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
    const title = $(`[data-task="${id}"] .row-title`);
    if (title) title.textContent = el.value;
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
    // change приходит в момент blur — до того, как фокус дойдёт до следующего
    // поля. Перерисовать сейчас значит снести поле, куда человек переходит.
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

/* ==========================================================================
   Свайпы по строкам (мобилка)
   ========================================================================== */

let swipe = null;

document.addEventListener('touchstart', (e) => {
  const row = e.target.closest('.row[data-task]');
  if (!row || ui.open) return;
  swipe = { row, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, live: false };
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  const dx = e.touches[0].clientX - swipe.x;
  const dy = e.touches[0].clientY - swipe.y;
  if (!swipe.live) {
    if (Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }   // это вертикальный скролл
    if (Math.abs(dx) < 10) return;
    swipe.live = true;
    swipe.row.style.transition = 'none';
    swipe.row.parentElement?.classList.add('is-swiping');
  }
  e.preventDefault();
  swipe.dx = dx;
  swipe.row.style.transform = `translateX(${dx}px)`;
}, { passive: false });

document.addEventListener('touchend', () => {
  if (!swipe) return;
  const { row, dx, live } = swipe;
  swipe = null;
  row.style.transition = '';
  row.style.transform = '';
  row.parentElement?.classList.remove('is-swiping');
  if (!live) return;
  swallowClick = true;
  const id = row.dataset.task;
  if (dx > 80) toggleDone(id);
  else if (dx < -80) updateTask(id, { due: tomorrow(), list: 'next' });
});

/* ==========================================================================
   Клавиатура (десктоп)
   ========================================================================== */

function moveCursor(step) {
  const ids = $$('[data-task]').map((el) => el.dataset.task);
  if (!ids.length) return;
  const i = ids.indexOf(ui.cursor);
  ui.cursor = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + step))];
  render();
  $(`[data-task="${ui.cursor}"]`)?.scrollIntoView({ block: 'nearest' });
}

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
    const { projectName, ...fields } = parseQuickAdd(e.target.value);
    if (fields.title) addTask({ ...fields, projectId: padd, list: fields.list === 'inbox' ? 'next' : fields.list });
    e.target.value = '';
    render();
    return;
  }
  if (e.target.id === 'capture' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    e.target.blur();
    moveCursor(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Escape') {
    if (ui.open) { ui.open = null; render(); }
    else if (typing) e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === ' ' && ui.cursor) { e.preventDefault(); toggleDone(ui.cursor); }
  else if (e.key === 'Enter' && ui.cursor) {
    e.preventDefault();
    ui.open = ui.open === ui.cursor ? null : ui.cursor;
    render();
  }
  else if (e.key === 'n' || e.key === 'т') { e.preventDefault(); ACTIONS['focus-capture'](); }
});

/* ==========================================================================
   Роутер и запуск
   ========================================================================== */

const ROUTES = new Set([...NAV.flatMap((g) => g.items.map(([r]) => r)), 'more']);

function route() {
  // при переходе в другой раздел фокус не должен возвращаться в поле захвата:
  // человек нажал пункт меню, а не продолжает печатать
  document.activeElement?.blur?.();
  const r = location.hash.replace(/^#\/?/, '') || 'today';
  ui.route = ROUTES.has(r) ? r : 'today';
  ui.open = null;
  ui.cursor = null;
  if (ui.route !== 'notes') ui.openNote = null;
  if (ui.route !== 'projects') ui.openProject = null;
  render();
  window.scrollTo(0, 0);
  const m = $('.main'); if (m) m.scrollTop = 0;
}

window.addEventListener('hashchange', route);

applyTheme();
route();

// часы тикают только пока идёт сессия и открыт экран с ними
setInterval(() => {
  if (state.topGoal.timerStartedAt && ['today', 'dashboard'].includes(ui.route) && !ui.open && !isTyping()) render();
}, 1000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
