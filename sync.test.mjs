import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from './sync.mjs';

const copy = value => structuredClone(value);
const entry = (id, fields = {}) => ({ id, type: 'expense', amount: 10000, description: id, date: '2026-10-14', tagIds: [], cardId: null, repeat: 'none', count: null, exceptions: {}, ...fields });
const initial = () => ({ version: 1, revision: 1, profile: { firstName: 'Ana', lastName: 'Silva' },
  preferences: { theme: 'dark', collapsed: [], forecastDivisor: 30 }, movements: [entry('a'), entry('b')],
  tags: [{ id: 't', name: 'Casa', color: 'blue', rules: { balance: true, cost: true } }],
  cards: [{ id: 'c', name: 'Cartão', closingDay: 2, dueDay: 10 }], forecastItems: [], checkins: [], suggestions: [] });
function fixture() { const base = initial(); return [base, copy(base), { ...copy(base), revision: 2 }]; }

test('independent record and profile changes combine, preserving remote revision and input immutability', () => {
  const [b, l, r] = fixture();
  l.movements[0].amount = 15000;
  r.movements[1].description = 'Remoto';
  l.profile.firstName = 'Maria';
  r.profile.lastName = 'Souza';
  const originals = [b, l, r].map(copy);
  const { state, conflicts } = mergeStates(b, l, r);
  assert.deepEqual(conflicts, []);
  assert.equal(state.movements[0].amount, 15000);
  assert.equal(state.movements[1].description, 'Remoto');
  assert.deepEqual(state.profile, { firstName: 'Maria', lastName: 'Souza' });
  assert.equal(state.revision, 2);
  assert.deepEqual([b, l, r], originals);
  state.movements[0].amount = 9;
  assert.equal(l.movements[0].amount, 15000);
});

test('concurrent unequal changes to exactly the same money field produce a conflict', () => {
  const [b, l, r] = fixture();
  l.movements[0].amount = 12000; r.movements[0].amount = 13000;
  const result = mergeStates(b, l, r);
  assert.deepEqual(result.conflicts, [{ path: 'movements[a].amount', base: 10000, local: 12000, remote: 13000 }]);
  assert.equal(result.state.movements[0].amount, 13000);
});

test('identical concurrent changes are not conflicts', () => {
  const [b, l, r] = fixture();
  l.movements[0].amount = 12000; r.movements[0].amount = 12000;
  assert.deepEqual(mergeStates(b, l, r).conflicts, []);
});

test('record deletion wins over an unchanged peer but conflicts with edits without resurrection', () => {
  const [b, l, r] = fixture();
  r.movements = r.movements.filter(row => row.id !== 'a');
  let result = mergeStates(b, l, r);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.movements.some(row => row.id === 'a'), false);
  l.movements[0].amount++;
  result = mergeStates(b, l, r);
  assert.equal(result.conflicts[0].path, 'movements[a]');
  assert.equal(result.state.movements.some(row => row.id === 'a'), false);
});

test('deleting locally and editing remotely is also a conflict', () => {
  const [b, l, r] = fixture();
  l.movements.splice(0, 1); r.movements[0].amount++;
  assert.equal(mergeStates(b, l, r).conflicts[0].path, 'movements[a]');
});

test('distinct new IDs merge; duplicate new ID with different records conflicts atomically', () => {
  const [b, l, r] = fixture();
  l.movements.push(entry('local')); r.movements.push(entry('remote'));
  let result = mergeStates(b, l, r);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.movements.length, 4);
  r.movements.push(entry('local', { amount: 200 }));
  result = mergeStates(b, l, r);
  assert.equal(result.conflicts[0].path, 'movements[local]');
});

test('independent check-ins, collapsed columns, and tag memberships combine as sets', () => {
  const [b, l, r] = fixture();
  b.checkins = ['2026-10-01']; l.checkins = []; r.checkins = ['2026-10-01', '2026-10-02'];
  l.preferences.collapsed = ['daily']; r.preferences.collapsed = ['card'];
  l.tags.push({ id: 'lt', name: 'Local' }); r.tags.push({ id: 'rt', name: 'Remote' });
  l.movements[0].tagIds = ['lt']; r.movements[0].tagIds = ['rt'];
  const result = mergeStates(b, l, r);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.state.checkins, ['2026-10-02']);
  assert.deepEqual(new Set(result.state.preferences.collapsed), new Set(['daily', 'card']));
  assert.deepEqual(new Set(result.state.movements[0].tagIds), new Set(['lt', 'rt']));
});

