import { canonicalizeValue, inferExpressionType, type ExpressionType } from './evaluator';
import { EngineExecutionError, ConfigurationValidationError } from './types';
import { evaluate } from './evaluator';
import type {
  Action,
  ComputedParameter,
  Expr,
  Parameter,
  PrimitiveType,
  ProjectConfiguration,
  ProjectState,
  RuntimeState,
  ScalarType,
  Value,
} from './types';

const MAX_AST_DEPTH = 128;
const MAX_AST_NODES = 10_000;

function typeOf(parameter: Parameter): ExpressionType {
  return {
    type: parameter.type,
    ...(parameter.type === 'list' ? { listItemType: parameter.listItemType } : {}),
  };
}

function sameExpressionType(left: ExpressionType, right: ExpressionType): boolean {
  return left.type === right.type
    && (left.type !== 'list' || left.listItemType === right.listItemType);
}

function assignable(source: ExpressionType, target: Parameter): boolean {
  if (source.type === 'integer' && target.type === 'decimal') return true;
  return sameExpressionType(source, typeOf(target));
}

function eventParameterFor(config: ProjectConfiguration, source: Action | ProjectConfiguration['rules'][number]['eventSource']): Parameter | undefined {
  if (!('parameterId' in source)) return undefined;
  return config.parameters.find((parameter) => parameter.id === source.parameterId);
}

function expressionChildren(expression: Expr): Expr[] {
  switch (expression.kind) {
    case 'literal':
    case 'parameter':
    case 'event':
      return [];
    case 'unary':
      return [expression.operand];
    case 'binary':
      return [expression.left, expression.right];
    case 'call':
      return expression.args;
  }
}

function validateAstBounds(expression: Expr, rootName: string): void {
  const stack: Array<{ expression: Expr; depth: number }> = [{ expression, depth: 1 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++visited > MAX_AST_NODES) throw new Error(`${rootName} exceeds ${MAX_AST_NODES} expression nodes`);
    if (current.depth > MAX_AST_DEPTH) throw new Error(`${rootName} exceeds expression depth ${MAX_AST_DEPTH}`);
    for (const child of expressionChildren(current.expression)) {
      stack.push({ expression: child, depth: current.depth + 1 });
    }
  }
}

export function collectParameterReferences(expression: Expr): Set<string> {
  const references = new Set<string>();
  const stack = [expression];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.kind === 'parameter') references.add(item.id);
    else stack.push(...expressionChildren(item));
  }
  return references;
}

function checkExpression(
  expression: Expr,
  parameterMap: ReadonlyMap<string, Parameter>,
  eventParameter: Parameter | undefined,
  label: string,
  variables: ReadonlyMap<string, ExpressionType> = new Map(),
): ExpressionType {
  validateAstBounds(expression, label);
  try {
    return inferExpressionType(expression, parameterMap, eventParameter, variables);
  } catch (error) {
    throw new ConfigurationValidationError(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
      { expressionPath: label },
    );
  }
}

