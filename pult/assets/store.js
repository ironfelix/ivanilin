/* Хранилище GTD-админки.
   Источник правды — база на сервере (/pult/api/), localStorage работает
   офлайн-кешем: без сети пульт открывается и пишет, правки уезжают позже.
   Пока токен Майка не задан, сервер не используется вовсе — всё как раньше,
   только в этом браузере. */

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

/** Майк — главный агент. Живёт на этом же домене (мост /mike/), поэтому
    из настроек ему нужен только токен: адреса зашиты, CORS не существует. */
const mikeAgent = () => ({
  id: 'mike', kind: 'mike', name: 'Майк', url: '', token: '', main: true,
});

const EMPTY = () => ({
  version: 1,
  tasks: [],
  projects: [],
  goals: [],
  notes: [],
  topGoal: { ladder: 30, log: {} },          // log: { '2026-08-31': минуты }
  review: { lastAt: null, history: [] },
  settings: { theme: 'auto', seoUrl: '/seo-status/', agents: [mikeAgent()] },
  outbox: [],                                 // журнал отправок агентам
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
  // агенты: Майк присутствует всегда, старый одиночный вебхук переезжает в список
  if (!Array.isArray(s.settings.agents)) s.settings.agents = [];
  if (!s.settings.agents.some((a) => a.kind === 'mike')) s.settings.agents.unshift(mikeAgent());
  const legacyUrl = (raw.settings || {}).webhookUrl;
  if (legacyUrl && !s.settings.agents.some((a) => a.url === legacyUrl)) {
    s.settings.agents.push({
      id: uid(), kind: 'webhook', name: 'Вебхук', url: legacyUrl,
      token: (raw.settings || {}).webhookToken || '', main: false,
    });
  }
  delete s.settings.webhookUrl;
  delete s.settings.webhookToken;
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

/* Мутации помечают изменённое для синхронизации. Хук, а не прямой вызов:
   markDirty объявлен ниже по файлу, а модуль исполняется сверху вниз. */
const touch = (kind, id) => { try { markDirty(kind, id); } catch {} };

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
  touch('tasks', task.id);
  return task;
}

export function updateTask(id, patch) {
  commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  });
  touch('tasks', id);
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
  touch('tasks', id);
}

export function removeTask(id) {
  commit((s) => {
    s.tasks = s.tasks.filter((x) => x.id !== id);
  });
  touch('tasks', id);   // удаление уезжает как строка с deleted
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
  touch('projects', p.id);
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
  touch('goals', g.id);
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
  touch('notes', n.id);
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
    else if (i > 0) break;
    // сегодняшний недобор (в т.ч. 0 утром) серию не рвёт — день ещё не кончился
  }
  return streak;
};

