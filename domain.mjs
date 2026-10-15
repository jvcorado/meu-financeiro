/** Shared financial engine. All currency amounts are integer cents; dates are civil ISO dates. */
export const categories = Object.freeze([
  { id: 'income', label: 'Entradas', singular: 'Entrada', color: '#22c55e', symbol: '+' },
  { id: 'expense', label: 'Saídas', singular: 'Saída', color: '#ef4444', symbol: '−' },
  { id: 'daily', label: 'Diários', singular: 'Diário', color: '#ec4899', symbol: '−' },
  { id: 'saving', label: 'Economias', singular: 'Economia', color: '#a3e635', symbol: '−' },
  { id: 'card', label: 'Cartão', singular: 'Cartão', color: '#a855f7', symbol: '−' },
]);

const DAY = 86400000;
const MAX_DAYS = 36600;
const typeIds = new Set(categories.map(c => c.id));
const emptyTotals = () => Object.fromEntries(categories.map(c => [c.id, 0]));
const pad = n => String(n).padStart(2, '0');

function dateObject(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Data inválida.');
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError('Data inválida.');
  return date;
}
const iso = date => date.toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((dateObject(b) - dateObject(a)) / DAY);

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthStart(value = todayISO()) {
  dateObject(value);
  return `${value.slice(0, 7)}-01`;
}

export function monthEnd(value = todayISO()) {
  const d = dateObject(value);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return iso(d);
}

/** Call with the original anchor for each recurrence, so Jan 31 returns to Mar 31. */
export function addMonths(value, count) {
  const d = dateObject(value), anchor = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(count));
  const last = Number(monthEnd(iso(d)).slice(-2));
  d.setUTCDate(Math.min(anchor, last));
  return iso(d);
}

export function addDays(value, count) {
  const d = dateObject(value);
  d.setUTCDate(d.getUTCDate() + Number(count));
  return iso(d);
}

const formatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function money(cents) {
  return formatter.format((Number.isFinite(Number(cents)) ? Number(cents) : 0) / 100);
}

/** Accepts BRL input (1.234,56), plain decimal (1234.56), or numeric currency units. */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : 0;
  let text = String(value ?? '').trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (!text) return 0;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(text) || text === '-' || text === '.') return 0;
  const result = Math.round(Number(text) * 100);
  return Number.isSafeInteger(result) ? result : 0;
}

function validDate(value) {
  try { dateObject(value); return true; } catch { return false; }
}

function occurrenceCount(m) {
  if (!m.repeat || m.repeat === 'none') return 1;
  if (m.count === null || m.count === undefined || m.count === '') return m.repeat === 'installments' ? 1 : Infinity;
  return Math.max(0, Math.floor(Number(m.count) || 0));
}

function occurrenceDate(m, index) {
  if (m.repeat === 'daily') return addDays(m.date, index);
  if (m.repeat === 'weekly') return addDays(m.date, index * 7);
  if (m.repeat === 'monthly' || m.repeat === 'installments') {
    const month = addMonths(monthStart(m.date), index);
    const anchor = m.recurrenceAnchorDay || Number(m.date.slice(-2));
    return `${month.slice(0, 7)}-${pad(Math.min(anchor, Number(monthEnd(month).slice(-2))))}`;
  }
  return m.date;
}

function firstIndex(m, start) {
  if (start <= m.date) return 0;
  if (m.repeat === 'daily') return Math.max(0, dayDiff(m.date, start));
  if (m.repeat === 'weekly') return Math.max(0, Math.floor(dayDiff(m.date, start) / 7));
  if (m.repeat === 'monthly' || m.repeat === 'installments') {
    const a = dateObject(m.date), b = dateObject(start);
    return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth());
  }
  return 0;
}

function makeOccurrence(m, index, count) {
  const exception = m.exceptions?.[index];
  if (exception?.deleted) return null;
  let amount = Math.round(Number(m.amount) || 0);
  if (m.repeat === 'installments') {
    const sign = Math.sign(amount), absolute = Math.abs(amount);
    amount = sign * (Math.floor(absolute / count) + (index < absolute % count ? 1 : 0));
  }
  const occurrence = { ...m, date: occurrenceDate(m, index), amount, ...exception,
    id: m.id, sourceId: m.id, index, key: `${m.id}:${index}` };
  return validDate(occurrence.date) && typeIds.has(occurrence.type) ? occurrence : null;
}

