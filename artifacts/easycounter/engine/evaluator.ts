import { Decimal } from './decimal';
import type {
  EngineEvent,
  Expr,
  Parameter,
  PrimitiveType,
  ScalarType,
  ScalarValue,
  Value,
} from './types';

export interface ExpressionType {
  type: PrimitiveType;
  listItemType?: ScalarType;
}

const DAY_MILLISECONDS = 86_400_000n;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/;
const datetimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const durationPattern = /^[+-]?\d+$/;

function decimalValue(value: Decimal, type: 'integer' | 'decimal' = 'decimal'): Value {
  return { type, value: value.toString() };
}

function booleanValue(value: boolean): Value {
  return { type: 'boolean', value };
}

function numeric(value: Value): Decimal {
  if (value.type !== 'integer' && value.type !== 'decimal') {
    throw new Error(`Numeric value required, got ${value.type}`);
  }
  return Decimal.parse(value.value);
}

export function canonicalizeValue(value: Value, expectedType?: PrimitiveType, listItemType?: ScalarType): Value {
  if (expectedType && value.type !== expectedType) {
    if (expectedType === 'decimal' && value.type === 'integer') {
      return { type: 'decimal', value: Decimal.parse(value.value).toString() };
    }
    throw new Error(`Type mismatch: expected ${expectedType}, got ${value.type}`);
  }

  switch (value.type) {
    case 'integer': {
      const decimal = Decimal.parse(value.value);
      if (decimal.scale !== 0) throw new Error('Integer value must not have a fractional part');
      return { type: 'integer', value: decimal.toString() };
    }
    case 'decimal':
      return { type: 'decimal', value: Decimal.parse(value.value).toString() };
    case 'duration': {
      if (!durationPattern.test(value.value)) throw new Error('Duration must be an integer number of milliseconds');
      return { type: 'duration', value: BigInt(value.value).toString() };
    }
    case 'date': {
      if (!datePattern.test(value.value)) throw new Error('Date must use YYYY-MM-DD format');
      const time = Date.parse(`${value.value}T00:00:00.000Z`);
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.value) {
        throw new Error('Invalid calendar date');
      }
      return { ...value };
    }
    case 'time': {
      if (!timePattern.test(value.value)) throw new Error('Time must use HH:mm, HH:mm:ss, or HH:mm:ss.SSS format');
      const milliseconds = parseTime(value.value);
      return { type: 'time', value: formatTime(milliseconds) };
    }
    case 'datetime': {
      if (!datetimePattern.test(value.value)) throw new Error('Datetime must be ISO 8601 with an explicit timezone');
      const timestamp = Date.parse(value.value);
      if (!Number.isFinite(timestamp)) throw new Error('Invalid datetime');
      return { type: 'datetime', value: new Date(timestamp).toISOString() };
    }
    case 'string':
    case 'boolean':
      return { ...value };
    case 'timer': {
      if (!durationPattern.test(value.value.elapsedMilliseconds)
        || !durationPattern.test(value.value.initialMilliseconds)
        || !Number.isSafeInteger(value.value.startedAt ?? 0)
        || typeof value.value.allowNegative !== 'boolean') {
        throw new Error('Invalid timer state');
      }
      return { type: 'timer', value: { ...value.value } };
    }
    case 'list': {
      if (expectedType && expectedType !== 'list') throw new Error(`Type mismatch: expected ${expectedType}, got list`);
      if (listItemType && value.itemType !== listItemType) {
        throw new Error(`List item type mismatch: expected ${listItemType}, got ${value.itemType}`);
      }
      const itemType = listItemType ?? value.itemType;
      return {
        type: 'list',
        itemType,
        value: value.value.map((item) => {
          if (item.type !== itemType) throw new Error(`List item type mismatch: expected ${itemType}, got ${item.type}`);
          return canonicalizeValue(item) as ScalarValue;
        }),
      };
    }
  }
}

function parseTime(value: string): number {
  const [hoursText, minutesText, secondsText = '0'] = value.split(':');
  const [secondsWholeText, millisecondsText = '0'] = secondsText.split('.');
  const milliseconds = Number(millisecondsText.padEnd(3, '0'));
  return Number(hoursText) * 3_600_000
    + Number(minutesText) * 60_000
    + Number(secondsWholeText) * 1000
    + milliseconds;
}

