import type { CycleUnit } from '../app/modules/fund/fund.model';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Index of the current contribution cycle since the fund's start date (cycle 0 = the
 * start). DAILY/WEEKLY use elapsed days; MONTHLY uses elapsed calendar months.
 * Computed against UTC for now (Asia/Dhaka refinement is a later concern).
 */
export function currentCycleIndex(startDate: Date, unit: CycleUnit, now: Date = new Date()): number {
  if (now <= startDate) return 0;

  switch (unit) {
    case 'DAILY':
      return Math.floor((now.getTime() - startDate.getTime()) / DAY_MS);
    case 'WEEKLY':
      return Math.floor((now.getTime() - startDate.getTime()) / (7 * DAY_MS));
    case 'MONTHLY': {
      const months =
        (now.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - startDate.getUTCMonth());
      // not a full month yet if the day-of-month hasn't been reached
      return now.getUTCDate() < startDate.getUTCDate() ? Math.max(0, months - 1) : months;
    }
  }
}

/**
 * How many cycles a member is behind: cycles elapsed minus cycles paid, floored at 0.
 * Only meaningful for active members holding shares.
 */
export function cyclesBehind(
  startDate: Date,
  unit: CycleUnit,
  paidThroughCycle: number,
  now: Date = new Date(),
): number {
  return Math.max(0, currentCycleIndex(startDate, unit, now) - paidThroughCycle);
}
