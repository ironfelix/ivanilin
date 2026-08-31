/* Разбор строки быстрого захвата.
   «Позвонить Пете по смете #Ремонт @звонки !завтра *»  */

import { CONTEXTS, todayISO } from './store.js';

const CONTEXT_WORDS = {
  комп: 'comp', пк: 'comp', comp: 'comp', mac: 'comp',
  звонки: 'calls', звонок: 'calls', позвонить: 'calls', calls: 'calls',
  смартфон: 'phone', телефон: 'phone', phone: 'phone',
  дом: 'home', home: 'home',
  город: 'errands', errands: 'errands', поручения: 'errands',
  везде: 'anywhere', anywhere: 'anywhere',
};

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function parseDate(word) {
  const w = word.toLowerCase();
  const now = new Date();
  const shift = (n) => todayISO(new Date(now.getTime() + n * 86400000));

  if (w === 'сегодня' || w === 'today') return shift(0);
  if (w === 'завтра' || w === 'tomorrow') return shift(1);
  if (w === 'послезавтра') return shift(2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;

  const dm = w.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/);
  if (dm) {
    const year = dm[3] ? Number(dm[3].length === 2 ? '20' + dm[3] : dm[3]) : now.getFullYear();
    const d = new Date(year, Number(dm[2]) - 1, Number(dm[1]));
    if (!dm[3] && d < now) d.setFullYear(year + 1);
    return todayISO(d);
  }

  const wd = WEEKDAYS.indexOf(w.slice(0, 2));
  if (wd >= 0 && w.length <= 3) {
    let diff = (wd - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return shift(diff);
  }
  return null;
}

export function parseQuickAdd(input) {
  const out = { title: '', list: 'inbox', context: null, projectName: null, person: '', due: null, minutes: null, topGoal: false };
  const rest = [];

  for (const raw of input.trim().split(/\s+/)) {
    const tag = raw.slice(1);

    if (raw === '*') { out.topGoal = true; continue; }

    // одиночный маркер через пробел: «? Аня пришлёт смету», «> обсудить бюджет»
    if (raw === '?') { out.list = 'waiting'; continue; }
    if (raw === '>') { out.list = 'agenda'; continue; }

    if (raw.startsWith('@') && tag) {
      const key = tag.toLowerCase();
      out.context = CONTEXT_WORDS[key] || (CONTEXTS.some((c) => c.id === key) ? key : null);
      if (out.context) { if (out.list === 'inbox') out.list = 'next'; continue; }
    }
    if (raw.startsWith('#') && tag) { out.projectName = tag.replace(/_/g, ' '); continue; }
    if (raw.startsWith('?') && tag) { out.person = tag; out.list = 'waiting'; continue; }
    if (raw.startsWith('>') && tag) { out.person = tag; out.list = 'agenda'; continue; }
    if (raw.startsWith('~')) {
      if (!tag || /^когда/i.test(tag)) { out.list = 'someday'; continue; }
    }
    if (raw.startsWith('!') && tag) {
      const d = parseDate(tag);
      if (d) { out.due = d; if (out.list === 'inbox') out.list = 'next'; continue; }
    }
    if (raw.startsWith('+') && tag) {
      const m = tag.match(/^(\d+)\s*(м|min|m)?$/i) || tag.match(/^(\d+)\s*(ч|h)$/i);
      if (m) { out.minutes = /ч|h/i.test(m[2] || '') ? Number(m[1]) * 60 : Number(m[1]); continue; }
    }
    rest.push(raw);
  }

  out.title = rest.join(' ').trim();
  return out;
}

/** Разбор конспекта на действия: строки, начинающиеся с -, ?, > */
export function parseNoteLines(body) {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-•*?>]\s*\S/.test(l) || /^\[\s?\]/.test(l))
    .map((l) => {
      const marker = l[0];
      const text = l.replace(/^[-•*?>]\s*/, '').replace(/^\[\s?\]\s*/, '');
      const parsed = parseQuickAdd(text);
      if (marker === '?' && !parsed.person) parsed.list = 'waiting';
      if (marker === '>' && !parsed.person) parsed.list = 'agenda';
      if (parsed.list === 'inbox') parsed.list = 'next';
      return parsed;
    })
    .filter((p) => p.title);
}
