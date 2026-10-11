const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  Decimal, EngineExecutionError, ConfigurationValidationError, execute,
  createInitialProjectState, parseExpression, validateProjectConfiguration,
  resetParameters, dueScheduleEvents,
} = require('../.test-build/engine/index.js');

const integer = (value) => ({ type: 'integer', value: String(value) });
const decimal = (value) => ({ type: 'decimal', value: String(value) });
const literal = (value) => ({ kind: 'literal', value: integer(value) });
const reference = (id) => ({ kind: 'parameter', id });
const binary = (op, left, right) => ({ kind: 'binary', op, left, right });
const parameter = (id, value, type = 'integer') => ({
  id, name: id, type, kind: 'stored',
  initialValue: type === 'integer' ? integer(value) : decimal(value),
});
const rule = (id, eventSource, actions, condition, order = 0, triggerMode = 'each') => ({
  id, name: id, enabled: true, order, eventSource, triggerMode, actions, condition,
});
const button = (id) => ({ type: 'button', sourceId: id });
const completed = (result) => {
  assert.equal(result.status, 'completed');
  return result;
};
const config = (parameters, rules = []) => ({ parameters, rules });

test('decimal arithmetic is exact, bounded, and rounds division half away from zero', () => {
  assert.equal(Decimal.parse('0.1').add(Decimal.parse('0.2')).toString(), '0.3');
  assert.equal(Decimal.parse('-5').mod(Decimal.parse('3')).toString(), '-2');
  assert.equal(Decimal.parse('-2.1').floor().toString(), '-3');
  assert.equal(Decimal.parse('1').div(Decimal.parse('4')).toString(), '0.25');
  assert.equal(Decimal.parse('1').div(Decimal.parse('8'), 2).toString(), '0.13');
  assert.equal(Decimal.parse('-1').div(Decimal.parse('8'), 2).toString(), '-0.13');
  assert.throws(() => Decimal.parse('1e3'), /Invalid decimal/);
  assert.throws(() => Decimal.parse('1'.repeat(1001)), /exceeds 1000 digits/);
});

test('counter handles repeated root events', () => {
  let state = createInitialProjectState(config([parameter('N', 0)], [rule('plus', { type: 'button', id: 'plus' }, [
    { type: 'add', parameterId: 'N', expression: literal(5) },
  ])]));
  for (let index = 0; index < 3; index++) state = completed(execute(state, button('plus'))).state;
  assert.equal(state.runtime.values.N.value, '15');
});

test('actions are sequential and preserve change snapshots in FIFO order', () => {
  const state = createInitialProjectState(config([parameter('A', 0), parameter('B', 0)], [
    rule('button', { type: 'button', id: 'go' }, [
      { type: 'set', parameterId: 'A', expression: literal(5) },
      { type: 'set', parameterId: 'A', expression: literal(10) },
      { type: 'set', parameterId: 'A', expression: literal(15) },
    ]),
    rule('on-change', { type: 'changed', parameterId: 'A' }, [
      { type: 'add', parameterId: 'B', expression: literal(1) },
    ], undefined, 1),
  ]));
  const result = completed(execute(state, button('go')));
  assert.deepEqual(result.changes.filter((change) => change.parameterId === 'A')
    .map(({ oldValue, newValue }) => [oldValue.value, newValue.value]), [['0', '5'], ['5', '10'], ['10', '15']]);
  assert.equal(result.state.runtime.values.B.value, '3');
  assert.deepEqual(result.events.filter((event) => event.type === 'changed')
    .map(({ sourceId, oldValue, newValue }) => [sourceId, oldValue.value, newValue.value]), [
      ['A', '0', '5'], ['A', '5', '10'], ['A', '10', '15'],
      ['B', '0', '1'], ['B', '1', '2'], ['B', '2', '3'],
    ]);
});

