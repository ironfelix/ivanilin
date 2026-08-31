/* Хранилище GTD-админки.
   Данные живут в localStorage браузера — на сервер ничего не уходит,
   пока вы сами не нажмёте «Отправить» в разделе «Боты». */

const KEY = 'ivanilin.gtd.v1';

export const CONTEXTS = [
  { id: 'comp',     label: '@комп',     hint: 'за компьютером' },
  { id: 'calls',    label: '@звонки',   hint: 'позвонить' },
  { id: 'phone',    label: '@смартфон', hint: 'можно с телефона' },
  { id: 'home',     label: '@дом',      hint: 'дома' },
  { id: 'errands',  label: '@город',    hint: 'по пути / поручения' },
  { id: 'anywhere', label: '@везде',    hint: 'где угодно' },
];

export const LISTS = {
  inbox:   { title: 'Инбокс',       one: 'В инбокс' },
  next:    { title: 'Next actions', one: 'В действия' },
  waiting: { title: 'Ожидание',     one: 'В ожидание' },
  agenda:  { title: 'Agenda',       one: 'В повестку' },
  someday: { title: 'Когда-нибудь', one: 'В когда-нибудь' },
  done:    { title: 'Сделано',      one: 'Готово' },
};

export const LADDER = [30, 45, 60, 90, 120];

const EMPTY = () => ({
  version: 1,
  tasks: [],
  projects: [],
  goals: [],
  notes: [],
  topGoal: { ladder: 30, log: {} },          // log: { '2026-08-31': минуты }
  review: { lastAt: null, history: [] },
  settings: { theme: 'auto', webhookUrl: '', webhookToken: '', seoUrl: '/seo-status/' },
  outbox: [],                                 // журнал отправок в Make
  updatedAt: null,
});

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const todayISO = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};

export const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

export const daysSince = (iso) => (iso ? daysBetween(iso.slice(0, 10), todayISO()) : null);

export const plural = (n, one, few, many) => {
  const m = Math.abs(n) % 100, d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
};

/* ---------- загрузка / сохранение ---------- */

function migrate(raw) {
  const base = EMPTY();
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw };
  s.topGoal = { ...base.topGoal, ...(raw.topGoal || {}) };
  s.review = { ...base.review, ...(raw.review || {}) };
  s.settings = { ...base.settings, ...(raw.settings || {}) };
  for (const k of ['tasks', 'projects', 'goals', 'notes', 'outbox']) {
    if (!Array.isArray(s[k])) s[k] = [];
  }
  return s;
}

function read() {
  try {
    return migrate(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return EMPTY();
  }
}

/** Разовый перенос из предыдущего пульта, который жил на этом же адресе
    и хранил данные под своими ключами. Выполняется один раз и только
    когда собственных данных ещё нет — чужое ничего не затирает. */
let legacyJustRan = false;

function importLegacy(s) {
  if (s.legacyImported) return s;
  s.legacyImported = true;
  legacyJustRan = true;
  if (s.tasks.length || s.notes.length) return s;

  const grab = (a, b) => {
    for (const key of [a, b]) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch {}
    }
    return [];
  };

  const WHEN = { today: 'next', next: 'next', later: 'someday' };
  const AREA = { high: 'высокий', medium: 'средний', low: 'низкий' };

  for (const t of grab('ivan-pult-tasks-v2', 'ivan-pult-tasks-v1')) {
    if (!t || !t.title) continue;
    const notes = [t.details, t.area && `Область: ${t.area}`,
                   t.priority === 'high' && `Приоритет: ${AREA.high}`]
      .filter(Boolean).join('\n');
    s.tasks.push({
      id: uid(),
      title: String(t.title),
      note: notes,
      list: t.done ? 'done' : (WHEN[t.when] || 'inbox'),
      context: null,
      projectId: null,
      person: '',
      due: t.when === 'today' && !t.done ? todayISO() : null,
      minutes: null,
      topGoal: false,
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      doneAt: t.done ? new Date().toISOString() : null,
    });
  }

  for (const n of grab('ivan-pult-notes-v2', 'ivan-pult-notes-v1')) {
    const text = typeof n === 'string' ? n : (n && (n.text || n.body)) || '';
    if (!text.trim()) continue;
    const [first, ...rest] = text.split('\n');
    s.notes.push({
      id: uid(),
      title: first.slice(0, 80),
      person: '',
      projectId: null,
      date: (n && n.createdAt ? n.createdAt : new Date().toISOString()).slice(0, 10),
      body: rest.length ? text : '',
      createdAt: (n && n.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return s;
}

export const state = importLegacy(read());

// закрепляем факт переноса сразу: иначе при следующем открытии,
// если человек ничего не менял, задачи импортировались бы повторно
if (legacyJustRan) persist();

const listeners = new Set();
let saveTimer = null;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Единственный способ менять состояние: commit(s => { ... }). */
export function commit(mutator) {
  const result = mutator(state);
  state.updatedAt = new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 200);
  listeners.forEach((fn) => fn(state));
  return result;
}

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Не удалось сохранить в localStorage', e);
  }
}

window.addEventListener('beforeunload', persist);

/* ---------- задачи ---------- */

export function addTask(patch = {}) {
  const task = {
    id: uid(),
    title: '',
    note: '',
    list: 'inbox',
    context: null,
    projectId: null,
    person: '',
    due: null,
    minutes: null,
    topGoal: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: null,
    ...patch,
  };
  commit((s) => s.tasks.unshift(task));
  return task;
}

export function updateTask(id, patch) {
  commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  });
}

