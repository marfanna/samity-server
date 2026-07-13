import { describe, expect, it } from 'vitest';
import { assertPaisa, bdtToPaisa, paisaToBdt } from './money';

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
});