function validateAction(
  action: Action,
  ruleId: string,
  index: number,
  parameterMap: ReadonlyMap<string, Parameter>,
  eventParameter?: Parameter,
  variables: ReadonlyMap<string, ExpressionType> = new Map(),
): void {
  const label = `Rule ${ruleId}, action ${index + 1}`;
  if (action.type === 'message') {
    if (typeof action.text !== 'string' || action.text.length > 2000) throw new ConfigurationValidationError(`${label}: message text must be at most 2000 characters`, { ruleId });
    return;
  }
  if (action.type === 'input') {
    if (action.variableName !== undefined) {
      if (action.parameterId !== undefined) throw new ConfigurationValidationError(`${label}: input cannot target both a parameter and a temporary variable`, { ruleId });
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(action.variableName) || !action.variableType || action.variableType === 'timer') throw new ConfigurationValidationError(`${label}: invalid temporary variable name or type`, { ruleId });
      if (variables.has(`__local_${action.variableName}`) || parameterMap.has(`__local_${action.variableName}`)) throw new ConfigurationValidationError(`${label}: temporary variable ${action.variableName} is already defined`, { ruleId });
      if (typeof action.prompt !== 'string' || action.prompt.length > 500) throw new ConfigurationValidationError(`${label}: input prompt must be at most 500 characters`, { ruleId });
      return;
    }
    const parameter = action.parameterId ? parameterMap.get(action.parameterId) : undefined;
    if (!parameter) throw new ConfigurationValidationError(`${label}: unknown parameter ${action.parameterId}`, { ruleId, parameterId: action.parameterId });
    if (parameter.kind === 'computed') throw new ConfigurationValidationError(`${label}: computed parameters are read-only`, { ruleId, parameterId: parameter.id });
    if (parameter.type === 'list' || parameter.type === 'timer') throw new ConfigurationValidationError(`${label}: input is not supported for ${parameter.type}`, { ruleId, parameterId: parameter.id });
    if (typeof action.prompt !== 'string' || action.prompt.length > 500) throw new ConfigurationValidationError(`${label}: input prompt must be at most 500 characters`, { ruleId });
    return;
  }
  const parameter = parameterMap.get(action.parameterId);
  if (!parameter) {
    throw new ConfigurationValidationError(`${label}: unknown parameter ${action.parameterId}`, { ruleId, parameterId: action.parameterId });
  }
  if (parameter.kind === 'computed') {
    throw new ConfigurationValidationError(`${label}: computed parameters are read-only`, { ruleId, parameterId: parameter.id });
  }
  if (action.type === 'timerControl') {
    if (parameter.type !== 'timer') throw new ConfigurationValidationError(`${label}: timer commands require a timer parameter`, { ruleId, parameterId: parameter.id });
    if (!['start', 'pause', 'stop', 'reset'].includes(action.command)) throw new ConfigurationValidationError(`${label}: unsupported timer command`, { ruleId, parameterId: parameter.id });
    return;
  }
  if (action.type === 'set') {
    const valueType = checkExpression(action.expression, parameterMap, eventParameter, label, variables);
    if (!assignable(valueType, parameter)) {
      throw new ConfigurationValidationError(`${label}: cannot assign ${valueType.type} to ${parameter.type}`, { ruleId, parameterId: parameter.id });
    }
    return;
  }
  if (action.type === 'add') {
    if (parameter.type !== 'integer' && parameter.type !== 'decimal') {
      throw new ConfigurationValidationError(`${label}: add requires a numeric parameter`, { ruleId, parameterId: parameter.id });
    }
    const valueType = checkExpression(action.expression, parameterMap, eventParameter, label, variables);
    if (valueType.type !== 'integer' && valueType.type !== 'decimal') {
      throw new ConfigurationValidationError(`${label}: add requires a numeric expression`, { ruleId, parameterId: parameter.id });
    }
    return;
  }
  if (parameter.type !== 'list') {
    throw new ConfigurationValidationError(`${label}: list operation requires a list parameter`, { ruleId, parameterId: parameter.id });
  }
  if (action.type === 'listAdd' || action.type === 'listReplace') {
    const valueType = checkExpression(action.expression, parameterMap, eventParameter, label, variables);
    if (valueType.type !== parameter.listItemType) {
      throw new ConfigurationValidationError(`${label}: list item must have type ${parameter.listItemType}`, { ruleId, parameterId: parameter.id });
    }
  }
  if (action.type === 'listRemove' || action.type === 'listReplace') {
    const indexType = checkExpression(action.index, parameterMap, eventParameter, label, variables);
    if (indexType.type !== 'integer') {
      throw new ConfigurationValidationError(`${label}: list index must be an integer`, { ruleId, parameterId: parameter.id });
    }
  }
}