function checkRange(start, end) {
  dateObject(start); dateObject(end);
  if (end < start) return false;
  if (dayDiff(start, end) > MAX_DAYS) throw new RangeError('Consulte no máximo 100 anos por vez.');
  return true;
}

/** Generate only the requested interval, including exceptions moved into it. */
export function expandMovements(state, start, end) {
  if (!checkRange(start, end)) return [];
  const result = [];
  for (const m of state.movements ?? []) {
    if (!validDate(m.date) || !typeIds.has(m.type)) continue;
    const count = occurrenceCount(m);
    const seen = new Set();
    const append = index => {
      if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return;
      seen.add(index);
      const occurrence = makeOccurrence(m, index, count);
      if (occurrence && occurrence.date >= start && occurrence.date <= end) result.push(occurrence);
    };
    for (let index = firstIndex(m, start); index < count; index++) {
      const date = occurrenceDate(m, index);
      if (date > end) break;
      append(index);
      if (!['daily', 'weekly', 'monthly', 'installments'].includes(m.repeat)) break;
    }
    // An occurrence originally outside the visible range may have been moved into it.
    for (const [key, exception] of Object.entries(m.exceptions ?? {})) {
      if (exception.date >= start && exception.date <= end) append(Number(key));
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || String(a.sourceId).localeCompare(String(b.sourceId)) || a.index - b.index);
}

/** Proposed conflict policy: one explicit exclusion takes precedence over inclusions. */
export function isEligible(occurrence, state, metric) {
  const ids = new Set(occurrence.tagIds ?? []);
  return !(state.tags ?? []).some(tag => ids.has(tag.id) && tag.rules?.[metric] === false);
}

export function forecastDaily(state) {
  const divisor = Number(state.preferences?.forecastDivisor) || 30;
  const total = (state.forecastItems ?? []).reduce((sum, item) => sum + Math.round(Number(item.amount) || 0), 0);
  return Math.round(total / Math.max(1, divisor));
}

const delta = totals => totals.income - totals.expense - totals.daily - totals.saving - totals.card;

/** Number of original occurrences strictly before a civil date, without materializing history. */
function countBefore(source, date) {
  if (source.date >= date) return 0;
  const count = occurrenceCount(source);
  if (!['daily', 'weekly', 'monthly', 'installments'].includes(source.repeat)) return Math.min(1, count);
  let index = firstIndex(source, date);
  if (index < count && occurrenceDate(source, index) < date) index++;
  return Math.min(index, count);
}

function historicalBalance(state, before) {
  let total = Math.round(Number(state.openingBalance) || 0);
  for (const source of state.movements ?? []) {
    if (!validDate(source.date) || !typeIds.has(source.type)) continue;
    const count = occurrenceCount(source), prefix = countBefore(source, before);
    const sign = source.type === 'income' ? 1 : -1;
    const eligible = isEligible(source, state, 'balance');
    if (eligible && prefix) {
      total += sign * (source.repeat === 'installments'
        ? installmentPrefix(source.amount, count, prefix)
        : Math.round(Number(source.amount) || 0) * prefix);
    }
    // Replace each affected base occurrence with its override; moved dates may cross the cutoff.
    for (const [key, override] of Object.entries(source.exceptions ?? {})) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= count) continue;
      if (index < prefix && eligible) {
        const base = source.repeat === 'installments'
          ? installmentPrefix(source.amount, count, index + 1) - installmentPrefix(source.amount, count, index)
          : Math.round(Number(source.amount) || 0);
        total -= sign * base;
      }
      if (!override.deleted) {
        const occurrence = makeOccurrence(source, index, count);
        if (occurrence && occurrence.date < before && isEligible(occurrence, state, 'balance')) {
          total += (occurrence.type === 'income' ? 1 : -1) * occurrence.amount;
        }
      }
    }
  }
  return total;
}