test('changed-event snapshots expose oldValue, newValue, and delta to rules', () => {
  const state = createInitialProjectState(config([parameter('A', 0), parameter('B', 0)], [
    rule('set', { type: 'button', id: 'go' }, [{ type: 'set', parameterId: 'A', expression: literal(7) }]),
    rule('snapshot', { type: 'changed', parameterId: 'A' }, [{
      type: 'set', parameterId: 'B', expression: binary('+', { kind: 'event', field: 'oldValue' }, { kind: 'event', field: 'delta' }),
    }], undefined, 1),
  ]));
  const result = completed(execute(state, button('go')));
  assert.equal(result.state.runtime.values.B.value, '7');
});

test('rule order follows configured order and actions see prior changes', () => {
  const result = completed(execute(createInitialProjectState(config([parameter('Gold', 100), parameter('Silver', 50)], [
    rule('sequence', { type: 'button', id: 'go' }, [
      { type: 'set', parameterId: 'Gold', expression: binary('*', reference('Gold'), literal(2)) },
      { type: 'set', parameterId: 'Silver', expression: binary('+', reference('Silver'), binary('-', reference('Silver'), reference('Gold'))) },
    ]),
  ])), button('go')));
  assert.equal(result.state.runtime.values.Gold.value, '200');
  assert.equal(result.state.runtime.values.Silver.value, '-100');
});

test('numeric conversion and floor support the cents conversion scenario', () => {
  const result = completed(execute(createInitialProjectState(config([parameter('Cents', 95), parameter('Dollars', 0)], [
    rule('convert', { type: 'button', id: 'add' }, [
      { type: 'add', parameterId: 'Cents', expression: literal(250) },
      { type: 'add', parameterId: 'Dollars', expression: { kind: 'call', fn: 'floor', args: [binary('/', reference('Cents'), literal(100))] } },
      { type: 'set', parameterId: 'Cents', expression: binary('mod', reference('Cents'), literal(100)) },
    ]),
  ])), button('add')));
  assert.equal(result.state.runtime.values.Cents.value, '45');
  assert.equal(result.state.runtime.values.Dollars.value, '3');
});

test('computed values update immediately and reject dependency cycles', () => {
  const total = { id: 'Total', name: 'Total', type: 'integer', kind: 'computed', initialValue: integer(0), formula: binary('+', reference('A'), reference('B')) };
  const state = createInitialProjectState(config([parameter('A', 2), parameter('B', 3), total], [rule('add', { type: 'button', id: 'go' }, [
    { type: 'add', parameterId: 'A', expression: literal(5) },
    { type: 'add', parameterId: 'B', expression: reference('Total') },
  ])]));
  const result = completed(execute(state, button('go')));
  assert.equal(result.state.runtime.values.Total.value, '20');
  assert.deepEqual(result.changes.map((change) => change.parameterId), ['A', 'Total', 'B', 'Total']);
  const a = { id: 'A', name: 'A', type: 'integer', kind: 'computed', initialValue: integer(0), formula: reference('B') };
  const b = { id: 'B', name: 'B', type: 'integer', kind: 'computed', initialValue: integer(0), formula: reference('A') };
  assert.throws(() => validateProjectConfiguration(config([a, b])), /cycle/i);
});

test('safe parser handles precedence and rejects executable JavaScript', () => {
  const ast = parseExpression('1 + 2 * 3');
  const state = createInitialProjectState(config([parameter('A', 0)], [rule('parsed', { type: 'button', id: 'go' }, [
    { type: 'set', parameterId: 'A', expression: ast },
  ])]));
  assert.equal(completed(execute(state, button('go'))).state.runtime.values.A.value, '7');
  assert.throws(() => parseExpression('globalThis.process.exit()'), /Недопустимый|Unexpected|Expected|Unsupported/);
  assert.throws(() => parseExpression('1 + (2'), /Ожидался|Expected/);
});

test('rule failure reports context and discards all changes', () => {
  const state = createInitialProjectState(config([parameter('A', 0)], [rule('fail', { type: 'button', id: 'go' }, [
    { type: 'set', parameterId: 'A', expression: literal(5) },
    { type: 'add', parameterId: 'A', expression: binary('/', literal(1), literal(0)) },
  ])]));
  assert.throws(() => execute(state, button('go')), (error) => {
    assert.ok(error instanceof EngineExecutionError);
    assert.equal(error.details.ruleId, 'fail');
    assert.equal(error.details.actionIndex, 1);
    assert.match(error.message, /Division by zero/);
    return true;
  });
  assert.equal(state.runtime.values.A.value, '0');
});