function computedOrder(config: ProjectConfiguration, parameterMap: ReadonlyMap<string, Parameter>): ComputedParameter[] {
  const ordered: ComputedParameter[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (parameter: ComputedParameter): void => {
    if (visited.has(parameter.id)) return;
    if (visiting.has(parameter.id)) {
      const cycleStart = path.indexOf(parameter.id);
      const cycle = [...path.slice(cycleStart), parameter.id].join(' → ');
      throw new ConfigurationValidationError(`Computed parameter cycle: ${cycle}`, { parameterId: parameter.id });
    }
    visiting.add(parameter.id);
    path.push(parameter.id);
    for (const dependencyId of collectParameterReferences(parameter.formula)) {
      const dependency = parameterMap.get(dependencyId);
      if (dependency?.kind === 'computed') visit(dependency);
    }
    path.pop();
    visiting.delete(parameter.id);
    visited.add(parameter.id);
    ordered.push(parameter);
  };

  for (const parameter of config.parameters) {
    if (parameter.kind === 'computed') visit(parameter);
  }
  return ordered;
}

/** Validate IDs, values, expression types, event contexts, and computed cycles. */
export function validateProjectConfiguration(config: ProjectConfiguration): ComputedParameter[] {
  const parameterMap = new Map<string, Parameter>();
  for (const parameter of config.parameters) {
    if (!parameter.id.trim() || !parameter.name.trim()) {
      throw new ConfigurationValidationError('Parameters must have a non-empty ID and name', { parameterId: parameter.id });
    }
    if (parameterMap.has(parameter.id)) {
      throw new ConfigurationValidationError(`Duplicate parameter ID ${parameter.id}`, { parameterId: parameter.id });
    }
    if (parameter.type === 'list') {
      if (!parameter.listItemType) {
        throw new ConfigurationValidationError('Lists require one scalar item type', { parameterId: parameter.id });
      }
    } else if (parameter.listItemType) {
      throw new ConfigurationValidationError('Only list parameters can have an item type', { parameterId: parameter.id });
    }
    try {
      canonicalizeValue(parameter.initialValue, parameter.type, parameter.listItemType);
    } catch (error) {
      throw new ConfigurationValidationError(
        `Parameter ${parameter.name}: ${error instanceof Error ? error.message : String(error)}`,
        { parameterId: parameter.id },
      );
    }
    if (parameter.kind === 'stored' && parameter.timerDurationParameterId) {
      const durationParameter = config.parameters.find((candidate) => candidate.id === parameter.timerDurationParameterId);
      if (parameter.type !== 'timer' || !durationParameter || durationParameter.id === parameter.id || !['integer', 'decimal', 'time'].includes(durationParameter.type)) {
        throw new ConfigurationValidationError('A timer duration source must be another integer, decimal, or time parameter', { parameterId: parameter.id });
      }
    }
    if (parameter.kind === 'computed' && !parameter.formula) {
      throw new ConfigurationValidationError('Computed parameters require a formula', { parameterId: parameter.id });
    }
    parameterMap.set(parameter.id, parameter);
  }

  for (const parameter of config.parameters) {
    if (parameter.kind !== 'computed') continue;
    const type = checkExpression(parameter.formula, parameterMap, undefined, `Formula for ${parameter.name}`);
    if (!assignable(type, parameter)) {
      throw new ConfigurationValidationError(`Formula for ${parameter.name} returns ${type.type}, expected ${parameter.type}`, { parameterId: parameter.id });
    }
  }

  const computed = computedOrder(config, parameterMap);
  const ruleIds = new Set<string>();
  for (const rule of config.rules) {
    if (!rule.id.trim() || !rule.name.trim()) throw new ConfigurationValidationError('Rules must have a non-empty ID and name', { ruleId: rule.id });
    if (ruleIds.has(rule.id)) throw new ConfigurationValidationError(`Duplicate rule ID ${rule.id}`, { ruleId: rule.id });
    ruleIds.add(rule.id);
    if (!Number.isFinite(rule.order)) throw new ConfigurationValidationError(`Rule ${rule.name} has an invalid order`, { ruleId: rule.id });
    if (rule.triggerMode !== 'each' && rule.triggerMode !== 'risingEdge') {
      throw new ConfigurationValidationError(`Rule ${rule.name} has an unsupported trigger mode`, { ruleId: rule.id });
    }
    if (rule.triggerMode === 'risingEdge' && !rule.condition) {
      throw new ConfigurationValidationError(`Rule ${rule.name}: risingEdge requires a condition`, { ruleId: rule.id });
    }
    const eventParameter = eventParameterFor(config, rule.eventSource);
    if (['changed', 'assigned', 'timerFinished'].includes(rule.eventSource.type) && !eventParameter) {
      throw new ConfigurationValidationError(`Rule ${rule.name} listens to an unknown parameter`, { ruleId: rule.id });
    }
    if (rule.eventSource.type === 'timerFinished' && eventParameter?.type !== 'timer') {
      throw new ConfigurationValidationError(`Rule ${rule.name} timer event requires a timer parameter`, { ruleId: rule.id, parameterId: eventParameter?.id });
    }
    if (rule.eventSource.type === 'periodic') {
      const interval = rule.eventSource.intervalMilliseconds;
      if (interval.length > 10 || !/^\d+$/.test(interval) || BigInt(interval) < 1n || BigInt(interval) > 2_147_483_647n) {
        throw new ConfigurationValidationError(`Rule ${rule.name} interval must be between 1 and 2147483647 milliseconds`, { ruleId: rule.id });
      }
      if (!Number.isFinite(Date.parse(rule.eventSource.anchorAt))) throw new ConfigurationValidationError(`Rule ${rule.name} has an invalid interval start`, { ruleId: rule.id });
      if (!['all', 'once', 'skip'].includes(rule.eventSource.missedPolicy)) throw new ConfigurationValidationError(`Rule ${rule.name} has an invalid missed-event policy`, { ruleId: rule.id });
    }
    if (rule.eventSource.type === 'calendar') {
      const source = rule.eventSource;
      if (!['daily', 'weekly', 'once'].includes(source.recurrence)) throw new ConfigurationValidationError(`Rule ${rule.name} has an unsupported calendar recurrence`, { ruleId: rule.id });
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(source.localTime)) throw new ConfigurationValidationError(`Rule ${rule.name} calendar time must use HH:mm`, { ruleId: rule.id });
      try { new Intl.DateTimeFormat('en-US', { timeZone: source.timeZone }).format(0); } catch { throw new ConfigurationValidationError(`Rule ${rule.name} has an invalid time zone`, { ruleId: rule.id }); }
      if (!Number.isFinite(Date.parse(source.anchorAt))) throw new ConfigurationValidationError(`Rule ${rule.name} has an invalid calendar start`, { ruleId: rule.id });
      if (source.recurrence === 'weekly' && (!Number.isInteger(source.dayOfWeek) || source.dayOfWeek! < 0 || source.dayOfWeek! > 6)) throw new ConfigurationValidationError(`Rule ${rule.name} needs a weekday`, { ruleId: rule.id });
      if (source.recurrence === 'once' && (!source.date || !/^\d{4}-\d{2}-\d{2}$/.test(source.date) || !Number.isFinite(Date.parse(`${source.date}T00:00:00Z`)) || new Date(`${source.date}T00:00:00Z`).toISOString().slice(0, 10) !== source.date)) throw new ConfigurationValidationError(`Rule ${rule.name} needs a valid date`, { ruleId: rule.id });
      if (!['all', 'once', 'skip'].includes(source.missedPolicy)) throw new ConfigurationValidationError(`Rule ${rule.name} has an invalid missed-event policy`, { ruleId: rule.id });
    }
    if (rule.condition) {
      if (rule.triggerMode === 'risingEdge' && collectEventReferences(rule.condition)) {
        throw new ConfigurationValidationError('risingEdge conditions cannot use event snapshots', { ruleId: rule.id });
      }
      const conditionType = checkExpression(rule.condition, parameterMap, eventParameter, `Condition for ${rule.name}`);
      if (conditionType.type !== 'boolean') {
        throw new ConfigurationValidationError(`Condition for ${rule.name} must return boolean`, { ruleId: rule.id });
      }
    }
    const localTypes = new Map<string, ExpressionType>();
    rule.actions.forEach((action, index) => {
      validateAction(action, rule.id, index, parameterMap, eventParameter, localTypes);
      if (action.type === 'input' && action.variableName && action.variableType) localTypes.set(`__local_${action.variableName}`, { type: action.variableType });
    });
  }
  return computed;
}

