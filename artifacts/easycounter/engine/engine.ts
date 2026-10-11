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
  if (action.type === 'message' || action.type === 'input' || action.type === 'timerControl') return { ...action };
  if (action.type === 'listRemove') return { ...action, index: copyExpression(action.index) };
  if (action.type === 'listReplace') {
    return { ...action, index: copyExpression(action.index), expression: copyExpression(action.expression) };
  }
  return { ...action, expression: copyExpression(action.expression) };
}

function matching(event: EngineEvent, rule: Rule): boolean {
  if (event.skipped) return false;
  if (event.type === 'button') return rule.eventSource.type === 'button' && rule.eventSource.id === event.sourceId;
  if (event.type === 'timerFinished') return rule.eventSource.type === 'timerFinished' && rule.eventSource.parameterId === event.sourceId;
  if (event.type === 'scheduleTick') return rule.id === event.sourceId && (rule.eventSource.type === 'periodic' || rule.eventSource.type === 'calendar');
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
    scheduleCursors: { ...(baseState.runtime.scheduleCursors ?? {}) },
  };
  const parameters = new Map(config.parameters.map((parameter) => [parameter.id, parameter] as const));
  const localValues = new Map<string, Value>();
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
  const messages: string[] = [];
  let eventIndex = 0;
  let ruleIndex = 0;
  let actionIndex = 0;
  let selectedRule = false;
  let rootApplied = false;
  let cancelled = false;
  let pendingInput: { parameterId?: string; variableName?: string; variableType?: import('./types').ScalarType; prompt: string; ruleId: string; ruleName: string } | undefined;

  function evaluationValues(): Map<string, Value> {
    const values = currentValues(runtime);
    for (const [name, value] of localValues) values.set(name, copyValue(value));
    return values;
  }

  const session: SuspendedExecution = {
    status: 'suspended',
    get reason() { return pendingInput ? 'input' : 'yield'; },
    get inputRequest() {
      if (!pendingInput) return undefined;
      if (pendingInput.variableName) return { variableName: pendingInput.variableName, parameterType: pendingInput.variableType!, prompt: pendingInput.prompt };
      const parameter = parameters.get(pendingInput.parameterId!)!;
      return { parameterId: parameter.id, parameterName: parameter.name, parameterType: parameter.type, prompt: pendingInput.prompt };
    },
    continue: (maxActions = options.maxActionsPerSlice ?? DEFAULT_ACTIONS_PER_SLICE) => {
      if (pendingInput) throw new Error('Execution is waiting for input. Call submitInput or cancel.');
      return run(maxActions);
    },
    submitInput: (value, maxActions = options.maxActionsPerSlice ?? DEFAULT_ACTIONS_PER_SLICE) => {
      if (cancelled) throw new Error('Execution was cancelled');
      if (!pendingInput) throw new Error('Execution is not waiting for input.');
      const request = pendingInput;
      if (request.variableName) {
        try {
          localValues.set(`__local_${request.variableName}`, canonicalizeValue(value, request.variableType));
          actionIndex++;
          pendingInput = undefined;
          return run(maxActions);
        } catch (error) {
          throw new EngineExecutionError(`Ввод для временной переменной «${request.variableName}»: ${error instanceof Error ? error.message : String(error)}`, { ruleId: request.ruleId, ruleName: request.ruleName }, { cause: error });
        }
      }
      const parameter = parameters.get(request.parameterId!);
      if (cancelled) throw new Error('Execution was cancelled');
      if (!parameter) throw new Error('Input parameter no longer exists.');
      try {
        const canonical = canonicalizeValue(value, parameter.type, parameter.listItemType);
        const inputRule = rules.find((rule) => rule.id === request.ruleId);
        const inputAction = inputRule?.actions[actionIndex];
        if (!inputAction || inputAction.type !== 'input') throw new Error('Pending input action is missing.');
        const oldValue = copyValue(runtime.values[parameter.id]);
        const valueChanged = !sameValue(oldValue, canonical);
        const at = new Date().toISOString();
        runtime.values[parameter.id] = canonical;
        if (valueChanged) {
          changes.push({ parameterId: parameter.id, oldValue, newValue: canonical, ruleId: request.ruleId, occurredAt: at });
          queue.push({ type: 'changed', sourceId: parameter.id, occurredAt: at, oldValue, newValue: canonical });
          emitComputedChanges(request.ruleId, at);
        }
        queue.push({ type: 'assigned', sourceId: parameter.id, occurredAt: at, oldValue, newValue: canonical });
        actionIndex++;
        pendingInput = undefined;
        return run(maxActions);
      } catch (error) {
        if (error instanceof EngineExecutionError) throw error;
        throw new EngineExecutionError(`Ввод для параметра «${parameter.name}»: ${error instanceof Error ? error.message : String(error)}`, { ruleId: request.ruleId, ruleName: request.ruleName, parameterId: parameter.id }, { cause: error });
      }
    },
    cancel: () => {
      cancelled = true;
      runtime.values = {};
      runtime.ruleTruth = {};
      localValues.clear();
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

  function applyRootAssignment(): void {
    if (rootEvent.type !== 'assigned') return;
    const parameter = parameters.get(rootEvent.sourceId);
    if (!parameter) throw new Error(`Unknown parameter ${rootEvent.sourceId}`);
    if (parameter.kind === 'computed') throw new Error(`Computed parameter ${parameter.id} is read-only`);
    if (!rootEvent.newValue) throw new Error('An assigned root event requires a value');
    const next = canonicalizeValue(rootEvent.newValue, parameter.type, parameter.listItemType);
    rootEvent.oldValue = copyValue(runtime.values[parameter.id]);
    rootEvent.newValue = copyValue(next);
    applyChange(parameter, next, null, rootEvent.occurredAt!);
  }

  function applyRootTimerFinished(): void {
    if (rootEvent.type !== 'timerFinished') return;
    const parameter = parameters.get(rootEvent.sourceId);
    const current = parameter ? runtime.values[parameter.id] : undefined;
    if (!parameter || parameter.kind !== 'stored' || parameter.type !== 'timer' || current?.type !== 'timer') throw new Error('Timer completion requires a stored timer parameter');
    if (current.value.status !== 'running' || current.value.direction !== 'down' || current.value.startedAt === undefined || current.value.completionNotified) throw new Error('Timer is no longer waiting to finish');
    const finishAt = current.value.startedAt + Number(BigInt(current.value.elapsedMilliseconds));
    const remaining = BigInt(current.value.elapsedMilliseconds) - BigInt(Math.max(0, Date.now() - current.value.startedAt));
    if (remaining > 0n) throw new Error('Timer has not reached zero');
    const occurredAt = new Date(finishAt).toISOString();
    rootEvent.occurredAt = occurredAt;
    rootEvent.oldValue = copyValue(current);
    const completed: Value = { type: 'timer', value: current.value.allowNegative
      ? { ...current.value, elapsedMilliseconds: '0', startedAt: finishAt, completionNotified: true }
      : { elapsedMilliseconds: '0', initialMilliseconds: current.value.initialMilliseconds, direction: current.value.direction, status: 'stopped', allowNegative: false, completionNotified: true } };
    rootEvent.newValue = copyValue(completed);
    applyChange(parameter, completed, null, occurredAt);
  }

  function applyRootScheduleTick(): void {
    if (rootEvent.type !== 'scheduleTick') return;
    const rule = config.rules.find((item) => item.id === rootEvent.sourceId);
    if (!rule || (rule.eventSource.type !== 'periodic' && rule.eventSource.type !== 'calendar')) throw new Error('Scheduled event requires a periodic or calendar rule');
    const occurredAt = Date.parse(rootEvent.occurredAt!);
    if (!Number.isFinite(occurredAt)) throw new Error('Scheduled event has an invalid occurrence time');
    const previous = Date.parse(runtime.scheduleCursors?.[rule.id] ?? '');
    if (Number.isFinite(previous) && occurredAt <= previous) throw new Error('Scheduled event was already processed');
    runtime.scheduleCursors ??= {};
    runtime.scheduleCursors[rule.id] = new Date(occurredAt).toISOString();
  }

  function evaluateCondition(rule: Rule, event: EngineEvent): boolean {
    if (!rule.condition) return true;
    const result = evaluate(rule.condition, evaluationValues(), event);
    if (result.type !== 'boolean') throw new Error('Rule condition must be boolean');
    return result.value;
  }

  function runAction(rule: Rule, action: Action, event: EngineEvent): void {
    if (action.type === 'message') { messages.push(action.text); return; }
    if (action.type === 'input') {
      pendingInput = action.variableName
        ? { variableName: action.variableName, variableType: action.variableType, prompt: action.prompt, ruleId: rule.id, ruleName: rule.name }
        : { parameterId: action.parameterId!, prompt: action.prompt, ruleId: rule.id, ruleName: rule.name };
      return;
    }
    const parameter = parameters.get(action.parameterId);
    if (!parameter) throw new Error(`Unknown parameter ${action.parameterId}`);
    if (parameter.kind === 'computed') throw new Error(`Computed parameter ${parameter.id} is read-only`);
    const before = runtime.values[parameter.id];
    if (!before) throw new Error(`Parameter ${parameter.id} has no runtime value`);
    if (action.type === 'timerControl') {
      if (parameter.type !== 'timer' || before.type !== 'timer') throw new Error('Timer commands require a timer parameter');
      if (action.command === 'start' && before.value.status === 'running') return;
      if (action.command === 'pause' && before.value.status !== 'running') return;
      const now = Date.now();
      let timer = before.value;
      const alreadyBelowZero = timer.allowNegative && BigInt(timer.elapsedMilliseconds) < 0n;
      if ((action.command === 'reset' || (action.command === 'start' && timer.status === 'stopped' && !alreadyBelowZero)) && parameter.timerDurationParameterId) {
        const sourceValue = runtime.values[parameter.timerDurationParameterId];
        if (!sourceValue || (sourceValue.type !== 'integer' && sourceValue.type !== 'decimal' && sourceValue.type !== 'time')) throw new Error('Timer duration source must contain seconds or a time value');
        let milliseconds: string;
        if (sourceValue.type === 'time') {
          const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(sourceValue.value);
          if (!match) throw new Error('Timer duration time must use HH:mm or HH:mm:ss.SSS');
          const hours = Number(match[1]); const minutes = Number(match[2]); const seconds = Number(match[3] ?? '0');
          if (hours > 23 || minutes > 59 || seconds > 59) throw new Error('Timer duration time is outside the valid range');
          milliseconds = String(hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + Number((match[4] ?? '').padEnd(3, '0')));
        } else {
          const duration = Decimal.parse(sourceValue.value).mul(Decimal.parse('1000'));
          if (duration.scale !== 0 || duration.coefficient < 0n) throw new Error('Timer duration must be a non-negative number of seconds with millisecond precision');
          milliseconds = duration.toString();
        }
        timer = { ...timer, elapsedMilliseconds: milliseconds, initialMilliseconds: milliseconds };
      }
      let elapsed = BigInt(timer.elapsedMilliseconds);
      if (timer.status === 'running' && timer.startedAt !== undefined) {
        const passed = BigInt(Math.max(0, now - timer.startedAt));
        elapsed = timer.direction === 'down' ? elapsed - passed : elapsed + passed;
        if (!timer.allowNegative && elapsed < 0n) elapsed = 0n;
      }
      let nextTimer = { ...timer, elapsedMilliseconds: elapsed.toString() };
      switch (action.command) {
        case 'start':
          if (timer.status !== 'running') {
            nextTimer = { ...nextTimer, status: 'running', startedAt: now, completionNotified: timer.status === 'stopped' && !alreadyBelowZero ? false : timer.completionNotified };
          }
          break;
        case 'pause':
          nextTimer = { ...nextTimer, status: 'paused', startedAt: undefined };
          break;
        case 'stop':
          nextTimer = { ...nextTimer, status: 'stopped', startedAt: undefined };
          break;
        case 'reset':
          nextTimer = { ...nextTimer, elapsedMilliseconds: timer.initialMilliseconds, status: 'stopped', startedAt: undefined, completionNotified: false };
          break;
      }
      applyChange(parameter, { type: 'timer', value: nextTimer }, rule.id, new Date(now).toISOString());
      return;
    }
    const values = evaluationValues();
    const evaluated = action.type === 'listRemove' ? undefined : evaluate(action.expression, currentValues(runtime), event, localValues);
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
        const indexValue = evaluate(action.index, currentValues(runtime), event, localValues);
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
      if (!rootApplied) {
        if (rootEvent.type === 'reset') applyReset();
        if (rootEvent.type === 'assigned') applyRootAssignment();
        if (rootEvent.type === 'timerFinished') applyRootTimerFinished();
        if (rootEvent.type === 'scheduleTick') applyRootScheduleTick();
        rootApplied = true;
      }
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
            if (rule.triggerMode === 'risingEdge' && isMatch) {
              const previous = runtime.ruleTruth[rule.id] ?? false;
              const current = evaluateCondition(rule, event);
              runtime.ruleTruth[rule.id] = current;
              conditionMet = !previous && current;
            } else if (rule.triggerMode === 'each' && isMatch) {
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
          actionsRun++;
          if (pendingInput) { actionIndex = currentIndex; return session; }
          actionIndex++;
        } catch (error) {
          throw new EngineExecutionError(
            `Rule ${rule.name} (${rule.id}), action ${currentIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
            {
              ruleId: rule.id,
              ruleName: rule.name,
              actionIndex: currentIndex,
              parameterId: 'parameterId' in rule.actions[currentIndex] ? rule.actions[currentIndex].parameterId : undefined,
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
      messages: [...messages],
    };
  }

  try {
    return run(options.maxActionsPerSlice ?? DEFAULT_ACTIONS_PER_SLICE);
  } catch (error) {
    if (error instanceof EngineExecutionError) throw error;
    throw new EngineExecutionError(error instanceof Error ? error.message : String(error), {}, { cause: error });
  }
}

export function resetParameters(
  state: ProjectState,
  parameterIds?: string[],
): ExecutionResult | SuspendedExecution {
  return execute(state, { type: 'reset', sourceId: 'project', parameterIds });
}

export { createInitialProjectState };