test('rising edge runs once while a condition stays true', () => {
  const state = createInitialProjectState(config([parameter('A', 0), parameter('B', 0)], [
    rule('set', { type: 'button', id: 'go' }, [{ type: 'set', parameterId: 'A', expression: literal(1) }]),
    rule('edge', { type: 'button', id: 'go' }, [{ type: 'add', parameterId: 'B', expression: literal(1) }], binary('>', reference('A'), literal(0)), 1, 'risingEdge'),
  ]));
  let result = completed(execute(state, button('go')));
  assert.equal(result.state.runtime.values.B.value, '1');
  result = completed(execute(result.state, button('go')));
  assert.equal(result.state.runtime.values.B.value, '1');
});

test('list operations validate indexes and update the value atomically', () => {
  const items = { id: 'Items', name: 'Items', kind: 'stored', type: 'list', listItemType: 'integer', initialValue: { type: 'list', itemType: 'integer', value: [integer(1), integer(2)] } };
  let state = createInitialProjectState(config([items], [rule('list', { type: 'button', id: 'go' }, [
    { type: 'listAdd', parameterId: 'Items', expression: literal(3) },
    { type: 'listReplace', parameterId: 'Items', index: literal(0), expression: literal(4) },
    { type: 'listRemove', parameterId: 'Items', index: literal(1) },
  ])]));
  state = completed(execute(state, button('go'))).state;
  assert.deepEqual(state.runtime.values.Items.value.map((item) => item.value), ['4', '3']);
  const bad = createInitialProjectState(config([items], [rule('bad-index', { type: 'button', id: 'go' }, [
    { type: 'listRemove', parameterId: 'Items', index: literal(9) },
  ])]));
  assert.throws(() => execute(bad, button('go')), /out of range/);
});

test('date and duration arithmetic is canonical', () => {
  const date = { id: 'Date', name: 'Date', kind: 'stored', type: 'date', initialValue: { type: 'date', value: '2024-02-28' } };
  const nextDate = { id: 'Next', name: 'Next', kind: 'computed', type: 'date', initialValue: { type: 'date', value: '2024-01-01' }, formula: binary('+', reference('Date'), { kind: 'literal', value: { type: 'duration', value: '86400000' } }) };
  const state = createInitialProjectState(config([date, nextDate]));
  assert.equal(state.runtime.values.Next.value, '2024-02-29');
});

test('long chains suspend in bounded slices and can be cancelled without exposing changes', () => {
  const state = createInitialProjectState(config([parameter('A', 0)], [
    rule('start', { type: 'button', id: 'go' }, [{ type: 'add', parameterId: 'A', expression: literal(1) }]),
    rule('until-target', { type: 'changed', parameterId: 'A' }, [{ type: 'add', parameterId: 'A', expression: literal(1) }], binary('<', reference('A'), literal(2500)), 1),
  ]));
  let result = execute(state, button('go'), { maxActionsPerSlice: 17 });
  let slices = 1;
  while (result.status === 'suspended') { result = result.continue(17); slices++; }
  assert.ok(slices > 100);
  assert.equal(result.state.runtime.values.A.value, '2500');
  assert.equal(result.changes.length, 2500);
  let suspended = execute(state, button('go'), { maxActionsPerSlice: 1 });
  assert.equal(suspended.status, 'suspended');
  suspended.cancel();
  assert.equal(state.runtime.values.A.value, '0');
  assert.throws(() => suspended.continue(), /cancelled/);
});

test('root assigned events update stored values before assigned-event rules', () => {
  const state = createInitialProjectState(config([parameter('N', 0)], [
    rule('after-assign', { type: 'assigned', parameterId: 'N' }, [
      { type: 'add', parameterId: 'N', expression: literal(1) },
    ]),
  ]));
  const result = completed(execute(state, { type: 'assigned', sourceId: 'N', newValue: integer(4) }));
  assert.equal(result.state.runtime.values.N.value, '5');
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes[0].ruleId, null);
  assert.equal(result.changes[1].ruleId, 'after-assign');
});

