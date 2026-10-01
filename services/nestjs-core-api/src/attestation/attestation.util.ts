import { createHash, timingSafeEqual } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return { $fida_number: canonicalNumber(value) };
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const item = record[key];
        if (item !== undefined) result[key] = canonicalize(item);
        return result;
      }, {});
  }
  throw new Error(`Unsupported canonical JSON type: ${typeof value}`);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot encode non-finite numbers');
  if (Object.is(value, -0) || value === 0) return '0';
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error('Canonical integer exceeds the JavaScript safe integer range');
    }
    return value.toString(10);
  }
  if (Math.abs(value) >= 1_000_000_000_000_000) {
    throw new Error('Canonical fractional number magnitude is too large');
  }
  return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}
