import { Decimal } from './decimal';
import { evaluate } from './evaluator';
import type {
  Action,
  Change,
  EngineEvent,
  ExecutionResult,
  Expr,
  Parameter,
  ProjectState,
  Rule,
  SuspendedExecution,
  Value,
} from './types';
import { EngineExecutionError } from './types';

const DEFAULT_ACTIONS_PER_SLICE = 1000;

function copyExpression(expression: Expr): Expr {
  switch (expression.kind) {
    case 'literal': return { kind: 'literal', value: { ...expression.value } as Value };
    case 'parameter': return { ...expression };
    case 'event': return { ...expression };
    case 'unary': return { ...expression, operand: copyExpression(expression.operand) };
    case 'binary':
      return {
        ...expression,
        left: copyExpression(expression.left),
        right: copyExpression(expression.right),
      };
    case 'call': return { ...expression, args: expression.args.map(copyExpression) };
  }
}

function copyRule(rule: Rule): Rule {
  return {
    ...rule,
    eventSource: { ...rule.eventSource },
    condition: rule.condition ? copyExpression(rule.condition) : undefined,
    actions: rule.actions.map((action) => ({
      ...action,
      expression: copyExpression(action.expression),
    })),
  };
}

function normalize(value: Value, target: Parameter['type']): Value {
  if (value.type !== target) {
    throw new Error(`Type mismatch for parameter: expected ${target}, got ${value.type}`);
  }
  if (target === 'integer' || target === 'decimal') {
    if (value.type !== 'integer' && value.type !== 'decimal') {
      throw new Error(`Numeric value expected, got ${value.type}`);
    }
    const decimal = Decimal.parse(value.value);
    if (target === 'integer' && decimal.scale !== 0) throw new Error('Non-integer value');
    return { type: target, value: decimal.toString() };
  }
  if (target === 'string' && typeof value.value !== 'string') {
    throw new Error('String value expected');
  }
  if (target === 'boolean' && typeof value.value !== 'boolean') {
    throw new Error('Boolean value expected');
  }
  return { ...value } as Value;
}

function same(left: Value, right: Value): boolean {
  return left.type === right.type && left.value === right.value;
}

function matching(event: EngineEvent, rule: Rule): boolean {
  if (event.type === 'button') {
    return rule.eventSource.type === 'button' && rule.eventSource.id === event.sourceId;
  }
  return rule.eventSource.type === 'changed' && rule.eventSource.parameterId === event.sourceId;
}

function actionValue(action: Action, parameter: Parameter, evaluated: Value): Value {
  if (action.type === 'set') return normalize(evaluated, parameter.type);
  if (parameter.type !== 'integer' && parameter.type !== 'decimal') {
    throw new Error('Increment requires numeric parameter');
  }
  if (evaluated.type !== 'integer' && evaluated.type !== 'decimal') {
    throw new Error('Increment requires numeric expression');
  }
  const parameterType = parameter.type;
  const sum = Decimal.parse((parameter.value as { type: 'integer' | 'decimal'; value: string }).value)
    .add(Decimal.parse(evaluated.value));
  return normalize({ type: parameterType, value: sum.toString() }, parameterType);
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('maxActionsPerSlice must be a positive safe integer');
  }
  return value;
}

/**
 * Pure, atomic execution of a root event. The working copy stays private until
 * completion. Long chains yield a resumable handle rather than hitting a total
 * step limit or exposing partial state.
 */