test('equal assignments emit assignment events but no changed event', () => {
  const state = createInitialProjectState(config([parameter('A', 4)], [rule('same', { type: 'button', id: 'go' }, [
    { type: 'set', parameterId: 'A', expression: literal(4) },
  ])]));
  const result = completed(execute(state, button('go')));
  assert.equal(result.changes.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), ['button', 'assigned']);
});

test('reset supports all or selected stored parameters and emits normal changes', () => {
  const state = createInitialProjectState(config([
    { ...parameter('A', 5), initialValue: integer(0) },
    { ...parameter('B', 9), initialValue: integer(2) },
  ]));
  const changed = completed(execute(state, button('unused'), { maxActionsPerSlice: 1 }));
  const populated = { ...changed.state, runtime: { ...changed.state.runtime, values: { A: integer(5), B: integer(9) } } };
  const selected = completed(resetParameters(populated, ['A']));
  assert.equal(selected.state.runtime.values.A.value, '0');
  assert.equal(selected.state.runtime.values.B.value, '9');
  assert.equal(selected.changes[0].ruleId, null);
  const all = completed(resetParameters(selected.state));
  assert.equal(all.state.runtime.values.A.value, '0');
  assert.equal(all.state.runtime.values.B.value, '2');
});

test('input action suspends an atomic chain until typed input is submitted', () => {
  const state = createInitialProjectState(config([parameter('A', 0), parameter('B', 0)], [
    rule('prompt', { type: 'button', id: 'go' }, [
      { type: 'add', parameterId: 'A', expression: literal(5) },
      { type: 'input', parameterId: 'A', prompt: 'Новое значение A' },
      { type: 'set', parameterId: 'B', expression: reference('A') },
    ]),
  ]));
  const pending = execute(state, button('go'));
  assert.equal(pending.status, 'suspended');
  assert.equal(pending.reason, 'input');
  assert.deepEqual(pending.inputRequest, { parameterId: 'A', parameterName: 'A', parameterType: 'integer', prompt: 'Новое значение A' });
  assert.equal(state.runtime.values.A.value, '0');
  assert.throws(() => pending.continue(), /waiting for input/);
  assert.throws(() => pending.submitInput({ type: 'decimal', value: '2.5' }), /Type mismatch: expected integer/);
  const completedResult = completed(pending.submitInput(integer(12)));
  assert.equal(completedResult.state.runtime.values.A.value, '12');
  assert.equal(completedResult.state.runtime.values.B.value, '12');
  assert.equal(completedResult.changes[0].oldValue.value, '0');
  assert.equal(completedResult.changes[0].newValue.value, '5');
  assert.equal(completedResult.changes[1].newValue.value, '12');
  assert.equal(state.runtime.values.A.value, '0');
  assert.equal(state.runtime.values.B.value, '0');
});

test('cancelling while waiting for input discards the entire draft', () => {
  const state = createInitialProjectState(config([parameter('A', 0)], [
    rule('prompt', { type: 'button', id: 'go' }, [
      { type: 'add', parameterId: 'A', expression: literal(5) },
      { type: 'input', parameterId: 'A', prompt: 'Значение' },
    ]),
  ]));
  const pending = execute(state, button('go'));
  assert.equal(pending.status, 'suspended');
  pending.cancel();
  assert.throws(() => pending.submitInput(integer(9)), /cancelled/i);
  assert.equal(state.runtime.values.A.value, '0');
});

