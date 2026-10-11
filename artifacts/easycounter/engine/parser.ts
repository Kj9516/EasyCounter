import type { Expr } from './types';

const MAX_EXPRESSION_LENGTH = 20_000;
const MAX_NESTING_DEPTH = 128;

interface Token {
  kind: 'number' | 'string' | 'reference' | 'identifier' | 'operator' | 'punctuation' | 'eof';
  text: string;
  position: number;
}

export class ExpressionParseError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} (позиция ${position + 1})`);
    this.name = 'ExpressionParseError';
  }
}

function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionParseError(`Формула длиннее ${MAX_EXPRESSION_LENGTH} символов`, MAX_EXPRESSION_LENGTH);
  }
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const current = source[position];
    if (/\s/.test(current)) {
      position++;
      continue;
    }

    const start = position;
    if (current === '@' && source[position + 1] === '{') {
      const end = source.indexOf('}', position + 2);
      if (end < 0) throw new ExpressionParseError('Не закрыта ссылка на параметр', start);
      const id = source.slice(position + 2, end).trim();
      if (!id) throw new ExpressionParseError('Пустая ссылка на параметр', start);
      tokens.push({ kind: 'reference', text: id, position: start });
      position = end + 1;
      continue;
    }

    if (current === '"' || current === "'") {
      const quote = current;
      let text = '';
      position++;
      let closed = false;
      while (position < source.length) {
        const char = source[position++];
        if (char === quote) {
          closed = true;
          break;
        }
        if (char === '\\') {
          if (position >= source.length) throw new ExpressionParseError('Незавершенная escape-последовательность', start);
          const escaped = source[position++];
          const replacements: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
          if (!(escaped in replacements)) throw new ExpressionParseError(`Недопустимая escape-последовательность \\${escaped}`, position - 2);
          text += replacements[escaped];
        } else {
          text += char;
        }
      }
      if (!closed) throw new ExpressionParseError('Не закрыта строка', start);
      tokens.push({ kind: 'string', text, position: start });
      continue;
    }

    const number = /^(?:\d+\.\d+|\d+|\.\d+)/.exec(source.slice(position));
    if (number) {
      if (number[0].startsWith('.')) throw new ExpressionParseError('Перед дробной частью нужна целая часть', start);
      tokens.push({ kind: 'number', text: number[0], position: start });
      position += number[0].length;
      continue;
    }

    const identifier = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(position));
    if (identifier) {
      tokens.push({ kind: 'identifier', text: identifier[0], position: start });
      position += identifier[0].length;
      continue;
    }

    const operator = ['>=', '<=', '==', '!=', '&&', '||'].find((item) => source.startsWith(item, position));
    if (operator) {
      tokens.push({ kind: 'operator', text: operator, position: start });
      position += operator.length;
      continue;
    }
    if ('+-*/%><!'.includes(current)) {
      tokens.push({ kind: 'operator', text: current, position: start });
      position++;
      continue;
    }
    if ('(),'.includes(current)) {
      tokens.push({ kind: 'punctuation', text: current, position: start });
      position++;
      continue;
    }
    throw new ExpressionParseError(`Недопустимый символ «${current}»`, start);
  }
  tokens.push({ kind: 'eof', text: '', position: source.length });
  return tokens;
}

const binaryOperators = {
  or: 'or', '||': 'or',
  and: 'and', '&&': 'and',
  '==': '==', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
  '+': '+', '-': '-', '*': '*', '/': '/', '%': 'mod', mod: 'mod',
} as const;

type BinaryToken = keyof typeof binaryOperators;

class Parser {
  private index = 0;
  private nesting = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expression = this.parseOr();
    if (this.peek().kind !== 'eof') {
      throw new ExpressionParseError(`Лишний токен «${this.peek().text}»`, this.peek().position);
    }
    return expression;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private consume(): Token {
    return this.tokens[this.index++];
  }

  private match(text: string): boolean {
    if (this.peek().text.toLowerCase() !== text) return false;
    this.consume();
    return true;
  }

  private binary(left: Expr, token: Token): Expr {
    const operator = token.text.toLowerCase() as BinaryToken;
    return { kind: 'binary', op: binaryOperators[operator], left, right: this.parseNextLevel(operator) };
  }

  private parseOr(): Expr {
    let expression = this.parseAnd();
    while (['or', '||'].includes(this.peek().text.toLowerCase())) expression = this.binary(expression, this.consume());
    return expression;
  }

  private parseAnd(): Expr {
    let expression = this.parseEquality();
    while (['and', '&&'].includes(this.peek().text.toLowerCase())) expression = this.binary(expression, this.consume());
    return expression;
  }

  private parseEquality(): Expr {
    let expression = this.parseComparison();
    while (['==', '!='].includes(this.peek().text)) expression = this.binary(expression, this.consume());
    return expression;
  }

  private parseComparison(): Expr {
    let expression = this.parseAdditive();
    while (['>', '>=', '<', '<='].includes(this.peek().text)) expression = this.binary(expression, this.consume());
    return expression;
  }

  private parseAdditive(): Expr {
    let expression = this.parseMultiplicative();
    while (['+', '-'].includes(this.peek().text)) expression = this.binary(expression, this.consume());
    return expression;
  }

  private parseMultiplicative(): Expr {
    let expression = this.parseUnary();
    while (['*', '/', '%', 'mod'].includes(this.peek().text.toLowerCase())) {
      expression = this.binary(expression, this.consume());
    }
    return expression;
  }

  private parseUnary(): Expr {
    const token = this.peek();
    const keyword = token.text.toLowerCase();
    if (token.text === '-' || token.text === '!' || keyword === 'not') {
      this.consume();
      return { kind: 'unary', op: token.text === '-' ? '-' : 'not', operand: this.nested(() => this.parseUnary(), token.position) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.consume();
    if (token.kind === 'number') {
      return { kind: 'literal', value: token.text.includes('.')
        ? { type: 'decimal', value: token.text }
        : { type: 'integer', value: token.text } };
    }
    if (token.kind === 'string') return { kind: 'literal', value: { type: 'string', value: token.text } };
    if (token.kind === 'reference') return { kind: 'parameter', id: token.text };
    if (token.kind === 'identifier') {
      const identifier = token.text.toLowerCase();
      if (identifier === 'true' || identifier === 'false') {
        return { kind: 'literal', value: { type: 'boolean', value: identifier === 'true' } };
      }
      if (identifier === 'oldvalue' || identifier === 'newvalue' || identifier === 'delta') {
        return { kind: 'event', field: identifier === 'oldvalue' ? 'oldValue' : identifier === 'newvalue' ? 'newValue' : 'delta' };
      }
      if (this.match('(')) {
        const args: Expr[] = [];
        if (!this.match(')')) {
          do {
            args.push(this.nested(() => this.parseOr(), this.peek().position));
          } while (this.match(','));
          this.expect(')');
        }
        const supported = ['floor', 'round', 'abs', 'min', 'max', 'number', 'text', 'length', 'contains', 'if'];
        if (!supported.includes(identifier)) throw new ExpressionParseError(`Неизвестная функция «${token.text}»`, token.position);
        return { kind: 'call', fn: identifier as 'floor' | 'round' | 'abs' | 'min' | 'max' | 'number' | 'text' | 'length' | 'contains' | 'if', args };
      }
      throw new ExpressionParseError(`Неизвестный идентификатор «${token.text}»; параметр задается как @{id}`, token.position);
    }
    if (token.text === '(') {
      const expression = this.nested(() => this.parseOr(), token.position);
      this.expect(')');
      return expression;
    }
    throw new ExpressionParseError('Ожидалось значение или выражение в скобках', token.position);
  }

  private parseNextLevel(operator: BinaryToken): Expr {
    switch (operator) {
      case 'or': case '||': return this.parseAnd();
      case 'and': case '&&': return this.parseEquality();
      case '==': case '!=': return this.parseComparison();
      case '>': case '>=': case '<': case '<=': return this.parseAdditive();
      case '+': case '-': return this.parseMultiplicative();
      case '*': case '/': case '%': case 'mod': return this.parseUnary();
    }
  }

  private expect(text: string): void {
    if (!this.match(text)) throw new ExpressionParseError(`Ожидался символ «${text}»`, this.peek().position);
  }

  private nested<T>(parse: () => T, position: number): T {
    this.nesting++;
    if (this.nesting > MAX_NESTING_DEPTH) {
      throw new ExpressionParseError(`Вложенность превышает ${MAX_NESTING_DEPTH}`, position);
    }
    try {
      return parse();
    } finally {
      this.nesting--;
    }
  }
}

/** Parse a restricted expression language; it never executes JavaScript. */
export function parseExpression(source: string): Expr {
  return new Parser(tokenize(source)).parse();
}