/** Carries historical cash into the visible range. Forecast and future actuals are additive. */
export function project(state, start, end, today = todayISO()) {
  if (!checkRange(start, end)) return [];
  dateObject(today);
  const occurrences = expandMovements(state, start, end);
  const byDate = new Map();
  let balance = historicalBalance(state, start);
  for (const occurrence of occurrences) {
    if (!byDate.has(occurrence.date)) byDate.set(occurrence.date, []);
    byDate.get(occurrence.date).push(occurrence);
  }
  const forecast = forecastDaily(state);
  // Forecast begins tomorrow even if no movement has ever been entered.
  if (start > addDays(today, 1)) balance -= dayDiff(addDays(today, 1), start) * forecast;
  const days = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const list = byDate.get(date) ?? [], totals = emptyTotals(), eligible = emptyTotals();
    for (const occurrence of list) {
      totals[occurrence.type] += occurrence.amount;
      if (isEligible(occurrence, state, 'balance')) eligible[occurrence.type] += occurrence.amount;
    }
    const dailyForecast = date > today ? forecast : 0;
    balance += delta(eligible) - dailyForecast;
    days.push({ date, totals, forecast: dailyForecast, balance, occurrences: list });
  }
  return days;
}

export function metrics(state, start, end, today = todayISO(), annual = false) {
  const raw = emptyTotals();
  if (!checkRange(start, end)) return { ...raw, forecast: 0, performance: 0, cost: 0, saved: null, average: 0,
    savedIncome: 0, savedSaving: 0, averageDaily: 0 };
  dateObject(today);
  const sets = Object.fromEntries(['performance', 'cost', 'saved', 'average'].map(metric => [metric, emptyTotals()]));
  for (const occurrence of expandMovements(state, start, end)) {
    raw[occurrence.type] += occurrence.amount;
    for (const [metric, totals] of Object.entries(sets)) {
      if (isEligible(occurrence, state, metric)) totals[occurrence.type] += occurrence.amount;
    }
  }
  const futureStart = start > today ? start : addDays(today, 1);
  const forecast = futureStart <= end ? (dayDiff(futureStart, end) + 1) * forecastDaily(state) : 0;
  // Preserve the observed current-month versus annual-screen divisor difference.
  const divisorEnd = !annual && today >= start && today <= end ? today : end;
  const divisor = Math.max(1, dayDiff(start, divisorEnd) + 1);
  return {
    ...raw, forecast,
    performance: delta(sets.performance) - forecast,
    cost: sets.cost.expense + sets.cost.daily + sets.cost.card + forecast,
    saved: sets.saved.income === 0 ? null : 100 * sets.saved.saving / sets.saved.income,
    average: Math.round(sets.average.daily / divisor),
    savedIncome: sets.saved.income,
    savedSaving: sets.saved.saving,
    averageDaily: sets.average.daily,
  };
}

/** Closing-day purchases belong to that closing cycle. This boundary is a proposed rule. */
export function cardDueDate(purchaseDate, card) {
  dateObject(purchaseDate);
  if (!card) return purchaseDate;
  const closing = Math.min(31, Math.max(1, Number(card.closingDay) || 1));
  const due = Math.min(31, Math.max(1, Number(card.dueDay) || 1));
  const currentClose = `${purchaseDate.slice(0, 7)}-${pad(Math.min(closing, Number(monthEnd(purchaseDate).slice(-2))))}`;
  let cycleMonth = monthStart(purchaseDate);
  if (purchaseDate > currentClose) cycleMonth = addMonths(cycleMonth, 1);
  if (due <= closing) cycleMonth = addMonths(cycleMonth, 1);
  return `${cycleMonth.slice(0, 7)}-${pad(Math.min(due, Number(monthEnd(cycleMonth).slice(-2))))}`;
}

/** Resolve a stable key directly, including occurrences rescheduled far from their series. */
export function getOccurrence(state, key) {
  if (typeof key !== 'string') return null;
  const separator = key.lastIndexOf(':');
  if (separator < 0 || !/^\d+$/.test(key.slice(separator + 1))) return null;
  const id = key.slice(0, separator), index = Number(key.slice(separator + 1));
  const source = (state.movements ?? []).find(m => m.id === id);
  if (!source || !validDate(source.date) || !Number.isSafeInteger(index) || index < 0 || index >= occurrenceCount(source)) return null;
  try { return makeOccurrence(source, index, occurrenceCount(source)); } catch { return null; }
}