export function logTopGoal(minutes, day = todayISO()) {
  touch('kv');
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

/* ---------- агенты ---------- */

/* Майк — hermes-агент на этом же домене: пульт говорит с ним обычным
   чатом (формат OpenAI) и читает его файлы через мост. Остальные агенты —
   вебхуки: POST c text/plain, чтобы обойтись без CORS-preflight. */

const MIKE_CHAT = '/mike/v1/chat/completions';
const MIKE_CONTEXT = '/mike/context/';

export const agents = () => state.settings.agents;
export const mike = () => agents().find((a) => a.kind === 'mike');
/** Агенты, которым реально можно отправить: у Майка есть токен, у вебхука — URL. */
export const readyAgents = () =>
  agents().filter((a) => (a.kind === 'mike' ? a.token.trim() : a.url.trim()));

export function addAgent() {
  const a = { id: uid(), kind: 'webhook', name: 'Новый агент', url: '', token: '', main: false };
  commit((s) => s.settings.agents.push(a));
  return a;
}

export function removeAgent(id) {
  commit((s) => {
    s.settings.agents = s.settings.agents.filter((a) => a.id !== id || a.kind === 'mike');
  });
}

/** Письмо Майку: человекочитаемый текст, из которого агент сам заведёт
    задачу, сохранит конспект или возьмёт поручение в работу. */
function mikeMessage(event, p) {
  if (event === 'ping') {
    return 'Проверка связи из пульта (ivanilin.ru/pult). Ответь одной короткой фразой.';
  }
  if (event === 'task.send') {
    const bits = [
      p.due && `срок: ${p.due}`, p.person && `человек: ${p.person}`,
      p.projectTitle && `проект: ${p.projectTitle}`, p.minutes && `оценка: ${p.minutes} мин`,
    ].filter(Boolean).join(', ');
    return `Задача из пульта Ивана:\n«${p.title}»${bits ? `\n(${bits})` : ''}` +
      (p.note ? `\nЗаметка: ${p.note}` : '') +
      '\n\nЗаведи её у себя (TODO/Todoist) и подтверди одной строкой.';
  }
  if (event === 'note.send') {
    return `Конспект из пульта Ивана — сохрани к себе в konspekty/ и подтверди одной строкой.\n\n` +
      `# ${p.title || 'Без названия'}\n` +
      [p.person && `Кто: ${p.person}`, p.date && `Дата: ${p.date}`].filter(Boolean).join(' · ') +
      `\n\n${p.body}`;
  }
  if (event === 'errand') {
    return `Поручение из пульта Ивана:\n\n${p.text}\n\n` +
      'Возьми в работу; если чего-то не хватает — спроси Ивана в Telegram.';
  }
  return JSON.stringify(p);
}

export async function sendToAgent(agent, event, payload) {
  const entry = {
    id: uid(), at: new Date().toISOString(),
    agentId: agent.id, agentName: agent.name,
    event, payload, status: 'pending', response: '',
  };
  // журнал не растёт бесконечно: localStorage общий с задачами
  commit((s) => { s.outbox.unshift(entry); s.outbox = s.outbox.slice(0, 50); });

  try {
    let res, reply;
    if (agent.kind === 'mike') {
      if (!agent.token.trim()) throw new Error('Не задан токен Майка');
      res = await fetch(MIKE_CHAT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + agent.token.trim(),
        },
        body: JSON.stringify({
          model: 'hermes-agent',
          messages: [{ role: 'user', content: mikeMessage(event, payload) }],
        }),
      });
      const data = await res.json().catch(() => null);
      reply = data?.choices?.[0]?.message?.content || data?.error?.message || '';
    } else {
      if (!agent.url.trim()) throw new Error('Не задан URL агента');
      res = await fetch(agent.url.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ event, token: agent.token.trim() || undefined, payload }),
      });
      reply = await res.text();
    }
    commit(() => {
      entry.status = res.ok ? 'ok' : 'error';
      entry.response = (res.ok ? '' : res.status + ' ') + reply.trim().slice(0, 300);
    });
  } catch (e) {
    commit(() => {
      entry.status = 'error';
      entry.response = String(e.message || e);
    });
  }
  return entry;
}

/* ---------- синхронизация с сервером ---------- */

/* Источник правды — база на сервере (/pult/api/). localStorage остаётся
   офлайн-кешем: пульт открывается и работает без сети, а накопленные правки
   уезжают, когда связь вернётся. Порядок правок разводим по номеру ревизии,
   а не по времени — часы у телефона и ноутбука разные. */

const SYNCED = ['tasks', 'projects', 'goals', 'notes'];

export const sync = {
  rev: 0, at: null, status: 'idle', error: '',   // idle|off|syncing|ok|error
  dirty: { tasks: new Set(), projects: new Set(), goals: new Set(), notes: new Set(), kv: false },
};

const syncListeners = new Set();
export const onSync = (fn) => { syncListeners.add(fn); return () => syncListeners.delete(fn); };
const emitSync = () => syncListeners.forEach((fn) => fn(sync));

/** Помечаем изменённое, чтобы не гонять всю базу на каждый чих. */
export function markDirty(kind, id) {
  if (kind === 'kv') sync.dirty.kv = true;
  else sync.dirty[kind]?.add(id);
  scheduleSync();
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 1500);
}

