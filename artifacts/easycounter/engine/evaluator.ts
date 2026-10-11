import { Decimal } from './decimal';
import type { EngineEvent, Expr, Parameter, Value } from './types';

const booleanValue = (value: boolean): Value => ({ type: 'boolean', value });
const decimalValue = (value: Decimal, type: 'integer' | 'decimal' = 'decimal'): Value => ({
  type,
  value: value.toString(),
});
const isNumeric = (value: Value): value is Extract<Value, { type: 'integer' | 'decimal' }> =>
  value.type === 'integer' || value.type === 'decimal';

function numeric(value: Value): Decimal {
  if (!isNumeric(value)) throw new Error(`Numeric value required, got ${value.type}`);
  return Decimal.parse(value.value);
}

function compare(left: Value, right: Value): number {
  if (left.type === 'string' && right.type === 'string') {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  if (left.type === 'boolean' && right.type === 'boolean') {
    return Number(left.value) - Number(right.value);
  }
  if (isNumeric(left) && isNumeric(right)) {
    return numeric(left).compare(numeric(right));
  }
  throw new Error(`Incompatible types: ${left.type} and ${right.type}`);
}

function oneArgument(fn: string, args: Value[]): Value {
  if (args.length !== 1) throw new Error(`${fn} expects one argument`);
  return args[0];
}

export function evaluate(
  expression: Expr,
  parameters: ReadonlyMap<string, Parameter>,
  event?: EngineEvent,
): Value {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'parameter': {
      const parameter = parameters.get(expression.id);
      if (!parameter) throw new Error(`Unknown parameter ${expression.id}`);
      return parameter.value;
    }
    case 'event': {
      if (!event || event.type !== 'changed') {
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
      if (!event.oldValue || !event.newValue) {
        throw new Error('Change event requires old and new values for delta');
      }
      return decimalValue(numeric(event.newValue).sub(numeric(event.oldValue)));
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
        const right = evaluate(expression.right, parameters, event);
        if (right.type !== 'boolean') throw new Error('Boolean expected');
        return right;
      }

      const right = evaluate(expression.right, parameters, event);
      if (['==', '!=', '>', '>=', '<', '<='].includes(expression.op)) {
        const order = compare(left, right);
        switch (expression.op) {
          case '==': return booleanValue(order === 0);
          case '!=': return booleanValue(order !== 0);
          case '>': return booleanValue(order > 0);
          case '>=': return booleanValue(order >= 0);
          case '<': return booleanValue(order < 0);
          case '<=': return booleanValue(order <= 0);
        }
      }

      const leftNumber = numeric(left);
      const rightNumber = numeric(right);
      const resultType = left.type === 'integer' && right.type === 'integer' ? 'integer' : 'decimal';
      switch (expression.op) {
        case '+': return decimalValue(leftNumber.add(rightNumber), resultType);
        case '-': return decimalValue(leftNumber.sub(rightNumber), resultType);
        case '*': return decimalValue(leftNumber.mul(rightNumber), resultType);
        case '/': return decimalValue(leftNumber.div(rightNumber));
        case 'mod': return decimalValue(leftNumber.mod(rightNumber), resultType);
      }
      throw new Error('Unsupported operator');
    }
    case 'call': {
      const args = expression.args.map((item) => evaluate(item, parameters, event));
      switch (expression.fn) {
        case 'number': {
          const value = oneArgument('number', args);
          if (value.type === 'boolean') return decimalValue(Decimal.parse(value.value ? 1 : 0));
          return decimalValue(Decimal.parse(value.value));
        }
        case 'text': {
          const value = oneArgument('text', args);
          return { type: 'string', value: String(value.value) };
        }
        case 'length': {
          const value = oneArgument('length', args);
          if (value.type !== 'string') throw new Error('length expects text');
          return decimalValue(Decimal.parse([...value.value].length), 'integer');
        }
        case 'floor': {
          const value = oneArgument('floor', args);
          return decimalValue(numeric(value).floor(), 'integer');
        }
        case 'abs': {
          const value = oneArgument('abs', args);
          return decimalValue(numeric(value).abs(), value.type === 'integer' ? 'integer' : 'decimal');
        }
        case 'min':
        case 'max': {
          if (args.length !== 2) throw new Error(`${expression.fn} expects two arguments`);
          const left = numeric(args[0]);
          const right = numeric(args[1]);
          const order = left.compare(right);
          const selected = expression.fn === 'min'
            ? (order <= 0 ? args[0] : args[1])
            : (order >= 0 ? args[0] : args[1]);
          return decimalValue(
            numeric(selected),
            args[0].type === 'integer' && args[1].type === 'integer' ? 'integer' : 'decimal',
          );
      }
    }
  }
}
}