const editableFields = ['type', 'amount', 'description', 'date', 'tagIds', 'cardId'];
function editable(fields) {
  const result = {};
  for (const field of editableFields) {
    if (fields[field] !== undefined) result[field] = Array.isArray(fields[field]) ? [...fields[field]] : fields[field];
  }
  return result;
}

function mutationTarget(state, sourceId, index, scope) {
  if (!['one', 'future', 'all'].includes(scope)) throw new RangeError('Escopo de alteração inválido.');
  const source = (state.movements ?? []).find(m => m.id === sourceId);
  if (!source || !Number.isInteger(index) || index < 0 || index >= occurrenceCount(source)) return null;
  if (!getOccurrence(state, `${sourceId}:${index}`)) return null;
  return source;
}

/** Sum unmodified base installments in a prefix; overrides remain attached separately. */
function installmentPrefix(total, count, length) {
  const absolute = Math.abs(total);
  return Math.sign(total) * (Math.floor(absolute / count) * length + Math.min(absolute % count, length));
}

function keepPrefix(source, length, originalCount) {
  if (source.repeat === 'installments') source.amount = installmentPrefix(source.amount, originalCount, length);
  source.count = length;
  source.exceptions = Object.fromEntries(Object.entries(source.exceptions ?? {}).filter(([key]) => Number(key) < length));
}

/**
 * Mutates state. UI amount always means the selected occurrence's amount, including parcels.
 * one: merge an exception. future: split, retain prior overrides, clear future overrides.
 * all: update the base series and clear all overrides (including cancellations).
 * Splitting parcels preserves the old base cent allocation; it never reapportions the past.
 */
export function updateOccurrence(state, sourceId, index, fields, scope = 'one') {
  const source = mutationTarget(state, sourceId, index, scope);
  if (!source) return null;
  const changes = editable(fields);
  if (scope === 'one') {
    source.exceptions ??= {};
    source.exceptions[index] = { ...source.exceptions[index], ...changes };
    return source;
  }
  const count = occurrenceCount(source);
  if (scope === 'all' || index === 0) {
    if (changes.date !== undefined) {
      const selectedDate = getOccurrence(state, `${sourceId}:${index}`).date;
      const shift = dayDiff(selectedDate, changes.date);
      changes.date = addDays(source.date, shift);
      if (shift !== 0) source.recurrenceAnchorDay = Number(changes.date.slice(-2));
    }
    if (source.repeat === 'installments' && changes.amount !== undefined) changes.amount *= count;
    Object.assign(source, changes, { exceptions: {} });
    return source;
  }
  const suffix = {
    ...source,
    id: globalThis.crypto.randomUUID(),
    date: occurrenceDate(source, index),
    tagIds: [...(source.tagIds ?? [])],
    count: Number.isFinite(count) ? count - index : null,
    exceptions: {},
    recurrenceAnchorDay: source.recurrenceAnchorDay || Number(source.date.slice(-2)),
  };
  if (changes.date !== undefined && changes.date !== suffix.date) suffix.recurrenceAnchorDay = Number(changes.date.slice(-2));
  if (source.repeat === 'installments') {
    suffix.amount = source.amount - installmentPrefix(source.amount, count, index);
    if (changes.amount !== undefined) changes.amount *= suffix.count;
  }
  Object.assign(suffix, changes);
  keepPrefix(source, index, count);
  state.movements.push(suffix);
  return suffix;
}

/** Cancel an occurrence, truncate a series, or remove it entirely. Returns changed source/null. */
export function deleteOccurrence(state, sourceId, index, scope = 'one') {
  const source = mutationTarget(state, sourceId, index, scope);
  if (!source) return null;
  if (scope === 'all' || (scope === 'future' && index === 0)) {
    state.movements = state.movements.filter(m => m.id !== sourceId);
    return null;
  }
  if (scope === 'one') {
    source.exceptions ??= {};
    source.exceptions[index] = { ...source.exceptions[index], deleted: true };
    return source;
  }
  keepPrefix(source, index, occurrenceCount(source));
  return source;
}