test('temporary input variables are available to following actions but never persisted', () => {
  const state = createInitialProjectState(config([parameter('A', 0)], [
    rule('temporary', { type: 'button', id: 'go' }, [
      { type: 'input', variableName: 'amount', variableType: 'integer', prompt: 'Количество' },
      { type: 'add', parameterId: 'A', expression: parseExpression('$amount') },
    ]),
  ]));
  const pending = execute(state, button('go'));
  assert.equal(pending.status, 'suspended');
  assert.deepEqual(pending.inputRequest, { variableName: 'amount', parameterType: 'integer', prompt: 'Количество' });
  const result = completed(pending.submitInput(integer(7)));
  assert.equal(result.state.runtime.values.A.value, '7');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].parameterId, 'A');
  assert.equal(Object.hasOwn(result.state.runtime.values, '__local_amount'), false);
});

test('temporary input variables are scoped to later actions and cancellation drops them', () => {
  assert.throws(() => validateProjectConfiguration(config([parameter('A', 0)], [rule('forward', { type: 'button', id: 'go' }, [
    { type: 'add', parameterId: 'A', expression: parseExpression('$amount') },
    { type: 'input', variableName: 'amount', variableType: 'integer', prompt: '?' },
  ])])), /Unknown parameter or temporary variable/);
  const state = createInitialProjectState(config([parameter('A', 0)], [rule('temporary', { type: 'button', id: 'go' }, [
    { type: 'input', variableName: 'amount', variableType: 'integer', prompt: '?' },
    { type: 'add', parameterId: 'A', expression: parseExpression('$amount') },
  ])]));
  const pending = execute(state, button('go'));
  pending.cancel();
  assert.equal(state.runtime.values.A.value, '0');
});

test('input action rejects computed, list, and timer parameters during configuration validation', () => {
  const list = { id: 'Items', name: 'Items', kind: 'stored', type: 'list', listItemType: 'integer', initialValue: { type: 'list', itemType: 'integer', value: [] } };
  const timer = { id: 'Timer', name: 'Timer', kind: 'stored', type: 'timer', initialValue: { type: 'timer', value: { elapsedMilliseconds: '0', initialMilliseconds: '0', direction: 'up', status: 'stopped', allowNegative: false } } };
  assert.throws(() => validateProjectConfiguration(config([parameter('A', 0), { ...parameter('C', 0), kind: 'computed', formula: literal(0) }], [rule('computed', { type: 'button', id: 'go' }, [{ type: 'input', parameterId: 'C', prompt: '?' }])])), /read-only/);
  assert.throws(() => validateProjectConfiguration(config([list], [rule('list', { type: 'button', id: 'go' }, [{ type: 'input', parameterId: 'Items', prompt: '?' }])])), /not supported for list/);
  assert.throws(() => validateProjectConfiguration(config([timer], [rule('timer', { type: 'button', id: 'go' }, [{ type: 'input', parameterId: 'Timer', prompt: '?' }])])), /not supported for timer/);
});

test('periodic scheduler restores all, latest-only, or skipped missed intervals', () => {
  const anchor = Date.parse('2026-01-01T00:00:00.000Z');
  const state = createInitialProjectState(config([], ['all', 'once', 'skip'].map((missedPolicy) => rule(missedPolicy, {
    type: 'periodic', intervalMilliseconds: '300000', anchorAt: new Date(anchor).toISOString(), missedPolicy,
  }, []))));
  const events = dueScheduleEvents(state, anchor + 20 * 60_000);
  assert.deepEqual(events.filter((event) => event.ruleId === 'all').map((event) => event.occurredAt), [
    5, 10, 15, 20,
  ].map((minute) => new Date(anchor + minute * 60_000).toISOString()));
  assert.equal(events.find((event) => event.ruleId === 'once').occurredAt, new Date(anchor + 20 * 60_000).toISOString());
  assert.equal(events.find((event) => event.ruleId === 'skip').skipped, true);
});

