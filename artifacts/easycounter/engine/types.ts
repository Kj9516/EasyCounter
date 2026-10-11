export type PrimitiveType = 'integer' | 'decimal' | 'string' | 'boolean';

export type Value =
  | { type: 'integer' | 'decimal'; value: string }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean };

export interface Parameter {
  id: string;
  name: string;
  type: PrimitiveType;
  initialValue: Value;
  value: Value;
}

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
  | { kind: 'call'; fn: 'floor' | 'abs' | 'min' | 'max' | 'number' | 'text' | 'length'; args: Expr[] };

export type Action =
  | { type: 'set'; parameterId: string; expression: Expr }
  | { type: 'add'; parameterId: string; expression: Expr };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  eventSource: { type: 'button'; id: string } | { type: 'changed'; parameterId: string };
  condition?: Expr;
  actions: Action[];
}

export interface ProjectState {
  parameters: Parameter[];
  rules: Rule[];
}

export interface EngineEvent {
  type: 'button' | 'changed';
  sourceId: string;
  occurredAt?: string;
  oldValue?: Value;
  newValue?: Value;
}

export interface Change {
  parameterId: string;
  oldValue: Value;
  newValue: Value;
  ruleId: string;
  occurredAt: string;
}

export interface ExecutionResult {
  status: 'completed';
  state: ProjectState;
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