export function execute(
  state: ProjectState,
  root: EngineEvent,
  options: { maxActionsPerSlice?: number } = {},
): ExecutionResult | SuspendedExecution {
  const parameters = new Map<string, Parameter>();
  for (const source of state.parameters) {
    if (parameters.has(source.id)) throw new Error(`Duplicate parameter ID: ${source.id}`);
    parameters.set(source.id, {
      ...source,
      initialValue: normalize(source.initialValue, source.type),
      value: normalize(source.value, source.type),
    });
  }

  const rules = state.rules
    .filter((rule) => rule.enabled)
    .map((rule, originalIndex) => ({ rule: copyRule(rule), originalIndex }))
    .sort((left, right) => left.rule.order - right.rule.order || left.originalIndex - right.originalIndex)
    .map(({ rule }) => rule);
  if (rules.some((rule) => !Number.isFinite(rule.order))) {
    throw new Error('Rule order must be a finite number');
  }

  const rootEvent: EngineEvent = {
    ...root,
    occurredAt: root.occurredAt ?? new Date().toISOString(),
    oldValue: root.oldValue ? { ...root.oldValue } as Value : undefined,
    newValue: root.newValue ? { ...root.newValue } as Value : undefined,
  };
  const queue: EngineEvent[] = [rootEvent];
  const processedEvents: EngineEvent[] = [];
  const changes: Change[] = [];
  let eventIndex = 0;
  let ruleIndex = 0;
  let actionIndex = 0;
  let selectedRule = false;
  let cancelled = false;

  const session: SuspendedExecution = {
    status: 'suspended',
    continue: (maxActions = options.maxActionsPerSlice ?? DEFAULT_ACTIONS_PER_SLICE) => run(maxActions),
    cancel: () => {
      cancelled = true;
      parameters.clear();
      queue.length = 0;
      processedEvents.length = 0;
      changes.length = 0;
    },
  };

  function run(maxActions: number): ExecutionResult | SuspendedExecution {
    if (cancelled) throw new Error('Execution was cancelled');
    const actionBudget = requirePositiveInteger(maxActions);
    let actionsRun = 0;

    while (eventIndex < queue.length) {
      const event = queue[eventIndex];
      const rule = rules[ruleIndex];
      if (!rule) {
        processedEvents.push(event);
        eventIndex++;
        ruleIndex = 0;
        actionIndex = 0;
        selectedRule = false;
        continue;
      }

      if (!matching(event, rule)) {
        ruleIndex++;
        actionIndex = 0;
        selectedRule = false;
        continue;
      }

      if (!selectedRule) {
        try {
          if (rule.condition) {
            const condition = evaluate(rule.condition, parameters, event);
            if (condition.type !== 'boolean') throw new Error('Rule condition must be boolean');
            if (!condition.value) {
              ruleIndex++;
              actionIndex = 0;
              continue;
            }
          }
          selectedRule = true;
        } catch (error) {
          throw new EngineExecutionError(
            `Rule ${rule.name} (${rule.id}): ${error instanceof Error ? error.message : String(error)}`,
            { ruleId: rule.id, ruleName: rule.name },
            { cause: error },
          );
        }
      }

      if (actionIndex >= rule.actions.length) {
        ruleIndex++;
        actionIndex = 0;
        selectedRule = false;
        continue;
      }
      if (actionsRun >= actionBudget) return session;

      const currentActionIndex = actionIndex;
      const action = rule.actions[currentActionIndex];
      try {
        const parameter = parameters.get(action.parameterId);
        if (!parameter) throw new Error(`Unknown parameter ${action.parameterId}`);
        if (parameter.type !== parameter.value.type) {
          throw new Error(`Parameter ${parameter.id} has an invalid current value`);
        }
        const evaluated = evaluate(action.expression, parameters, event);
        const nextValue = actionValue(action, parameter, evaluated);
        if (!same(parameter.value, nextValue)) {
          const occurredAt = new Date().toISOString();
          const previousValue = parameter.value;
          parameters.set(parameter.id, { ...parameter, value: nextValue });
          changes.push({
            parameterId: parameter.id,
            oldValue: previousValue,
            newValue: nextValue,
            ruleId: rule.id,
            occurredAt,
          });
          queue.push({
            type: 'changed',
            sourceId: parameter.id,
            occurredAt,
            oldValue: previousValue,
            newValue: nextValue,
          });
        }
        actionIndex++;
        actionsRun++;
      } catch (error) {
        throw new EngineExecutionError(
          `Rule ${rule.name} (${rule.id}), action ${currentActionIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
          {
            ruleId: rule.id,
            ruleName: rule.name,
            actionIndex: currentActionIndex,
            parameterId: action.parameterId,
          },
          { cause: error },
        );
      }
    }

    return {
      status: 'completed',
      state: {
        parameters: state.parameters.map((parameter) => parameters.get(parameter.id)!),
        rules: state.rules,
      },
      changes: [...changes],
      events: [...processedEvents],
      eventsProcessed: processedEvents.length,
    };
  }

  return run(options.maxActionsPerSlice ?? DEFAULT_ACTIONS_PER_SLICE);
}
