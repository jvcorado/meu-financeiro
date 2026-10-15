import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, monthEnd, monthStart, parseMoney, money, expandMovements, isEligible,
  forecastDaily, project, metrics, cardDueDate, getOccurrence, updateOccurrence, deleteOccurrence } from './domain.mjs';

const state = (movements = [], extra = {}) => ({ movements, tags: [], forecastItems: [], preferences: { forecastDivisor: 30 }, ...extra });
const movement = (id, type, amount, date = '2026-10-01', extra = {}) => ({ id, type, amount, date, description: id, tagIds: [], repeat: 'none', count: null, exceptions: {}, ...extra });

test('civil dates preserve end-of-month anchors and leap years', () => {
  assert.equal(monthStart('2026-10-14'), '2026-10-01');
  assert.equal(monthEnd('2024-02-01'), '2024-02-29');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2026-01-31', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => addDays('2026-02-30', 1), RangeError);
});

test('BRL parser handles separators and cents without silently accepting arbitrary text', () => {
  assert.equal(parseMoney('R$ 1.234,56'), 123456);
  assert.equal(parseMoney('1234.56'), 123456);
  assert.equal(parseMoney('1.234'), 123400);
  assert.equal(parseMoney('0,29'), 29);
  assert.equal(parseMoney('-10,50'), -1050);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney('not a value'), 0);
  assert.match(money(123456), /1\.234,56/);
});

test('all five categories have distinct effect on performance, cost and savings', () => {
  const s = state([
    movement('e', 'income', 100000), movement('s', 'expense', 10000),
    movement('d', 'daily', 5000), movement('g', 'saving', 20000), movement('c', 'card', 15000),
  ]);
  const result = metrics(s, '2026-10-01', '2026-10-31', '2026-10-31');
  assert.equal(result.performance, 50000);
  assert.equal(result.cost, 30000);
  assert.equal(result.saved, 20);
  assert.equal(project(s, '2026-10-01', '2026-10-01', '2026-10-31')[0].balance, 50000);
});

test('a visible month carries every earlier eligible movement into its opening balance', () => {
  const s = state([movement('e', 'income', 50000, '2026-09-30'), movement('s', 'expense', 8000)]);
  const days = project(s, '2026-10-01', '2026-10-03', '2026-10-31');
  assert.equal(days[0].balance, 42000);
  assert.equal(days[2].balance, 42000);
  assert.equal(days[0].totals.income, 0);
  assert.equal(days[0].totals.expense, 8000);
});

test('tags filter each indicator independently; overlapping tags never multiply money', () => {
  const s = state([movement('s', 'expense', 10000, '2026-10-01', { tagIds: ['a', 'b'] })], {
    tags: [{ id: 'a', rules: { balance: false, performance: false, cost: true } }, { id: 'b', rules: { balance: true, cost: true } }],
  });
  const m = metrics(s, '2026-10-01', '2026-10-31', '2026-10-31');
  assert.equal(m.expense, 10000);
  assert.equal(m.cost, 10000);
  assert.equal(m.performance, 0);
  assert.equal(project(s, '2026-10-01', '2026-10-01', '2026-10-31')[0].balance, 0);
  assert.equal(isEligible(s.movements[0], s, 'balance'), false);
});

test('forecast uses selected divisor, includes only future days, and rolls over at midnight', () => {
  const s = state([], { forecastItems: [{ amount: 150000 }] });
  assert.equal(forecastDaily(s), 5000);
  assert.equal(metrics(s, '2026-10-01', '2026-10-31', '2026-10-13').forecast, 90000);
  assert.equal(metrics(s, '2026-10-01', '2026-10-31', '2026-10-14').forecast, 85000);
  const days = project(s, '2026-10-13', '2026-10-14', '2026-10-13');
  assert.equal(days[0].forecast, 0);
  assert.equal(days[1].forecast, 5000);
  assert.equal(days[1].balance, -5000);
});

test('forecast before the visible future interval contributes to carry without double counting', () => {
  const s = state([], { forecastItems: [{ amount: 150000 }] });
  const full = project(s, '2026-10-01', '2026-11-01', '2026-10-13');
  const future = project(s, '2026-11-01', '2026-11-01', '2026-10-13');
  assert.equal(future[0].balance, -95000);
  assert.equal(future[0].balance, full.at(-1).balance);
});

test('proposed forecast rule is additive with already scheduled daily spending', () => {
  const s = state([movement('d', 'daily', 2000, '2026-10-14')], { forecastItems: [{ amount: 150000 }] });
  const [day] = project(s, '2026-10-14', '2026-10-14', '2026-10-13');
  assert.equal(day.totals.daily, 2000);
  assert.equal(day.forecast, 5000);
  assert.equal(day.balance, -7000);
});

