import { Decimal } from './decimal';
import { evaluate, canonicalizeValue, valueEquals } from './evaluator';
import {
  createInitialProjectState,
  rehydrateProjectState,
  validateProjectConfiguration,
} from './configuration';
import type {
  Action,
  Change,
  ComputedParameter,
  EngineEvent,
  ExecutionResult,
  Expr,
  Parameter,
  ProjectConfiguration,
  ProjectState,
  Rule,
  RuntimeState,
  ScalarValue,
  SuspendedExecution,
  Value,
} from './types';
import { EngineExecutionError } from './types';

const DEFAULT_ACTIONS_PER_SLICE = 1000;

function copyValue(value: Value): Value {
  if (value.type === 'list') return { ...value, value: value.value.map((item) => copyValue(item) as ScalarValue) };
  if (value.type === 'timer') return { ...value, value: { ...value.value } };
  return { ...value } as Value;
}

function copyExpression(expression: Expr): Expr {
  switch (expression.kind) {
    case 'literal': return { kind: 'literal', value: copyValue(expression.value) };
    case 'parameter': return { ...expression };
    case 'event': return { ...expression };
    case 'unary': return { ...expression, operand: copyExpression(expression.operand) };
    case 'binary': return { ...expression, left: copyExpression(expression.left), right: copyExpression(expression.right) };
    case 'call': return { ...expression, args: expression.args.map(copyExpression) };
  }
}

function copyConfig(config: ProjectConfiguration): ProjectConfiguration {
  return {
    parameters: config.parameters.map((parameter) => parameter.kind === 'computed'
      ? { ...parameter, initialValue: copyValue(parameter.initialValue), formula: copyExpression(parameter.formula) }
      : { ...parameter, initialValue: copyValue(parameter.initialValue) }),
    rules: config.rules.map((rule) => ({
      ...rule,
      eventSource: { ...rule.eventSource },
      condition: rule.condition ? copyExpression(rule.condition) : undefined,
      actions: rule.actions.map((action) => copyAction(action)),
    })),
  };
}

function copyAction(action: Action): Action {
  if (action.type === 'listRemove') return { ...action, index: copyExpression(action.index) };
  if (action.type === 'listReplace') {
    return { ...action, index: copyExpression(action.index), expression: copyExpression(action.expression) };
  }
  return { ...action, expression: copyExpression(action.expression) };
}

function matching(event: EngineEvent, rule: Rule): boolean {
  if (event.type === 'button') return rule.eventSource.type === 'button' && rule.eventSource.id === event.sourceId;
  return (event.type === 'changed' || event.type === 'assigned')
    && rule.eventSource.type === event.type
    && rule.eventSource.parameterId === event.sourceId;
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('maxActionsPerSlice must be a positive safe integer');
  }
  return value;
}

function currentValues(runtime: RuntimeState): Map<string, Value> {
  return new Map(Object.entries(runtime.values));
}

function sameValue(left: Value, right: Value): boolean {
  return valueEquals(left, right);
}

function parseIndex(value: Value): number {
  if (value.type !== 'integer') throw new Error('List index must be an integer');
  const index = Number(value.value);
  if (!Number.isSafeInteger(index)) throw new Error('List index is out of range');
  return index;
}

function computeParameter(
  parameter: ComputedParameter,
  values: Map<string, Value>,
): Value {
  return canonicalizeValue(evaluate(parameter.formula, values), parameter.type, parameter.listItemType);
}

/**
 * Execute one root event against a private configuration and runtime snapshot.
 * Only a completed result is eligible for persistent commit.
 */
