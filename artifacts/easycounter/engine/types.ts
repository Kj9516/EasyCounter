export type ScalarType =
  | 'integer'
  | 'decimal'
  | 'string'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'duration'
  | 'timer';

export type PrimitiveType = ScalarType | 'list';

export interface TimerValue {
  elapsedMilliseconds: string;
  initialMilliseconds: string;
  direction: 'up' | 'down';
  status: 'running' | 'paused' | 'stopped';
  allowNegative: boolean;
  startedAt?: number;
}

export type ScalarValue =
  | { type: 'integer' | 'decimal' | 'duration'; value: string }
  | { type: 'string' | 'date' | 'time' | 'datetime'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'timer'; value: TimerValue };

export type Value = ScalarValue | {
  type: 'list';
  itemType: ScalarType;
  value: ScalarValue[];
};

interface ParameterBase {
  id: string;
  name: string;
  type: PrimitiveType;
  /** Required only when `type` is `list`; nested lists are not supported. */
  listItemType?: ScalarType;
  initialValue: Value;
}

export interface StoredParameter extends ParameterBase {
  kind: 'stored';
}

export interface ComputedParameter extends ParameterBase {
  kind: 'computed';
  formula: Expr;
}

export type Parameter = StoredParameter | ComputedParameter;

export type Expr =
  | { kind: 'literal'; value: Value }
  | { kind: 'parameter'; id: string }
  | { kind: 'event'; field: 'oldValue' | 'newValue' | 'delta' }
  | {
      kind: 'binary';
      op: '+' | '-' | '*' | '/' | 'mod' | '==' | '!=' | '>' | '>=' | '<' | '<=' | 'and' | 'or';
      left: Expr;
      right: Expr;
    }
  | { kind: 'unary'; op: 'not' | '-'; operand: Expr }
  | {
      kind: 'call';
      fn: 'floor' | 'round' | 'abs' | 'min' | 'max' | 'number' | 'text' | 'length' | 'contains' | 'if';
      args: Expr[];
    };

export type Action =
  | { type: 'set'; parameterId: string; expression: Expr }
  | { type: 'add'; parameterId: string; expression: Expr }
  | { type: 'listAdd'; parameterId: string; expression: Expr }
  | { type: 'listRemove'; parameterId: string; index: Expr }
  | { type: 'listReplace'; parameterId: string; index: Expr; expression: Expr };

export type EventSource =
  | { type: 'button'; id: string }
  | { type: 'changed' | 'assigned'; parameterId: string };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  eventSource: EventSource;
  triggerMode: 'each' | 'risingEdge';
  condition?: Expr;
  actions: Action[];
}

export interface ProjectConfiguration {
  parameters: Parameter[];
  rules: Rule[];
}

export interface RuntimeState {
  /** Current values, including recomputed read-only values for computed parameters. */
  values: Record<string, Value>;
  /** Last evaluated truth value for each rising-edge rule. */
  ruleTruth: Record<string, boolean>;
}

export interface ProjectState {
  config: ProjectConfiguration;
  runtime: RuntimeState;
  /** Incremented only by a successful persistent commit. */
  revision: number;
}

export interface EngineEvent {
  type: 'button' | 'changed' | 'assigned' | 'reset';
  sourceId: string;
  occurredAt?: string;
  oldValue?: Value;
  newValue?: Value;
  parameterIds?: string[];
}

export interface Change {
  parameterId: string;
  oldValue: Value;
  newValue: Value;
  ruleId: string | null;
  occurredAt: string;
}

export interface ExecutionResult {
  status: 'completed';
  state: ProjectState;
  baseRevision: number;
  rootEvent: EngineEvent;
  changes: Change[];
  /** Root event followed by every generated event, in FIFO order. */
  events: EngineEvent[];
  eventsProcessed: number;
}

export interface SuspendedExecution {
  status: 'suspended';
  /** Continue this in-memory operation to the next bounded execution slice. */
  continue: (maxActions?: number) => ExecutionResult | SuspendedExecution;
  /** Drop the isolated working copy. No partial state is returned or committed. */
  cancel: () => void;
}

export class EngineExecutionError extends Error {
  constructor(
    message: string,
    readonly details: {
      ruleId?: string;
      ruleName?: string;
      actionIndex?: number;
      parameterId?: string;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EngineExecutionError';
  }
}

export class ConfigurationValidationError extends Error {
  constructor(
    message: string,
    readonly details: { parameterId?: string; ruleId?: string; expressionPath?: string } = {},
  ) {
    super(message);
    this.name = 'ConfigurationValidationError';
  }
}