function collectEventReferences(expression: Expr): boolean {
  const stack = [expression];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.kind === 'event') return true;
    stack.push(...expressionChildren(item));
  }
  return false;
}

function valuesMap(values: Record<string, Value>): Map<string, Value> {
  return new Map(Object.entries(values));
}

function recomputeComputed(
  config: ProjectConfiguration,
  runtime: RuntimeState,
  computed: ComputedParameter[],
): void {
  const currentValues = valuesMap(runtime.values);
  for (const parameter of computed) {
    try {
      const value = evaluate(parameter.formula, currentValues);
      const canonical = canonicalizeValue(value, parameter.type, parameter.listItemType);
      runtime.values[parameter.id] = canonical;
      currentValues.set(parameter.id, canonical);
    } catch (error) {
      throw new EngineExecutionError(
        `Computed parameter ${parameter.name} (${parameter.id}): ${error instanceof Error ? error.message : String(error)}`,
        { parameterId: parameter.id },
        { cause: error },
      );
    }
  }
}

export function createInitialProjectState(config: ProjectConfiguration, revision = 0): ProjectState {
  const computed = validateProjectConfiguration(config);
  const runtime: RuntimeState = { values: {}, ruleTruth: {}, scheduleCursors: {} };
  for (const parameter of config.parameters) {
    if (parameter.kind === 'stored') {
      runtime.values[parameter.id] = canonicalizeValue(parameter.initialValue, parameter.type, parameter.listItemType);
    }
  }
  recomputeComputed(config, runtime, computed);
  const values = valuesMap(runtime.values);
  for (const rule of config.rules) {
    if (rule.enabled && rule.triggerMode === 'risingEdge' && rule.condition) {
      const condition = evaluate(rule.condition, values);
      runtime.ruleTruth[rule.id] = condition.type === 'boolean' && condition.value;
    }
  }
  return { config, runtime, revision };
}