const authHeaders = () => {
  const m = mike();
  return m?.token.trim() ? { Authorization: 'Bearer ' + m.token.trim() } : null;
};

function applyIncoming(data) {
  for (const kind of SYNCED) {
    for (const item of data[kind] || []) {
      const arr = state[kind];
      const i = arr.findIndex((x) => x.id === item.id);
      if (item.deleted) { if (i >= 0) arr.splice(i, 1); continue; }
      // свои несохранённые правки чужими не затираем
      if (sync.dirty[kind].has(item.id)) continue;
      if (i >= 0) Object.assign(arr[i], item); else arr.push(item);
    }
  }
  for (const [k, v] of Object.entries(data.kv || {})) {
    if (k === 'topGoal' && !sync.dirty.kv) state.topGoal = v;
    if (k === 'review' && !sync.dirty.kv) state.review = v;
  }
  sync.rev = data.rev;
}

export async function syncNow() {
  const headers = authHeaders();
  if (!headers) { sync.status = 'off'; emitSync(); return; }
  if (sync.status === 'syncing') { scheduleSync(); return; }
  sync.status = 'syncing'; emitSync();

  try {
    // 1) отдаём накопленное
    const payload = {};
    let has = false;
    for (const kind of SYNCED) {
      const ids = sync.dirty[kind];
      if (!ids.size) continue;
      payload[kind] = [...ids].map((id) => {
        const item = state[kind].find((x) => x.id === id);
        return item ? { ...item } : { id, deleted: true };
      });
      has = true;
    }
    if (sync.dirty.kv) {
      payload.kv = { topGoal: state.topGoal, review: state.review };
      has = true;
    }
    const sending = { tasks: new Set(sync.dirty.tasks), projects: new Set(sync.dirty.projects),
                      goals: new Set(sync.dirty.goals), notes: new Set(sync.dirty.notes), kv: sync.dirty.kv };
    if (has) {
      const res = await fetch('/pult/api/push', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('push ' + res.status + (res.status === 403 ? ' — проверьте токен' : ''));
      // отправленное вычищаем, но только его: пока шёл запрос, могли добавиться новые
      for (const kind of SYNCED) sending[kind].forEach((id) => sync.dirty[kind].delete(id));
      if (sending.kv) sync.dirty.kv = false;
    }

    // 2) забираем чужое
    const res = await fetch(`/pult/api/pull?since=${sync.rev}`, { headers });
    if (!res.ok) throw new Error('pull ' + res.status + (res.status === 403 ? ' — проверьте токен' : ''));
    applyIncoming(await res.json());

    sync.status = 'ok'; sync.error = ''; sync.at = new Date().toISOString();
    persist();
    listeners.forEach((fn) => fn(state));
  } catch (e) {
    sync.status = 'error';
    sync.error = String(e.message || e);
  }
  emitSync();
}

/** Первый заход: подтянуть базу и, если локально что-то есть, отдать своё. */
export async function syncBoot() {
  if (!authHeaders()) { sync.status = 'off'; emitSync(); return; }
  // всё локальное считаем неотправленным — сервер разрулит по updatedAt
  for (const kind of SYNCED) state[kind].forEach((x) => sync.dirty[kind].add(x.id));
  sync.dirty.kv = true;
  await syncNow();
}

window.addEventListener('online', () => scheduleSync());

/** Чтение файлов Майка через мост (журнал, TODO.md, конспекты). */
export async function mikeFetch(path) {
  const m = mike();
  if (!m?.token.trim()) throw new Error('Не задан токен Майка — раздел «Агенты»');
  const res = await fetch(MIKE_CONTEXT + path, {
    headers: { Authorization: 'Bearer ' + m.token.trim() },
  });
  if (!res.ok) throw new Error('Мост ответил ' + res.status + (res.status === 403 ? ' — проверьте токен' : ''));
  return res.text();
}
