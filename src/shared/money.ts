/**
 * Money helpers. ALL currency is integer paisa (1 BDT = 100 paisa). Never use float for money.
 * NAV is the only ratio shown with decimals, and only at the display edge.
 */

export type Paisa = number; // integer

export function assertPaisa(n: number, label = 'amount'): void {
  if (!Number.isInteger(n)) throw new Error(`${label} must be integer paisa, got ${n}`);
}

/** Display only: 12345 paisa -> "123.45". Never feed this back into math. */
export function paisaToBdt(p: Paisa): string {
  assertPaisa(p, 'paisa');
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parse "123.45" -> 12345 paisa. Rejects >2 decimal places. */
export function bdtToPaisa(bdt: string): Paisa {
  const m = /^-?\d+(\.\d{1,2})?$/.exec(bdt.trim());
  if (!m) throw new Error(`invalid BDT amount: ${bdt}`);
  const neg = bdt.trim().startsWith('-');
  const [whole, frac = ''] = bdt.trim().replace('-', '').split('.');
  const paisa = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -paisa : paisa;
}