export function rehydrateProjectState(
  config: ProjectConfiguration,
  runtime: RuntimeState,
  revision: number,
): ProjectState {
  const computed = validateProjectConfiguration(config);
  const scheduleRuleIds = new Set(config.rules.filter((rule) => rule.eventSource.type === 'periodic' || rule.eventSource.type === 'calendar').map((rule) => rule.id));
  const scheduleCursors = Object.fromEntries(Object.entries(runtime.scheduleCursors ?? {}).filter(([id, value]) => scheduleRuleIds.has(id) && Number.isFinite(Date.parse(value))));
  const cleanRuntime: RuntimeState = { values: {}, ruleTruth: { ...runtime.ruleTruth }, scheduleCursors };
  for (const parameter of config.parameters) {
    if (parameter.kind === 'stored') {
      cleanRuntime.values[parameter.id] = canonicalizeValue(
        runtime.values[parameter.id] ?? parameter.initialValue,
        parameter.type,
        parameter.listItemType,
      );
    }
  }
  recomputeComputed(config, cleanRuntime, computed);
  const enabledRuleIds = new Set(config.rules.filter((rule) => rule.enabled && rule.triggerMode === 'risingEdge').map((rule) => rule.id));
  for (const key of Object.keys(cleanRuntime.ruleTruth)) {
    if (!enabledRuleIds.has(key)) delete cleanRuntime.ruleTruth[key];
  }
  const currentValues = valuesMap(cleanRuntime.values);
  for (const rule of config.rules) {
    if (!rule.enabled || rule.triggerMode !== 'risingEdge' || !rule.condition) continue;
    if (!(rule.id in cleanRuntime.ruleTruth)) {
      const condition = evaluate(rule.condition, currentValues);
      cleanRuntime.ruleTruth[rule.id] = condition.type === 'boolean' && condition.value;
    }
  }
  return { config, runtime: cleanRuntime, revision };
}

export function parameterType(parameter: Parameter): PrimitiveType {
  return parameter.type;
}

export function listItemType(parameter: Parameter): ScalarType | undefined {
  return parameter.type === 'list' ? parameter.listItemType : undefined;
}
