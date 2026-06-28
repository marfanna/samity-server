import { describe, expect, it } from 'vitest';
import { assertPaisa, bdtToPaisa, largestRemainderSplit, paisaToBdt } from './money';

describe('money helpers', () => {
  it('rejects non-integer paisa', () => {
    expect(() => assertPaisa(100.5)).toThrow('amount must be integer paisa');
    expect(() => assertPaisa(100, 'nav')).not.toThrow();
  });

  it('formats integer paisa only at the display edge', () => {
    expect(paisaToBdt(0)).toBe('0.00');
    expect(paisaToBdt(12345)).toBe('123.45');
    expect(paisaToBdt(-12345)).toBe('-123.45');
  });

  it('parses BDT strings without accepting more than two decimal places', () => {
    expect(bdtToPaisa('123')).toBe(12300);
    expect(bdtToPaisa('123.4')).toBe(12340);
    expect(bdtToPaisa('-123.45')).toBe(-12345);
    expect(() => bdtToPaisa('123.456')).toThrow('invalid BDT amount');
  });

  it('splits positive paisa by largest remainder and preserves the total exactly', () => {
    const result = largestRemainderSplit(100, [1, 1, 1]);

    expect(result).toEqual([34, 33, 33]);
    expect(result.reduce((sum, part) => sum + part, 0)).toBe(100);
  });

  it('splits negative paisa by largest remainder and preserves the total exactly', () => {
    const result = largestRemainderSplit(-100, [1, 1, 1]);

    expect(result).toEqual([-33, -33, -34]);
    expect(result.reduce((sum, part) => sum + part, 0)).toBe(-100);
  });

  it('handles weighted profit splits without losing paisa', () => {
    const result = largestRemainderSplit(1001, [5, 3, 2]);

    expect(result).toEqual([501, 300, 200]);
    expect(result.reduce((sum, part) => sum + part, 0)).toBe(1001);
  });

  it('rejects zero-share distributions', () => {
    expect(() => largestRemainderSplit(100, [0, 0])).toThrow('weights must sum to a positive number');
  });
});