test('finite monthly recurrences keep amount and original anchor', () => {
  const s = state([movement('monthly', 'expense', 10000, '2026-01-31', { repeat: 'monthly', count: 3 })]);
  const rows = expandMovements(s, '2026-01-01', '2026-12-31');
  assert.deepEqual(rows.map(r => r.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), 30000);
  assert.deepEqual(rows.map(r => r.key), ['monthly:0', 'monthly:1', 'monthly:2']);
});

test('installments distribute remainder cents and preserve the exact total', () => {
  const s = state([movement('parcel', 'card', 10000, '2026-01-31', { repeat: 'installments', count: 3 })]);
  const rows = expandMovements(s, '2026-01-01', '2026-12-31');
  assert.deepEqual(rows.map(r => r.amount), [3334, 3333, 3333]);
  assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), 10000);
});

test('daily and weekly indefinite series are generated only for the requested range', () => {
  const s = state([
    movement('daily', 'daily', 100, '2000-01-01', { repeat: 'daily' }),
    movement('weekly', 'expense', 200, '2026-10-01', { repeat: 'weekly', count: 2 }),
  ]);
  const rows = expandMovements(s, '2026-10-01', '2026-10-15');
  assert.equal(rows.filter(r => r.sourceId === 'daily').length, 15);
  assert.deepEqual(rows.filter(r => r.sourceId === 'weekly').map(r => r.date), ['2026-10-01', '2026-10-08']);
  assert.ok(rows.filter(r => r.sourceId === 'daily')[0].index > 9000);
});

test('exceptions edit/delete stable occurrences and move them across visible range boundaries', () => {
  const s = state([movement('r', 'expense', 1000, '2026-01-01', { repeat: 'monthly', count: 4,
    exceptions: { 0: { date: '2026-04-10', amount: 2500 }, 1: { deleted: true }, 3: { date: '2026-02-12' } },
  })]);
  const february = expandMovements(s, '2026-02-01', '2026-02-28');
  assert.equal(february.length, 1);
  assert.equal(february[0].index, 3);
  assert.equal(february[0].date, '2026-02-12');
  const april = expandMovements(s, '2026-04-01', '2026-04-30');
  assert.equal(april.length, 1);
  assert.equal(april[0].index, 0);
  assert.equal(april[0].amount, 2500);
});

test('editing a historical exception changes all subsequent balances', () => {
  const s = state([movement('r', 'expense', 10000, '2026-09-01', { repeat: 'monthly', count: 2 })]);
  const before = project(s, '2026-10-01', '2026-10-01', '2026-10-31')[0].balance;
  s.movements[0].exceptions[0] = { amount: 12000 };
  const after = project(s, '2026-10-01', '2026-10-01', '2026-10-31')[0].balance;
  assert.equal(after - before, -2000);
});

test('daily average intentionally preserves observed monthly and annual divisor distinction', () => {
  const s = state([movement('d', 'daily', 34075)]);
  assert.equal(metrics(s, '2026-10-01', '2026-10-31', '2026-10-13').average, 2621);
  assert.equal(metrics(s, '2026-10-01', '2026-10-31', '2026-10-13', true).average, 1099);
});

test('annual savings is a ratio of sums; zero income has no percentage', () => {
  const s = state([
    movement('e1', 'income', 100000, '2026-01-01'), movement('g1', 'saving', 10000, '2026-01-01'),
    movement('e2', 'income', 10000, '2026-02-01'), movement('g2', 'saving', 10000, '2026-02-01'),
  ]);
  assert.ok(Math.abs(metrics(s, '2026-01-01', '2026-12-31', '2026-12-31', true).saved - 18.181818) < 0.00001);
  assert.equal(metrics(state(), '2026-10-01', '2026-10-31').saved, null);
});

test('card cycle considers closing, due ordering, short months and year rollover', () => {
  assert.equal(cardDueDate('2026-10-13', { closingDay: 2, dueDay: 10 }), '2026-11-10');
  assert.equal(cardDueDate('2026-10-02', { closingDay: 2, dueDay: 10 }), '2026-10-10');
  assert.equal(cardDueDate('2026-10-20', { closingDay: 25, dueDay: 5 }), '2026-11-05');
  assert.equal(cardDueDate('2026-12-30', { closingDay: 25, dueDay: 5 }), '2027-02-05');
  assert.equal(cardDueDate('2026-02-01', { closingDay: 2, dueDay: 31 }), '2026-02-28');
});