export function execute(
  sourceState: ProjectState,
  root: EngineEvent,
  options: { maxActionsPerSlice?: number } = {},
): ExecutionResult | SuspendedExecution {
  const config = copyConfig(sourceState.config);
  const computedOrder = validateProjectConfiguration(config);
  const baseState = rehydrateProjectState(config, sourceState.runtime, sourceState.revision);
  const runtime: RuntimeState = {
    values: Object.fromEntries(Object.entries(baseState.runtime.values).map(([id, value]) => [id, copyValue(value)])),
    ruleTruth: { ...baseState.runtime.ruleTruth },
  };
  const parameters = new Map(config.parameters.map((parameter) => [parameter.id, parameter] as const));
  const rules = config.rules
    .filter((rule) => rule.enabled)
    .map((rule, originalIndex) => ({ rule, originalIndex }))
    .sort((left, right) => left.rule.order - right.rule.order || left.originalIndex - right.originalIndex)
    .map(({ rule }) => rule);

  const rootEvent: EngineEvent = {
    ...root,
    occurredAt: root.occurredAt ?? new Date().toISOString(),
    oldValue: root.oldValue ? copyValue(root.oldValue) : undefined,
    newValue: root.newValue ? copyValue(root.newValue) : undefined,
    parameterIds: root.parameterIds ? [...root.parameterIds] : undefined,
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
      runtime.values = {};
      runtime.ruleTruth = {};
      queue.length = 0;
      processedEvents.length = 0;
      changes.length = 0;
    },
  };

  function emitComputedChanges(ruleId: string | null, at: string): void {
    const values = currentValues(runtime);
    for (const parameter of computedOrder) {
      let next: Value;
      try {
        next = computeParameter(parameter, values);
      } catch (error) {
        throw new EngineExecutionError(
          `Computed parameter ${parameter.name} (${parameter.id}): ${error instanceof Error ? error.message : String(error)}`,
          { parameterId: parameter.id, ruleId: ruleId ?? undefined },
          { cause: error },
        );
      }
      const previous = runtime.values[parameter.id];
      if (previous && sameValue(previous, next)) continue;
      runtime.values[parameter.id] = next;
      values.set(parameter.id, next);
      const oldValue = previous ?? copyValue(parameter.initialValue);
      changes.push({ parameterId: parameter.id, oldValue, newValue: next, ruleId, occurredAt: at });
      queue.push({ type: 'changed', sourceId: parameter.id, occurredAt: at, oldValue, newValue: next });
    }
  }

  function applyChange(
    parameter: Parameter,
    nextValue: Value,
    ruleId: string | null,
    at: string,
  ): { changed: boolean; previous: Value } {
    const previous = runtime.values[parameter.id];
    if (!previous) throw new Error(`Parameter ${parameter.id} has no runtime value`);
    if (sameValue(previous, nextValue)) return { changed: false, previous };
    runtime.values[parameter.id] = nextValue;
    changes.push({ parameterId: parameter.id, oldValue: previous, newValue: nextValue, ruleId, occurredAt: at });
    queue.push({ type: 'changed', sourceId: parameter.id, occurredAt: at, oldValue: previous, newValue: nextValue });
    emitComputedChanges(ruleId, at);
    return { changed: true, previous };
  }

  function applyReset(): void {
    if (rootEvent.type !== 'reset') return;
    const requestedIds = rootEvent.parameterIds ?? config.parameters
      .filter((parameter) => parameter.kind === 'stored')
      .map((parameter) => parameter.id);
    const uniqueIds = new Set(requestedIds);
    for (const parameterId of uniqueIds) {
      const parameter = parameters.get(parameterId);
      if (!parameter) throw new Error(`Unknown parameter ${parameterId}`);
      if (parameter.kind === 'computed') throw new Error(`Computed parameter ${parameterId} is read-only`);
      try {
        applyChange(parameter, canonicalizeValue(parameter.initialValue, parameter.type, parameter.listItemType), null, rootEvent.occurredAt!);
      } catch (error) {
        throw new EngineExecutionError(
          `Reset parameter ${parameter.name} (${parameter.id}): ${error instanceof Error ? error.message : String(error)}`,
          { parameterId: parameter.id },
          { cause: error },
        );
      }
    }
  }

  function evaluateCondition(rule: Rule, event: EngineEvent): boolean {
    if (!rule.condition) return true;
    const result = evaluate(rule.condition, currentValues(runtime), event);
    if (result.type !== 'boolean') throw new Error('Rule condition must be boolean');
    return result.value;
  }

  function runAction(rule: Rule, action: Action, event: EngineEvent): void {
    const parameter = parameters.get(action.parameterId);
    if (!parameter) throw new Error(`Unknown parameter ${action.parameterId}`);
    if (parameter.kind === 'computed') throw new Error(`Computed parameter ${parameter.id} is read-only`);
    const before = runtime.values[parameter.id];
    if (!before) throw new Error(`Parameter ${parameter.id} has no runtime value`);
    const values = currentValues(runtime);
    const evaluated = action.type === 'listRemove' ? undefined : evaluate(action.expression, values, event);
    const at = new Date().toISOString();
    let next: Value;

    if (action.type === 'set') {
      next = canonicalizeValue(evaluated!, parameter.type, parameter.listItemType);
      queue.push({ type: 'assigned', sourceId: parameter.id, occurredAt: at, oldValue: before, newValue: next });
    } else if (action.type === 'add') {
      if ((parameter.type !== 'integer' && parameter.type !== 'decimal')
        || (evaluated!.type !== 'integer' && evaluated!.type !== 'decimal')) {
        throw new Error('add requires numeric parameter and expression');
      }
      next = canonicalizeValue({
        type: parameter.type,
        value: Decimal.parse(before.value as string).add(Decimal.parse(evaluated!.value as string)).toString(),
      }, parameter.type);
    } else {
      if (parameter.type !== 'list') throw new Error('List operation requires a list parameter');
      if (before.type !== 'list') throw new Error('Parameter has an invalid list value');
      if (action.type === 'listAdd') {
        const item = canonicalizeValue(evaluated!, parameter.listItemType);
        next = { type: 'list', itemType: parameter.listItemType!, value: [...before.value.map(copyValue) as never[], item as never] };
      } else {
        const indexValue = evaluate(action.index, values, event);
        const index = parseIndex(indexValue);
        if (index < 0 || index >= before.value.length) throw new Error(`List index ${index} is out of range`);
        const items = before.value.map(copyValue) as never[];
        if (action.type === 'listRemove') items.splice(index, 1);
        else items[index] = canonicalizeValue(evaluated!, parameter.listItemType) as never;
        next = { type: 'list', itemType: parameter.listItemType!, value: items as never };
      }
    }
    applyChange(parameter, next, rule.id, at);
  }

  function run(maxActions: number): ExecutionResult | SuspendedExecution {
    if (cancelled) throw new Error('Execution was cancelled');
    const actionBudget = requirePositiveInteger(maxActions);
    let actionsRun = 0;

    try {
      if (eventIndex === 0 && processedEvents.length === 0 && rootEvent.type === 'reset') applyReset();
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

        const isMatch = matching(event, rule);
        let conditionMet = false;
        if (!selectedRule) {
          try {
            if (rule.triggerMode === 'risingEdge') {
              const previous = runtime.ruleTruth[rule.id] ?? false;
              const current = evaluateCondition(rule, event);
              runtime.ruleTruth[rule.id] = current;
              conditionMet = !previous && current;
            } else if (isMatch) {
              conditionMet = evaluateCondition(rule, event);
            }
          } catch (error) {
            throw new EngineExecutionError(
              `Rule ${rule.name} (${rule.id}): ${error instanceof Error ? error.message : String(error)}`,
              { ruleId: rule.id, ruleName: rule.name },
              { cause: error },
            );
          }
        }

        if (!isMatch || (!selectedRule && !conditionMet)) {
          ruleIndex++;
          actionIndex = 0;
          selectedRule = false;
          continue;
        }
        if (!selectedRule) selectedRule = true;

        if (actionIndex >= rule.actions.length) {
          ruleIndex++;
          actionIndex = 0;
          selectedRule = false;
          continue;
        }
        if (actionsRun >= actionBudget) return session;

        const currentIndex = actionIndex;
        try {
          runAction(rule, rule.actions[currentIndex], event);
          actionIndex++;
          actionsRun++;
        } catch (error) {
          throw new EngineExecutionError(
            `Rule ${rule.name} (${rule.id}), action ${currentIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
            {
              ruleId: rule.id,
              ruleName: rule.name,
              actionIndex: currentIndex,
              parameterId: rule.actions[currentIndex].parameterId,
            },
            { cause: error },
          );
        }
      }
    } catch (error) {
      if (error instanceof EngineExecutionError) throw error;
      throw new EngineExecutionError(error instanceof Error ? error.message : String(error));
    }

    return {
      status: 'completed',
      state: {
        config,
        runtime,
        revision: sourceState.revision,
      },
      baseRevision: sourceState.revision,
      rootEvent,
      changes: [...changes],
      events: [...processedEvents],
      eventsProcessed: processedEvents.length,
    };
  }

  return run(options.maxActionsPerSlice ?? DEFAULT_ACTIONS_PER_SLICE);
}

export function resetParameters(
  state: ProjectState,
  parameterIds?: string[],
): ExecutionResult | SuspendedExecution {
  return execute(state, { type: 'reset', sourceId: 'project', parameterIds });
}

export { createInitialProjectState };