test('tag rule fields and preferences merge independently', () => {
  const [b, l, r] = fixture();
  l.tags[0].rules.balance = false; r.tags[0].rules.cost = false;
  l.preferences.theme = 'light'; r.preferences.forecastDivisor = 31;
  const result = mergeStates(b, l, r);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.state.tags[0].rules, { balance: false, cost: false });
  assert.equal(result.state.preferences.theme, 'light');
  assert.equal(result.state.preferences.forecastDivisor, 31);
});

test('nested exception fields merge; cancellation against editing the same occurrence conflicts', () => {
  const [b, l, r] = fixture();
  for (const input of [b, l, r]) { input.movements[0].repeat = 'monthly'; input.movements[0].count = 4; }
  l.movements[0].exceptions = { 1: { amount: 100 } };
  r.movements[0].exceptions = { 1: { description: 'Remote' }, 2: { deleted: true } };
  let result = mergeStates(b, l, r);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.state.movements[0].exceptions, { 1: { amount: 100, description: 'Remote' }, 2: { deleted: true } });
  l.movements[0].exceptions[1] = { deleted: true };
  result = mergeStates(b, l, r);
  assert.equal(result.conflicts[0].path, 'movements[a].exceptions.1');
});

test('deleted tags cannot leave a newly added or edited movement with dangling references', () => {
  const [b, l, r] = fixture();
  r.tags = [];
  l.movements.push(entry('new', { tagIds: ['t'] }));
  const result = mergeStates(b, l, r);
  assert.equal(result.conflicts[0].path, 'movements[new].tagIds');
  const preferred = mergeStates(b, l, r, { conflictPreference: 'local' });
  assert.equal(preferred.conflicts[0].path, 'movements[new].tagIds');
});

test('deleted cards and exception-only links are checked after merge', () => {
  const [b, l, r] = fixture();
  r.cards = [];
  l.movements[0].exceptions = { 0: { cardId: 'c' } };
  assert.equal(mergeStates(b, l, r).conflicts[0].path, 'movements[a].exceptions.0.cardId');
});

test('concurrent tag deletion and removal of its last link are valid', () => {
  const [b, l, r] = fixture();
  b.movements[0].tagIds = ['t']; r.movements[0].tagIds = ['t'];
  l.movements[0].tagIds = []; r.tags = [];
  assert.deepEqual(mergeStates(b, l, r).conflicts, []);
});

test('explicitly preferring local resolves only conflicting fields and keeps unrelated remote changes', () => {
  const [b, l, r] = fixture();
  l.movements[0].amount = 200; r.movements[0].amount = 300;
  r.movements[0].description = 'Remote description';
  const result = mergeStates(b, l, r, { conflictPreference: 'local' });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.movements[0].amount, 200);
  assert.equal(result.state.movements[0].description, 'Remote description');
  assert.equal(result.state.revision, r.revision);
});

test('schema version mismatch remains blocking even when local values are preferred', () => {
  const [b, l, r] = fixture(); r.version = 2;
  const result = mergeStates(b, l, r, { conflictPreference: 'local' });
  assert.equal(result.conflicts[0].path, 'version');
});

test('unsafe property keys cannot pollute output or prototypes, and remain blocking', () => {
  const [b, l, r] = fixture();
  l.profile = JSON.parse('{"firstName":"Ana","lastName":"Silva","__proto__":{"polluted":true}}');
  const result = mergeStates(b, l, r, { conflictPreference: 'local' });
  assert.ok(result.conflicts.some(conflict => conflict.path === 'profile.__proto__'));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result.state.profile, '__proto__'), false);
});

test('merged shorter series cannot retain an out-of-range concurrent exception', () => {
  const [b, l, r] = fixture();
  for (const input of [b, l, r]) { input.movements[0].repeat = 'monthly'; input.movements[0].count = 4; }
  l.movements[0].count = 1; r.movements[0].exceptions[2] = { amount: 30 };
  assert.equal(mergeStates(b, l, r).conflicts[0].path, 'movements[a].exceptions.2');
});

test('duplicate IDs are blocking, rather than silently dropping a record', () => {
  const [b, l, r] = fixture(); l.movements.push(entry('a'));
  assert.ok(mergeStates(b, l, r).conflicts.some(conflict => conflict.path === 'movements.identidades'));
});

test('cancelled exception metadata cannot retain references deleted on the other device', () => {
  const [b, l, r] = fixture();
  r.tags = [];
  l.movements[0].exceptions[0] = { deleted: true, tagIds: ['t'] };
  assert.ok(mergeStates(b, l, r).conflicts.some(conflict => conflict.path === 'movements[a].exceptions.0.tagIds'));
});
