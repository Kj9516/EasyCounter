const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Decimal, EngineExecutionError, execute } = require('../.test-build/engine/index.js');

const integer = (value) => ({ type: 'integer', value: String(value) });
const decimal = (value) => ({ type: 'decimal', value: String(value) });
const literal = (value) => ({ kind: 'literal', value: integer(value) });
const reference = (id) => ({ kind: 'parameter', id });
const binary = (op, left, right) => ({ kind: 'binary', op, left, right });
const parameter = (id, value, type = 'integer') => ({
  id,
  name: id,
  type,
  value: type === 'integer' ? integer(value) : decimal(value),
  initialValue: type === 'integer' ? integer(value) : decimal(value),
});
const rule = (id, eventSource, actions, condition) => ({
  id,
  name: id,
  enabled: true,
  order: 0,
  eventSource,
  actions,
  condition,
});
const button = (id) => ({ type: 'button', sourceId: id });
const completed = (result) => {
  assert.equal(result.status, 'completed');
  return result;
};

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
  let state = {
    parameters: [parameter('N', 0)],
    rules: [rule('plus', { type: 'button', id: 'plus' }, [
      { type: 'add', parameterId: 'N', expression: literal(5) },
    ])],
  };
  for (let index = 0; index < 3; index++) state = completed(execute(state, button('plus'))).state;
  assert.equal(state.parameters[0].value.value, '15');
});

test('actions are sequential and preserve every change event snapshot in FIFO order', () => {
  const result = completed(execute({
    parameters: [parameter('A', 0), parameter('B', 0)],
    rules: [
      rule('button', { type: 'button', id: 'go' }, [
        { type: 'set', parameterId: 'A', expression: literal(5) },
        { type: 'set', parameterId: 'A', expression: literal(10) },
        { type: 'set', parameterId: 'A', expression: literal(15) },
      ]),
      rule('on-change', { type: 'changed', parameterId: 'A' }, [
        { type: 'add', parameterId: 'B', expression: literal(1) },
      ]),
    ],
  }, button('go')));

  assert.deepEqual(result.changes.filter((change) => change.parameterId === 'A')
    .map(({ oldValue, newValue }) => [oldValue.value, newValue.value]), [
    ['0', '5'], ['5', '10'], ['10', '15'],
  ]);
  assert.equal(result.state.parameters.find((item) => item.id === 'B').value.value, '3');
  assert.deepEqual(result.events.filter((event) => event.type === 'changed')
    .map(({ sourceId, oldValue, newValue }) => [sourceId, oldValue.value, newValue.value]), [
    ['A', '0', '5'], ['A', '5', '10'], ['A', '10', '15'],
    ['B', '0', '1'], ['B', '1', '2'], ['B', '2', '3'],
  ]);
  assert.ok(result.events.every((event) => typeof event.occurredAt === 'string'));
});

test('rule order follows the configured order and actions see prior changes', () => {
  const result = completed(execute({
    parameters: [parameter('Gold', 100), parameter('Silver', 50)],
    rules: [rule('sequence', { type: 'button', id: 'go' }, [
      { type: 'set', parameterId: 'Gold', expression: binary('*', reference('Gold'), literal(2)) },
      { type: 'set', parameterId: 'Silver', expression: binary('+', reference('Silver'), binary('-', reference('Silver'), reference('Gold'))) },
    ])],
  }, button('go')));
  assert.equal(result.state.parameters.find((item) => item.id === 'Gold').value.value, '200');
  assert.equal(result.state.parameters.find((item) => item.id === 'Silver').value.value, '-100');
});