test('empty, reversed and unreasonably large ranges terminate predictably', () => {
  assert.deepEqual(expandMovements(state(), '2026-10-02', '2026-10-01'), []);
  assert.deepEqual(project(state(), '2026-10-02', '2026-10-01'), []);
  assert.throws(() => project(state(), '1800-01-01', '2026-01-01'), RangeError);
  assert.equal(expandMovements(state([movement('bad', 'income', 5, 'invalid')]), '2026-10-01', '2026-10-31').length, 0);
});

const parcelState = (exceptions = {}) => state([movement('p', 'card', 10000, '2026-01-31', { repeat: 'installments', count: 3, exceptions })]);
const parcelRows = s => expandMovements(s, '2026-01-01', '2027-12-31');

test('getOccurrence resolves a far-rescheduled exact key and missing/deleted keys safely', () => {
  const s = parcelState({ 1: { date: '2099-05-20', amount: 100 } });
  assert.equal(getOccurrence(s, 'p:1').date, '2099-05-20');
  assert.equal(getOccurrence(s, 'p:1').amount, 100);
  assert.equal(getOccurrence(s, 'p:3'), null);
  assert.equal(getOccurrence(s, 'deleted:0'), null);
  assert.equal(getOccurrence(s, 'p:-1'), null);
  deleteOccurrence(s, 'p', 1);
  assert.equal(getOccurrence(s, 'p:1'), null);
});

test('editing a single installment never reallocates other installments', () => {
  for (const index of [0, 1, 2]) {
    const s = parcelState();
    updateOccurrence(s, 'p', index, { amount: 5000 }, 'one');
    assert.deepEqual(parcelRows(s).map(row => row.amount), [3334, 3333, 3333].map((value, i) => i === index ? 5000 : value));
  }
});

