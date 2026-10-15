/** Three-way state merge. A result with conflicts must be reviewed before it is persisted. */
const ABSENT = Symbol('absent');
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const RECORD_COLLECTIONS = new Set(['movements', 'tags', 'cards', 'forecastItems', 'suggestions']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = value => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const valueAt = (value, key) => plain(value) && own(value, key) ? value[key] : ABSENT;

function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (!plain(a) || !plain(b)) return false;
  const keys = Object.keys(a), otherKeys = Object.keys(b);
  return keys.length === otherKeys.length && keys.every(key => own(b, key) && equal(a[key], b[key]));
}

function clone(value) {
  if (value === ABSENT) return ABSENT;
  if (Array.isArray(value)) return value.map(clone);
  if (object(value)) {
    const result = {};
    for (const key of Object.keys(value)) if (!UNSAFE.has(key)) result[key] = clone(value[key]);
    return result;
  }
  return value;
}

const display = value => value === ABSENT ? '(ausente)' : clone(value);

export function mergeStates(base, local, remote, options = {}) {
  const conflicts = [], paths = new Set();
  function conflict(path, b, l, r, resolvable = true) {
    if (resolvable && options.conflictPreference === 'local') return clone(l);
    if (!paths.has(path)) {
      paths.add(path);
      conflicts.push({ path, base: display(b), local: display(l), remote: display(r) });
    }
    // This is only a preview: prefer the remote value and never silently resurrect deletions.
    return clone(r);
  }

  function inspect(value, path, b, l, r) {
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value) && !plain(value)) conflict(path || 'state', b, l, r, false);
    for (const key of Object.keys(value)) {
      const next = path ? `${path}.${key}` : key;
      if (UNSAFE.has(key)) conflict(next, b, l, r, false);
      else inspect(value[key], next, b, l, r);
    }
  }

  function mergeSet(b, l, r, path) {
    if (![b, l, r].every(value => value === ABSENT || (Array.isArray(value) && value.every(item => typeof item === 'string')))) {
      return conflict(path, b, l, r, false);
    }
    const bs = new Set(b === ABSENT ? [] : b), ls = new Set(l === ABSENT ? [] : l), rs = new Set(r === ABSENT ? [] : r);
    const output = [];
    // Remote order first, then local additions. Membership changes are independent.
    for (const item of new Set([...rs, ...ls, ...bs])) {
      const before = bs.has(item), here = ls.has(item), there = rs.has(item);
      const present = here === before ? there : here;
      if (present) output.push(item);
    }
    return output;
  }

  function mergeRecords(b, l, r, path) {
    if (![b, l, r].every(Array.isArray)) return conflict(path, b, l, r, false);
    function records(array) {
      const result = new Map();
      for (const record of array) {
        if (!plain(record) || typeof record.id !== 'string' || !record.id || result.has(record.id)) {
          conflict(`${path}.identidades`, b, l, r, false);
          continue;
        }
        result.set(record.id, record);
      }
      return result;
    }
    const bm = records(b), lm = records(l), rm = records(r), result = [];
    for (const id of new Set([...rm.keys(), ...lm.keys(), ...bm.keys()])) {
      const bv = bm.has(id) ? bm.get(id) : ABSENT;
      const lv = lm.has(id) ? lm.get(id) : ABSENT;
      const rv = rm.has(id) ? rm.get(id) : ABSENT;
      const itemPath = `${path}[${id}]`;
      const merged = bv === ABSENT && lv !== ABSENT && rv !== ABSENT && !equal(lv, rv)
        ? conflict(itemPath, bv, lv, rv) : merge(bv, lv, rv, itemPath);
      if (merged !== ABSENT) result.push(merged);
    }
    return result;
  }

  function merge(b, l, r, path) {
    if (RECORD_COLLECTIONS.has(path)) return mergeRecords(b, l, r, path);
    if (path === 'checkins' || path === 'preferences.collapsed' || /\.tagIds$/.test(path)) {
      return mergeSet(b, l, r, path);
    }
    if (equal(l, r)) return clone(l);
    if (equal(l, b)) return clone(r);
    if (equal(r, b)) return clone(l);
    // Whole-record deletion conflicts with changes, including nested exception deletion.
    if (l === ABSENT || r === ABSENT) return conflict(path, b, l, r);
    if (/\.exceptions\.[^.]+$/.test(path) && (l?.deleted === true || r?.deleted === true)) {
      return conflict(path, b, l, r);
    }
    if (plain(l) && plain(r) && (plain(b) || b === ABSENT)) {
      const output = {};
      for (const key of new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b === ABSENT ? {} : b)])) {
        if (UNSAFE.has(key)) continue;
        const result = merge(valueAt(b, key), valueAt(l, key), valueAt(r, key), path ? `${path}.${key}` : key);
        if (result !== ABSENT) output[key] = result;
      }
      return output;
    }
    return conflict(path, b, l, r);
  }

  if (![base, local, remote].every(plain)) {
    conflict('state', base, local, remote, false);
    return { state: plain(remote) ? clone(remote) : {}, conflicts };
  }
  for (const input of [base, local, remote]) inspect(input, '', base, local, remote);
  if (base.version !== local.version || base.version !== remote.version || base.version !== 1) {
    conflict('version', base.version, local.version, remote.version, false);
  }
  const state = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)])) {
    if (UNSAFE.has(key) || key === 'revision' || key === 'version') continue;
    const result = merge(valueAt(base, key), valueAt(local, key), valueAt(remote, key), key);
    if (result !== ABSENT) state[key] = result;
  }
  state.version = remote.version;
  state.revision = remote.revision;

  // Independently valid changes can combine into invalid relations (delete tag vs new link).
  const tagIds = new Set((Array.isArray(state.tags) ? state.tags : []).map(record => record?.id));
  const cardIds = new Set((Array.isArray(state.cards) ? state.cards : []).map(record => record?.id));
  function originalField(input, id, exceptionIndex, key) {
    const record = Array.isArray(input.movements) ? input.movements.find(row => row?.id === id) : undefined;
    const fields = exceptionIndex === null ? record : record?.exceptions?.[exceptionIndex];
    return fields && own(fields, key) ? fields[key] : ABSENT;
  }
  function relations(record, id, exceptionIndex = null) {
    if (!plain(record)) return;
    const prefix = `movements[${id}]${exceptionIndex === null ? '' : `.exceptions.${exceptionIndex}`}`;
    for (const [field, ids] of [['tagIds', tagIds], ['cardId', cardIds]]) {
      const values = field === 'tagIds' ? record.tagIds : record.cardId == null ? [] : [record.cardId];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.some(id => !ids.has(id))) {
        conflict(`${prefix}.${field}`, ...[base, local, remote].map(input => originalField(input, id, exceptionIndex, field)), false);
      }
    }
  }
  for (const movement of Array.isArray(state.movements) ? state.movements : []) {
    relations(movement, movement?.id);
    for (const [index, exception] of Object.entries(movement?.exceptions ?? {})) {
      relations(exception, movement.id, index);
      const count = movement.repeat === 'none' ? 1 : movement.count;
      if (!/^\d+$/.test(index) || (count != null && Number(index) >= count)) {
        conflict(`movements[${movement.id}].exceptions.${index}`, ...[base, local, remote].map(input => {
          const source = input.movements?.find(row => row.id === movement.id);
          return source?.exceptions?.[index] ?? ABSENT;
        }), false);
      }
    }
  }
  return { state, conflicts };
}