function formatTime(milliseconds: number): string {
  const normalized = ((milliseconds % 86_400_000) + 86_400_000) % 86_400_000;
  const hours = Math.floor(normalized / 3_600_000).toString().padStart(2, '0');
  const minutes = Math.floor((normalized % 3_600_000) / 60_000).toString().padStart(2, '0');
  const seconds = Math.floor((normalized % 60_000) / 1000).toString().padStart(2, '0');
  const fraction = (normalized % 1000).toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${fraction}`;
}

function sameType(left: ExpressionType, right: ExpressionType): boolean {
  return left.type === right.type
    && (left.type !== 'list' || left.listItemType === right.listItemType);
}

function expressionType(value: Value): ExpressionType {
  return { type: value.type, ...(value.type === 'list' ? { listItemType: value.itemType } : {}) };
}

function numericType(type: PrimitiveType): boolean {
  return type === 'integer' || type === 'decimal';
}

function inferBinaryType(op: string, left: ExpressionType, right: ExpressionType): ExpressionType {
  if (op === 'and' || op === 'or') {
    if (left.type !== 'boolean' || right.type !== 'boolean') throw new Error(`${op} requires boolean operands`);
    return { type: 'boolean' };
  }
  if (['==', '!=', '>', '>=', '<', '<='].includes(op)) {
    const numericPair = numericType(left.type) && numericType(right.type);
    if (!numericPair && !sameType(left, right)) throw new Error(`Cannot compare ${left.type} with ${right.type}`);
    if (['>', '>=', '<', '<='].includes(op)
      && !(numericPair || ['date', 'time', 'datetime', 'duration'].includes(left.type))) {
      throw new Error(`Operator ${op} is not supported for ${left.type}`);
    }
    if (left.type === 'timer' || left.type === 'list') {
      throw new Error(`Comparison is not supported for ${left.type}`);
    }
    return { type: 'boolean' };
  }

  if (op === '+' || op === '-') {
    if (numericType(left.type) && numericType(right.type)) {
      return { type: left.type === 'integer' && right.type === 'integer' ? 'integer' : 'decimal' };
    }
    if (op === '+' && left.type === 'duration' && right.type === 'duration') return { type: 'duration' };
    if (op === '-' && left.type === 'duration' && right.type === 'duration') return { type: 'duration' };
    if (op === '-' && left.type === right.type && ['date', 'time', 'datetime'].includes(left.type)) {
      return { type: 'duration' };
    }
    if (right.type === 'duration' && ['date', 'time', 'datetime'].includes(left.type)) return { type: left.type };
    if (op === '+' && left.type === 'duration' && ['date', 'time', 'datetime'].includes(right.type)) {
      return { type: right.type };
    }
    throw new Error(`Operator ${op} is not supported for ${left.type} and ${right.type}`);
  }

  if (['*', '/', 'mod'].includes(op)) {
    if (!numericType(left.type) || !numericType(right.type)) throw new Error(`${op} requires numeric operands`);
    if (op === '/') return { type: 'decimal' };
    return { type: left.type === 'integer' && right.type === 'integer' ? 'integer' : 'decimal' };
  }
  throw new Error(`Unknown operator ${op}`);
}

export function inferExpressionType(
  expression: Expr,
  parameters: ReadonlyMap<string, Parameter>,
  eventParameter?: Parameter,
): ExpressionType {
  switch (expression.kind) {
    case 'literal':
      return expressionType(canonicalizeValue(expression.value));
    case 'parameter': {
      const parameter = parameters.get(expression.id);
      if (!parameter) throw new Error(`Unknown parameter ${expression.id}`);
      return { type: parameter.type, ...(parameter.type === 'list' ? { listItemType: parameter.listItemType } : {}) };
    }
    case 'event': {
      if (!eventParameter) throw new Error('Event values are not available in this expression');
      if (expression.field === 'delta') {
        if (numericType(eventParameter.type)) return { type: eventParameter.type };
        if (['date', 'time', 'datetime'].includes(eventParameter.type)) return { type: 'duration' };
        throw new Error(`Delta is not defined for ${eventParameter.type}`);
      }
      return {
        type: eventParameter.type,
        ...(eventParameter.type === 'list' ? { listItemType: eventParameter.listItemType } : {}),
      };
    }
    case 'unary': {
      const operand = inferExpressionType(expression.operand, parameters, eventParameter);
      if (expression.op === 'not') {
        if (operand.type !== 'boolean') throw new Error('not requires a boolean operand');
        return { type: 'boolean' };
      }
      if (!numericType(operand.type)) throw new Error('Unary minus requires a numeric operand');
      return operand;
    }
    case 'binary':
      return inferBinaryType(
        expression.op,
        inferExpressionType(expression.left, parameters, eventParameter),
        inferExpressionType(expression.right, parameters, eventParameter),
      );
    case 'call': {
      if (expression.fn === 'if') {
        if (expression.args.length !== 3) throw new Error('if expects three arguments');
        const condition = inferExpressionType(expression.args[0], parameters, eventParameter);
        if (condition.type !== 'boolean') throw new Error('if condition must be boolean');
        const whenTrue = inferExpressionType(expression.args[1], parameters, eventParameter);
        const whenFalse = inferExpressionType(expression.args[2], parameters, eventParameter);
        if (!sameType(whenTrue, whenFalse)) throw new Error('if branches must have the same type');
        return whenTrue;
      }
      const args = expression.args.map((item) => inferExpressionType(item, parameters, eventParameter));
      const one = (expected: PrimitiveType[], result: ExpressionType): ExpressionType => {
        if (args.length !== 1 || !expected.includes(args[0].type)) {
          throw new Error(`${expression.fn} expects one ${expected.join(' or ')} argument`);
        }
        return result;
      };
      switch (expression.fn) {
        case 'number': return one(['integer', 'decimal', 'string', 'boolean'], { type: 'decimal' });
        case 'text':
          if (args.length !== 1 || args[0].type === 'list' || args[0].type === 'timer') {
            throw new Error('text expects one scalar argument');
          }
          return { type: 'string' };
        case 'length': return one(['string', 'list'], { type: 'integer' });
        case 'floor': return one(['integer', 'decimal'], { type: 'integer' });
        case 'round': {
          if ((args.length !== 1 && args.length !== 2)
            || !numericType(args[0].type)
            || (args.length === 2 && args[1].type !== 'integer')) {
            throw new Error('round expects a number and optional integer precision');
          }
          return { type: args.length === 1 || args[0].type === 'integer' ? 'integer' : 'decimal' };
        }
        case 'abs': return one(['integer', 'decimal'], args[0]);
        case 'min':
        case 'max':
          if (args.length !== 2 || !numericType(args[0].type) || !numericType(args[1].type)) {
            throw new Error(`${expression.fn} expects two numeric arguments`);
          }
          return { type: args[0].type === 'integer' && args[1].type === 'integer' ? 'integer' : 'decimal' };
        case 'contains':
          if (args.length !== 2) throw new Error('contains expects two arguments');
          if (args[0].type === 'string' && args[1].type === 'string') return { type: 'boolean' };
          if (args[0].type === 'list' && args[0].listItemType === args[1].type) return { type: 'boolean' };
          throw new Error('contains expects text/text or list/item of the same type');
      }
    }
  }
}

function compare(left: Value, right: Value): number {
  if ((left.type === 'integer' || left.type === 'decimal')
    && (right.type === 'integer' || right.type === 'decimal')) {
    return Decimal.parse(left.value).compare(Decimal.parse(right.value));
  }
  if (left.type === 'duration' && right.type === 'duration') {
    const a = BigInt(left.value);
    const b = BigInt(right.value);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (left.type === right.type && ['string', 'date', 'time', 'datetime'].includes(left.type)) {
    const a = left.value as string;
    const b = right.value as string;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (left.type === 'boolean' && right.type === 'boolean') return Number(left.value) - Number(right.value);
  if (left.type === 'list' && right.type === 'list') return valueEquals(left, right) ? 0 : 1;
  if (left.type === 'timer' && right.type === 'timer') return valueEquals(left, right) ? 0 : 1;
  throw new Error(`Incompatible types: ${left.type} and ${right.type}`);
}

export function valueEquals(left: Value, right: Value): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'list' && right.type === 'list') {
    return left.itemType === right.itemType
      && left.value.length === right.value.length
      && left.value.every((item, index) => valueEquals(item, right.value[index]));
  }
  if (left.type === 'timer' && right.type === 'timer') {
    return left.value.elapsedMilliseconds === right.value.elapsedMilliseconds
      && left.value.initialMilliseconds === right.value.initialMilliseconds
      && left.value.direction === right.value.direction
      && left.value.status === right.value.status
      && left.value.allowNegative === right.value.allowNegative
      && left.value.startedAt === right.value.startedAt;
  }
  return left.value === right.value;
}

function durationMilliseconds(value: Value): bigint {
  if (value.type !== 'duration') throw new Error('Duration value expected');
  return BigInt(value.value);
}

function applyDuration(value: Value, duration: bigint, direction: 1n | -1n): Value {
  const offset = duration * direction;
  if (value.type === 'duration') return { type: 'duration', value: (BigInt(value.value) + offset).toString() };
  if (value.type === 'date') {
    if (offset % DAY_MILLISECONDS !== 0n) throw new Error('Date can only be shifted by a whole number of days');
    const timestamp = Date.parse(`${value.value}T00:00:00.000Z`);
    const next = BigInt(timestamp) + offset;
    if (next < -8_640_000_000_000_000n || next > 8_640_000_000_000_000n) throw new Error('Date is out of range');
    return { type: 'date', value: new Date(Number(next)).toISOString().slice(0, 10) };
  }
  if (value.type === 'datetime') {
    const next = BigInt(Date.parse(value.value)) + offset;
    if (next < -8_640_000_000_000_000n || next > 8_640_000_000_000_000n) throw new Error('Datetime is out of range');
    return { type: 'datetime', value: new Date(Number(next)).toISOString() };
  }
  if (value.type === 'time') return { type: 'time', value: formatTime(parseTime(value.value) + Number(offset % DAY_MILLISECONDS)) };
  throw new Error(`Cannot add a duration to ${value.type}`);
}

function subtractTemporal(left: Value, right: Value): Value {
  if (left.type === 'duration' && right.type === 'duration') {
    return { type: 'duration', value: (BigInt(left.value) - BigInt(right.value)).toString() };
  }
  if (left.type === 'date' && right.type === 'date') {
    return { type: 'duration', value: (BigInt(Date.parse(`${left.value}T00:00:00.000Z`)) - BigInt(Date.parse(`${right.value}T00:00:00.000Z`))).toString() };
  }
  if (left.type === 'datetime' && right.type === 'datetime') {
    return { type: 'duration', value: (BigInt(Date.parse(left.value)) - BigInt(Date.parse(right.value))).toString() };
  }
  if (left.type === 'time' && right.type === 'time') {
    return { type: 'duration', value: (parseTime(left.value) - parseTime(right.value)).toString() };
  }
  if (right.type === 'duration') return applyDuration(left, BigInt(right.value), -1n);
  throw new Error(`Cannot subtract ${right.type} from ${left.type}`);
}

function applyBinary(op: string, left: Value, right: Value): Value {
  if (op === 'and' || op === 'or') {
    if (left.type !== 'boolean' || right.type !== 'boolean') throw new Error(`${op} requires boolean operands`);
    return booleanValue(op === 'and' ? left.value && right.value : left.value || right.value);
  }
  if (['==', '!=', '>', '>=', '<', '<='].includes(op)) {
    const order = compare(left, right);
    return booleanValue(op === '==' ? order === 0
      : op === '!=' ? order !== 0
        : op === '>' ? order > 0
          : op === '>=' ? order >= 0
            : op === '<' ? order < 0 : order <= 0);
  }
  if (op === '+' || op === '-') {
    if (left.type === 'duration') {
      if (right.type === 'duration' && op === '+') {
        return { type: 'duration', value: (BigInt(left.value) + BigInt(right.value)).toString() };
      }
      if (right.type === 'date' || right.type === 'time' || right.type === 'datetime') {
        if (op === '-') throw new Error('Cannot subtract a calendar value from a duration');
        return applyDuration(right, BigInt(left.value), 1n);
      }
    }
    if (right.type === 'duration' && (left.type === 'date' || left.type === 'time' || left.type === 'datetime')) {
      return applyDuration(left, BigInt(right.value), op === '+' ? 1n : -1n);
    }
    if (op === '-' && ['duration', 'date', 'time', 'datetime'].includes(left.type)) {
      return subtractTemporal(left, right);
    }
    const a = numeric(left);
    const b = numeric(right);
    const result = op === '+' ? a.add(b) : a.sub(b);
    return decimalValue(result, left.type === 'integer' && right.type === 'integer' ? 'integer' : 'decimal');
  }
  if (op === '*' || op === '/' || op === 'mod') {
    const a = numeric(left);
    const b = numeric(right);
    if (op === '*') return decimalValue(a.mul(b), left.type === 'integer' && right.type === 'integer' ? 'integer' : 'decimal');
    if (op === '/') return decimalValue(a.div(b));
    return decimalValue(a.mod(b), left.type === 'integer' && right.type === 'integer' ? 'integer' : 'decimal');
  }
  throw new Error(`Unsupported operator ${op}`);
}

export function evaluate(
  expression: Expr,
  parameters: ReadonlyMap<string, Value>,
  event?: EngineEvent,
): Value {
  switch (expression.kind) {
    case 'literal':
      return canonicalizeValue(expression.value);
    case 'parameter': {
      const value = parameters.get(expression.id);
      if (!value) throw new Error(`Unknown parameter ${expression.id}`);
      return value;
    }
    case 'event': {
      if (!event || (event.type !== 'changed' && event.type !== 'assigned')) {
        throw new Error('Change event context required');
      }
      if (expression.field === 'oldValue') {
        if (!event.oldValue) throw new Error('Change event has no old value');
        return event.oldValue;
      }
      if (expression.field === 'newValue') {
        if (!event.newValue) throw new Error('Change event has no new value');
        return event.newValue;
      }
      if (!event.oldValue || !event.newValue) throw new Error('Change event requires old and new values for delta');
      return applyBinary('-', event.newValue, event.oldValue);
    }
    case 'unary': {
      const operand = evaluate(expression.operand, parameters, event);
      if (expression.op === 'not') {
        if (operand.type !== 'boolean') throw new Error('Boolean expected');
        return booleanValue(!operand.value);
      }
      return decimalValue(numeric(operand).negate(), operand.type === 'integer' ? 'integer' : 'decimal');
    }
    case 'binary': {
      const left = evaluate(expression.left, parameters, event);
      if (expression.op === 'and' || expression.op === 'or') {
        if (left.type !== 'boolean') throw new Error('Boolean expected');
        if (expression.op === 'and' && !left.value) return booleanValue(false);
        if (expression.op === 'or' && left.value) return booleanValue(true);
      }
      return applyBinary(expression.op, left, evaluate(expression.right, parameters, event));
    }
    case 'call': {
      if (expression.fn === 'if') {
        if (expression.args.length !== 3) throw new Error('if expects three arguments');
        const condition = evaluate(expression.args[0], parameters, event);
        if (condition.type !== 'boolean') throw new Error('if condition must be boolean');
        return evaluate(expression.args[condition.value ? 1 : 2], parameters, event);
      }
      const args = expression.args.map((item) => evaluate(item, parameters, event));
      if (expression.fn === 'number') {
        if (args.length !== 1) throw new Error('number expects one argument');
        const value = args[0];
        if (value.type === 'boolean') return decimalValue(Decimal.parse(value.value ? 1 : 0));
        if (value.type !== 'string' && value.type !== 'integer' && value.type !== 'decimal') {
          throw new Error(`Cannot convert ${value.type} to a number`);
        }
        return decimalValue(Decimal.parse(value.value));
      }
      if (expression.fn === 'text') {
        if (args.length !== 1 || args[0].type === 'list' || args[0].type === 'timer') {
          throw new Error('text expects one scalar argument');
        }
        return { type: 'string', value: String(args[0].value) };
      }
      if (expression.fn === 'length') {
        if (args.length !== 1 || (args[0].type !== 'string' && args[0].type !== 'list')) {
          throw new Error('length expects text or a list');
        }
        const length = args[0].type === 'string' ? [...args[0].value].length : args[0].value.length;
        return decimalValue(Decimal.parse(length), 'integer');
      }
      if (expression.fn === 'contains') {
        if (args.length !== 2) throw new Error('contains expects two arguments');
        if (args[0].type === 'string' && args[1].type === 'string') {
          return booleanValue(args[0].value.includes(args[1].value));
        }
        if (args[0].type === 'list' && args[0].itemType === args[1].type) {
          return booleanValue(args[0].value.some((item) => valueEquals(item, args[1])));
        }
        throw new Error('contains expects text/text or list/item of the same type');
      }
      if (expression.fn === 'floor' || expression.fn === 'round' || expression.fn === 'abs') {
        if (args.length < 1 || args.length > (expression.fn === 'round' ? 2 : 1)) {
          throw new Error(`${expression.fn} received the wrong number of arguments`);
        }
        const value = args[0];
        const number = numeric(value);
        if (expression.fn === 'floor') return decimalValue(number.floor(), 'integer');
        if (expression.fn === 'round') {
          const precision = args.length === 2 ? numeric(args[1]).toString() : '0';
          if (!/^-?\d+$/.test(precision) || Number(precision) < 0 || Number(precision) > 1000) {
            throw new Error('round precision must be an integer from 0 to 1000');
          }
          const rounded = number.round(Number(precision));
          return decimalValue(rounded, Number(precision) === 0 ? 'integer' : value.type === 'integer' ? 'integer' : 'decimal');
        }
        return decimalValue(number.abs(), value.type === 'integer' ? 'integer' : 'decimal');
      }
      if (expression.fn === 'min' || expression.fn === 'max') {
        if (args.length !== 2) throw new Error(`${expression.fn} expects two arguments`);
        const order = numeric(args[0]).compare(numeric(args[1]));
        const selected = expression.fn === 'min'
          ? (order <= 0 ? args[0] : args[1])
          : (order >= 0 ? args[0] : args[1]);
        return decimalValue(
          numeric(selected),
          args[0].type === 'integer' && args[1].type === 'integer' ? 'integer' : 'decimal',
        );
      }
      throw new Error(`Unknown function ${expression.fn}`);
    }
  }
}