test('calendar scheduler handles local daily time and daylight-saving gaps and overlap', () => {
  const makeState = (localTime, anchorAt) => createInitialProjectState(config([], [rule('daily', {
    type: 'calendar', recurrence: 'daily', localTime, timeZone: 'America/New_York', anchorAt,
    missedPolicy: 'all',
  }, [])]));
  const springAnchor = '2026-03-07T00:00:00.000Z';
  const springState = makeState('02:30', springAnchor);
  const spring = dueScheduleEvents(springState, Date.parse('2026-03-09T12:00:00.000Z'));
  assert.deepEqual(spring.map((event) => event.occurredAt), ['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
  const fallState = makeState('01:30', '2026-11-01T00:00:00.000Z');
  const fall = dueScheduleEvents(fallState, Date.parse('2026-11-01T12:00:00.000Z'));
  assert.deepEqual(fall.map((event) => event.occurredAt), ['2026-11-01T05:30:00.000Z']);
});

test('schedule event commits its cursor once and runs the matching rule', () => {
  const anchorAt = '2026-01-01T00:00:00.000Z';
  const state = createInitialProjectState(config([parameter('N', 0)], [rule('tick', {
    type: 'periodic', intervalMilliseconds: '1000', anchorAt, missedPolicy: 'all',
  }, [{ type: 'add', parameterId: 'N', expression: literal(1) }])]));
  const due = dueScheduleEvents(state, Date.parse(anchorAt) + 1000)[0];
  const result = completed(execute(state, { type: 'scheduleTick', sourceId: due.ruleId, occurredAt: due.occurredAt, skipped: due.skipped }));
  assert.equal(result.state.runtime.values.N.value, '1');
  assert.equal(result.state.runtime.scheduleCursors.tick, due.occurredAt);
  assert.throws(() => execute(result.state, { type: 'scheduleTick', sourceId: due.ruleId, occurredAt: due.occurredAt }), /already processed/);
});

test('timer control actions start, pause, reset timers without blocking parameter visibility', () => {
  const timer = { id: 'Timer', name: 'Timer', kind: 'stored', type: 'timer', initialValue: { type: 'timer', value: { elapsedMilliseconds: '100000', initialMilliseconds: '100000', direction: 'down', status: 'stopped', allowNegative: false } } };
  const state = createInitialProjectState(config([timer], [rule('control', { type: 'button', id: 'timer-controls' }, [
    { type: 'timerControl', parameterId: 'Timer', command: 'start' },
    { type: 'timerControl', parameterId: 'Timer', command: 'pause' },
    { type: 'timerControl', parameterId: 'Timer', command: 'reset' },
  ])]));
  assert.equal(completed(execute(state, button('timer-controls'))).state.runtime.values.Timer.value.status, 'stopped');
});

test('timers read their duration in seconds from another parameter when started or reset', () => {
  const seconds = parameter('Seconds', 90);
  const timer = { id: 'Timer', name: 'Timer', kind: 'stored', type: 'timer', timerDurationParameterId: 'Seconds', initialValue: { type: 'timer', value: { elapsedMilliseconds: '1000', initialMilliseconds: '1000', direction: 'down', status: 'stopped', allowNegative: false } } };
  const result = completed(execute(createInitialProjectState(config([seconds, timer], [rule('start', { type: 'button', id: 'start' }, [{ type: 'timerControl', parameterId: 'Timer', command: 'start' }])])), button('start')));
  assert.equal(result.state.runtime.values.Timer.value.elapsedMilliseconds, '90000');
  assert.equal(result.state.runtime.values.Timer.value.initialMilliseconds, '90000');
});

test('timers accept a time parameter as elapsed time since midnight', () => {
  const clockValue = { id: 'Clock', name: 'Clock', kind: 'stored', type: 'time', initialValue: { type: 'time', value: '01:02:03.450' } };
  const timer = { id: 'Timer', name: 'Timer', kind: 'stored', type: 'timer', timerDurationParameterId: 'Clock', initialValue: { type: 'timer', value: { elapsedMilliseconds: '0', initialMilliseconds: '0', direction: 'down', status: 'stopped', allowNegative: false } } };
  const result = completed(execute(createInitialProjectState(config([clockValue, timer], [rule('start', { type: 'button', id: 'start' }, [{ type: 'timerControl', parameterId: 'Timer', command: 'start' }])])), button('start')));
  assert.equal(result.state.runtime.values.Timer.value.elapsedMilliseconds, '3723450');
  assert.equal(result.state.runtime.values.Timer.value.initialMilliseconds, '3723450');
});