export function toggleDone(id) {
  commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.list === 'done') {
      t.list = t.prevList || 'next';
      t.doneAt = null;
    } else {
      t.prevList = t.list;
      t.list = 'done';
      t.doneAt = new Date().toISOString();
    }
    t.updatedAt = new Date().toISOString();
  });
}

export function removeTask(id) {
  commit((s) => {
    s.tasks = s.tasks.filter((x) => x.id !== id);
  });
}

/* ---------- проекты, цели, конспекты ---------- */

export function addProject(patch = {}) {
  const p = {
    id: uid(),
    title: '',
    outcome: '',
    goalId: null,
    status: 'active',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    ...patch,
  };
  commit((s) => s.projects.unshift(p));
  return p;
}

export function findOrCreateProject(title) {
  const norm = title.trim().toLowerCase();
  const hit = state.projects.find((p) => p.title.trim().toLowerCase() === norm);
  return hit || addProject({ title: title.trim() });
}

export function addGoal(patch = {}) {
  const g = { id: uid(), title: '', horizon: 'year', isTop: false, createdAt: new Date().toISOString(), ...patch };
  commit((s) => s.goals.unshift(g));
  return g;
}

export function addNote(patch = {}) {
  const n = {
    id: uid(),
    title: '',
    person: '',
    projectId: null,
    date: todayISO(),
    body: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  commit((s) => s.notes.unshift(n));
  return n;
}

/* ---------- срезы для дашборда ---------- */

export const openTasks = () => state.tasks.filter((t) => t.list !== 'done');

export const byList = (list) =>
  state.tasks.filter((t) => t.list === list).sort((a, b) => {
    if (!!b.topGoal !== !!a.topGoal) return b.topGoal - a.topGoal;
    const ad = a.due || '9999', bd = b.due || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return b.createdAt < a.createdAt ? -1 : 1;
  });

export const projectTasks = (projectId) =>
  state.tasks.filter((t) => t.projectId === projectId && t.list !== 'done');

/** Проекты без следующего действия — главный сигнал сбоя системы в GTD. */
export const stalledProjects = () =>
  state.projects.filter(
    (p) => p.status === 'active' && !state.tasks.some((t) => t.projectId === p.id && t.list === 'next')
  );

export const staleWaiting = (days = 7) =>
  byList('waiting').filter((t) => (daysSince(t.updatedAt) ?? 0) >= days);

export const overdue = () =>
  openTasks().filter((t) => t.due && t.due < todayISO());

export const dueToday = () =>
  openTasks().filter((t) => t.due && t.due <= todayISO());

export const doneSince = (days) => {
  const edge = new Date(Date.now() - days * 86400000).toISOString();
  return state.tasks.filter((t) => t.doneAt && t.doneAt >= edge);
};

export const topGoalToday = () => state.topGoal.log[todayISO()] || 0;

export const topGoalStreak = () => {
  let streak = 0;
  for (let i = 0; ; i++) {
    const day = todayISO(new Date(Date.now() - i * 86400000));
    const min = state.topGoal.log[day] || 0;
    if (min >= state.topGoal.ladder) streak++;
    else if (i > 0 || min === 0) break;
  }
  return streak;
};

export function logTopGoal(minutes, day = todayISO()) {
  commit((s) => {
    s.topGoal.log[day] = Math.max(0, (s.topGoal.log[day] || 0) + minutes);
    if (!s.topGoal.log[day]) delete s.topGoal.log[day];
  });
}

/* ---------- экспорт / импорт ---------- */

export function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gtd-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importJSON(file) {
  const parsed = migrate(JSON.parse(await file.text()));
  commit((s) => Object.assign(s, parsed));
  persist();
}

/* ---------- интеграция наружу (Make / n8n / любой вебхук) ---------- */

/** Content-Type: text/plain — чтобы браузер не слал preflight и вебхук
    принимал запрос без настройки CORS. Тело всё равно JSON. */
export async function sendToWebhook(event, payload) {
  const url = state.settings.webhookUrl.trim();
  const entry = {
    id: uid(),
    at: new Date().toISOString(),
    event,
    payload,
    status: 'pending',
    response: '',
  };
  commit((s) => s.outbox.unshift(entry));

  if (!url) {
    commit(() => { entry.status = 'error'; entry.response = 'Не задан URL вебхука'; });
    return entry;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ event, token: state.settings.webhookToken || undefined, payload }),
    });
    const text = (await res.text()).slice(0, 300);
    commit(() => {
      entry.status = res.ok ? 'ok' : 'error';
      entry.response = `${res.status} ${text}`;
    });
  } catch (e) {
    commit(() => {
      entry.status = 'error';
      entry.response = String(e.message || e);
    });
  }
  return entry;
}