test('future installment edits retain earlier cent allocation, even for first and final parcel', () => {
  for (const index of [0, 1, 2]) {
    const s = parcelState();
    updateOccurrence(s, 'p', index, { amount: 5000 }, 'future');
    const rows = parcelRows(s);
    assert.deepEqual(rows.map(row => row.amount), [3334, 3333, 3333].map((value, i) => i >= index ? 5000 : value));
    assert.deepEqual(rows.map(row => row.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  }
});

test('splitting parcels for a description change conserves total and month-end dates', () => {
  for (const index of [1, 2]) {
    const s = parcelState();
    updateOccurrence(s, 'p', index, { description: 'Updated', date: getOccurrence(s, `p:${index}`).date }, 'future');
    const rows = parcelRows(s);
    assert.deepEqual(rows.map(row => row.amount), [3334, 3333, 3333]);
    assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 10000);
    assert.deepEqual(rows.map(row => row.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  }
});

test('future edits preserve prior overrides and intentionally clear later overrides', () => {
  const s = parcelState({ 0: { amount: 4000 }, 2: { amount: 9000, date: '2026-04-01' } });
  const suffix = updateOccurrence(s, 'p', 1, { description: 'Future' }, 'future');
  assert.deepEqual(s.movements[0].exceptions, { 0: { amount: 4000 } });
  assert.deepEqual(suffix.exceptions, {});
  assert.deepEqual(parcelRows(s).map(row => row.amount), [4000, 3333, 3333]);
});

test('deleting one parcel preserves every other original amount and stable identity', () => {
  for (const index of [0, 1, 2]) {
    const s = parcelState();
    deleteOccurrence(s, 'p', index, 'one');
    assert.deepEqual(parcelRows(s).map(row => row.amount), [3334, 3333, 3333].filter((_, i) => i !== index));
    assert.deepEqual(parcelRows(s).map(row => row.index), [0, 1, 2].filter(i => i !== index));
  }
});

test('deleting future parcels conserves the prefix and supports a single remaining parcel', () => {
  for (const index of [0, 1, 2]) {
    const s = parcelState();
    deleteOccurrence(s, 'p', index, 'future');
    assert.deepEqual(parcelRows(s).map(row => row.amount), [3334, 3333, 3333].slice(0, index));
    if (index === 1) assert.equal(s.movements[0].count, 1);
  }
});

test('all-parcel edit treats amount as each parcel and does not move start to selected later parcel', () => {
  const s = parcelState({ 0: { amount: 4000 }, 2: { deleted: true } });
  updateOccurrence(s, 'p', 1, { amount: 2500, date: '2026-02-28' }, 'all');
  assert.equal(s.movements[0].date, '2026-01-31');
  assert.deepEqual(parcelRows(s).map(row => row.amount), [2500, 2500, 2500]);
  assert.deepEqual(s.movements[0].exceptions, {});
  deleteOccurrence(s, 'p', 1, 'all');
  assert.equal(s.movements.length, 0);
});

test('indefinite future recurrence edit creates a finite prefix and new stable anchor', () => {
  const s = state([movement('r', 'income', 1000, '2026-01-31', { repeat: 'monthly' })]);
  const suffix = updateOccurrence(s, 'r', 1, { amount: 2000, date: '2026-02-15' }, 'future');
  assert.equal(s.movements[0].count, 1);
  assert.equal(suffix.count, null);
  assert.equal(suffix.date, '2026-02-15');
  const rows = expandMovements(s, '2026-01-01', '2026-04-30');
  assert.deepEqual(rows.map(row => row.date), ['2026-01-31', '2026-02-15', '2026-03-15', '2026-04-15']);
  assert.deepEqual(rows.map(row => row.amount), [1000, 2000, 2000, 2000]);
});

test('mutation helpers leave unknown/deleted targets alone and reject unsupported scopes', () => {
  const s = parcelState();
  const before = JSON.stringify(s);
  assert.equal(updateOccurrence(s, 'missing', 0, { amount: 9 }), null);
  assert.equal(deleteOccurrence(s, 'p', 8, 'all'), null);
  assert.equal(JSON.stringify(s), before);
  assert.throws(() => deleteOccurrence(s, 'p', 0, 'invalid'), RangeError);
});

test('ancient daily history carries arithmetically without expanding 126 years', () => {
  const s = state([movement('ancient', 'income', 100, '1900-01-01', { repeat: 'daily' })]);
  const expectedDays = Math.round((Date.parse('2026-10-01') - Date.parse('1900-01-01')) / 86400000) + 1;
  const [day] = project(s, '2026-10-01', '2026-10-01', '2026-10-01');
  assert.equal(day.balance, expectedDays * 100);
  assert.equal(day.occurrences.length, 1);
});

test('arithmetic historical carry matches full projection with exceptions, exclusions and parcels', () => {
  const s = state([
    movement('i', 'income', 1000, '2026-01-01', { repeat: 'weekly', exceptions: { 0: { deleted: true }, 4: { amount: 2000 }, 45: { date: '2026-01-10' } } }),
    movement('m', 'expense', 1000, '2026-01-31', { repeat: 'monthly', exceptions: { 2: { date: '2026-12-20' }, 9: { date: '2026-02-10', tagIds: ['excluded'] } } }),
    movement('p', 'card', 10000, '2026-01-31', { repeat: 'installments', count: 3, exceptions: { 0: { amount: 4000 }, 1: { type: 'income' } } }),
  ], { tags: [{ id: 'excluded', rules: { balance: false } }] });
  const full = project(s, '2026-01-01', '2026-12-31', '2026-12-31');
  for (const date of ['2026-02-01', '2026-02-28', '2026-03-31', '2026-10-01', '2026-12-31']) {
    assert.equal(project(s, date, date, '2026-12-31')[0].balance, full.find(day => day.date === date).balance, date);
  }
});

test('indicator composition returns eligible values independently of raw category totals', () => {
  const s = state([
    movement('i', 'income', 10000), movement('ix', 'income', 5000, '2026-10-01', { tagIds: ['ignoreSaved'] }),
    movement('s', 'saving', 2000), movement('sx', 'saving', 1000, '2026-10-01', { tagIds: ['ignoreSaved'] }),
    movement('d', 'daily', 3100), movement('dx', 'daily', 6200, '2026-10-01', { tagIds: ['ignoreAverage'] }),
  ], { tags: [{ id: 'ignoreSaved', rules: { saved: false } }, { id: 'ignoreAverage', rules: { average: false } }] });
  const result = metrics(s, '2026-10-01', '2026-10-31', '2026-10-31', true);
  assert.equal(result.income, 15000);
  assert.equal(result.saving, 3000);
  assert.equal(result.daily, 9300);
  assert.equal(result.savedIncome, 10000);
  assert.equal(result.savedSaving, 2000);
  assert.equal(result.averageDaily, 3100);
  assert.equal(result.saved, 20);
  assert.equal(result.average, 100);
});

test('all/future description edits with omitted amount preserve installment remainder cents', () => {
  for (const scope of ['all', 'future']) {
    for (const index of [0, 1, 2]) {
      const s = parcelState();
      updateOccurrence(s, 'p', index, { description: 'Description only' }, scope);
      const rows = parcelRows(s);
      assert.deepEqual(rows.map(row => row.amount), [3334, 3333, 3333]);
      assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 10000);
      assert.deepEqual(rows.map(row => row.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
    }
  }
});