test('numeric conversion and floor produce correct integer results', () => {
  const result = completed(execute({
    parameters: [parameter('Cents', 95), parameter('Dollars', 0)],
    rules: [rule('convert', { type: 'button', id: 'add' }, [
      { type: 'add', parameterId: 'Cents', expression: literal(250) },
      { type: 'add', parameterId: 'Dollars', expression: { kind: 'call', fn: 'floor', args: [binary('/', reference('Cents'), literal(100))] } },
      { type: 'set', parameterId: 'Cents', expression: { kind: 'binary', op: 'mod', left: reference('Cents'), right: literal(100) } },
    ])],
  }, button('add')));
  assert.equal(result.state.parameters.find((item) => item.id === 'Cents').value.value, '45');
  assert.equal(result.state.parameters.find((item) => item.id === 'Dollars').value.value, '3');
});

test('failure reports rule and action details and leaves caller state unchanged', () => {
  const state = {
    parameters: [parameter('A', 0)],
    rules: [rule('fail', { type: 'button', id: 'go' }, [
      { type: 'set', parameterId: 'A', expression: literal(5) },
      { type: 'set', parameterId: 'A', expression: binary('/', literal(1), literal(0)) },
    ])],
  };
  let failure;
  try {
    execute(state, button('go'));
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof EngineExecutionError);
  assert.equal(failure.details.ruleId, 'fail');
  assert.equal(failure.details.actionIndex, 1);
  assert.match(failure.message, /Division by zero/);
  assert.equal(state.parameters[0].value.value, '0');
});

test('a long chain suspends in slices and can continue to completion without a total step limit', () => {
  let result = execute({
    parameters: [parameter('A', 0)],
    rules: [
      rule('start', { type: 'button', id: 'go' }, [
        { type: 'add', parameterId: 'A', expression: literal(1) },
      ]),
      {
        ...rule('until-target', { type: 'changed', parameterId: 'A' }, [
          { type: 'add', parameterId: 'A', expression: literal(1) },
        ], binary('<', reference('A'), literal(2500))),
        order: 1,
      },
    ],
  }, button('go'), { maxActionsPerSlice: 17 });

  let slices = 1;
  while (result.status === 'suspended') {
    result = result.continue(17);
    slices++;
  }
  assert.ok(slices > 100);
  assert.equal(result.state.parameters[0].value.value, '2500');
  assert.equal(result.changes.length, 2500);
});

test('cancelling a suspended chain does not expose partial state', () => {
  const state = {
    parameters: [parameter('A', 0)],
    rules: [
      rule('start', { type: 'button', id: 'go' }, [
        { type: 'add', parameterId: 'A', expression: literal(1) },
      ]),
      { ...rule('loop', { type: 'changed', parameterId: 'A' }, [
        { type: 'add', parameterId: 'A', expression: literal(1) },
      ]), order: 1 },
    ],
  };
  const result = execute(state, button('go'), { maxActionsPerSlice: 2 });
  assert.equal(result.status, 'suspended');
  result.cancel();
  assert.equal(state.parameters[0].value.value, '0');
  assert.throws(() => result.continue(), /cancelled/);
});

test('a suspended operation keeps its own snapshot of configuration and values', () => {
  const state = {
    parameters: [parameter('A', 0)],
    rules: [rule('two-actions', { type: 'button', id: 'go' }, [
      { type: 'add', parameterId: 'A', expression: literal(1) },
      { type: 'add', parameterId: 'A', expression: literal(2) },
    ])],
  };
  let result = execute(state, button('go'), { maxActionsPerSlice: 1 });
  assert.equal(result.status, 'suspended');
  state.parameters[0].value = integer(999);
  state.rules[0].actions[1].expression = literal(1000);
  result = result.continue(1);
  assert.equal(result.status, 'completed');
  assert.equal(result.state.parameters[0].value.value, '3');
});

test('equal assignments do not create change events', () => {
  const result = completed(execute({
    parameters: [parameter('A', 4)],
    rules: [rule('same', { type: 'button', id: 'go' }, [
      { type: 'set', parameterId: 'A', expression: literal(4) },
    ])],
  }, button('go')));
  assert.equal(result.changes.length, 0);
  assert.equal(result.events.length, 1);
});
