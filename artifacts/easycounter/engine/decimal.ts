/** Limits input growth so hostile formulas cannot allocate unbounded BigInts. */
export const MAX_DECIMAL_DIGITS = 1000;
export const MAX_DECIMAL_SCALE = 1000;

/** Exact finite decimal arithmetic, with no binary floating point intermediates. */
export class Decimal {
  private constructor(readonly coefficient: bigint, readonly scale: number) {}

  static parse(input: string | number | bigint | Decimal): Decimal {
    if (input instanceof Decimal) return input;
    const text = String(input).trim();
    if (text.length > MAX_DECIMAL_DIGITS + 2) {
      throw new Error(`Decimal exceeds ${MAX_DECIMAL_DIGITS} digits`);
    }
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`Invalid decimal: ${text}`);
    const fraction = match[3] ?? '';
    if (fraction.length > MAX_DECIMAL_SCALE) {
      throw new Error(`Decimal scale exceeds ${MAX_DECIMAL_SCALE} places`);
    }
    const integer = match[2];
    if (integer.length + fraction.length > MAX_DECIMAL_DIGITS) {
      throw new Error(`Decimal exceeds ${MAX_DECIMAL_DIGITS} digits`);
    }
    const sign = match[1] === '-' ? -1n : 1n;
    return Decimal.normalize(sign * BigInt(integer + fraction), fraction.length);
  }

  private static normalize(coefficient: bigint, scale: number): Decimal {
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale--;
    }
    if (scale > MAX_DECIMAL_SCALE) {
      throw new Error(`Decimal scale exceeds ${MAX_DECIMAL_SCALE} places`);
    }
    if ((coefficient < 0n ? -coefficient : coefficient).toString().length > MAX_DECIMAL_DIGITS) {
      throw new Error(`Decimal exceeds ${MAX_DECIMAL_DIGITS} digits`);
    }
    return new Decimal(coefficient, scale);
  }

  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [
      this.coefficient * 10n ** BigInt(scale - this.scale),
      other.coefficient * 10n ** BigInt(scale - other.scale),
      scale,
    ];
  }

  add(other: Decimal): Decimal {
    const [left, right, scale] = this.align(other);
    return Decimal.normalize(left + right, scale);
  }

  sub(other: Decimal): Decimal {
    const [left, right, scale] = this.align(other);
    return Decimal.normalize(left - right, scale);
  }

  mul(other: Decimal): Decimal {
    const scale = this.scale + other.scale;
    if (scale > MAX_DECIMAL_SCALE) {
      throw new Error(`Decimal scale exceeds ${MAX_DECIMAL_SCALE} places`);
    }
    return Decimal.normalize(this.coefficient * other.coefficient, scale);
  }

  compare(other: Decimal): number {
    const [left, right] = this.align(other);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  negate(): Decimal {
    return Decimal.normalize(-this.coefficient, this.scale);
  }

  abs(): Decimal {
    return this.coefficient < 0n ? this.negate() : this;
  }

  /** Division rounds half away from zero at the requested decimal scale. */
  div(other: Decimal, precision = 18): Decimal {
    if (other.coefficient === 0n) throw new Error('Division by zero');
    if (!Number.isInteger(precision) || precision < 0 || precision > MAX_DECIMAL_SCALE) {
      throw new Error('Invalid division precision');
    }
    const numerator = this.coefficient * 10n ** BigInt(precision + other.scale);
    const denominator = other.coefficient * 10n ** BigInt(this.scale);
    let quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const absRemainder = remainder < 0n ? -remainder : remainder;
    const absDenominator = denominator < 0n ? -denominator : denominator;
    if (remainder !== 0n && absRemainder * 2n >= absDenominator) {
      quotient += (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
    }
    return Decimal.normalize(quotient, precision);
  }

  floor(): Decimal {
    const divisor = 10n ** BigInt(this.scale);
    let value = this.coefficient / divisor;
    if (this.coefficient < 0n && this.coefficient % divisor !== 0n) value--;
    return Decimal.normalize(value, 0);
  }

  round(precision = 0): Decimal {
    if (!Number.isInteger(precision) || precision < 0 || precision > MAX_DECIMAL_SCALE) {
      throw new Error('Invalid rounding precision');
    }
    if (this.scale <= precision) return this;
    const discardedPlaces = this.scale - precision;
    const divisor = 10n ** BigInt(discardedPlaces);
    let quotient = this.coefficient / divisor;
    const remainder = this.coefficient % divisor;
    const absRemainder = remainder < 0n ? -remainder : remainder;
    if (absRemainder * 2n >= divisor) quotient += this.coefficient < 0n ? -1n : 1n;
    return Decimal.normalize(quotient, precision);
  }

  mod(other: Decimal): Decimal {
    if (other.coefficient === 0n) throw new Error('Division by zero');
    const [left, right, scale] = this.align(other);
    return Decimal.normalize(left % right, scale);
  }

  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient)
      .toString()
      .padStart(this.scale + 1, '0');
    const body = this.scale
      ? `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`
      : digits;
    return `${negative ? '-' : ''}${body}`;
  }
}
