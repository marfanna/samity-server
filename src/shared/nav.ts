import { ClientSession, Types } from 'mongoose';
import { LedgerEntry } from '../app/modules/ledger/ledgerEntry.model';
import { Investment } from '../app/modules/investment/investment.model';
import { Fund } from '../app/modules/fund/fund.model';
import { currentCycleIndex } from './cycle';

/** Ledger kinds that move fund cash. Dues/penalty/shares don't count toward NAV assets. */
const CASH_KINDS = ['CASH_IN', 'CASH_OUT_INVEST', 'INVEST_RETURN', 'REVERSAL', 'OPENING_CASH'] as const;

export interface NavResult {
  nav: number; // integer paisa per share
  totalShares: number;
  totalAssets: number; // cash + investedAtCost
  cash: number;
  investedAtCost: number;
}

/**
 * Derive NAV from the ledger — never read a stored value as truth.
 * NAV (price per share) = principal (cyclesElapsed × faceValue) + realized profit/loss per share.
 * cash/investedAtCost/totalAssets remain the real ledger-derived fund position (used elsewhere
 * for member payout math) — only the `nav` price field follows the schedule-based formula.
 * Call inside the money-mutation transaction (pass the session) so it reflects this write.
 */
export async function computeNav(fundId: Types.ObjectId | string, session?: ClientSession): Promise<NavResult> {
  const fid = new Types.ObjectId(fundId);

  // Chain .session() (not an options arg) so aggregates read the same transaction snapshot —
  // critical so NAV computed mid-mutation sees this write's uncommitted ledger entries.
  const sumLedger = (match: Record<string, unknown>, field: string) => {
    const agg = LedgerEntry.aggregate<{ total: number }>([
      { $match: { fundId: fid, ...match } },
      { $group: { _id: null, total: { $sum: `$${field}` } } },
    ]);
    if (session) agg.session(session);
    return agg;
  };

  const investedAgg = Investment.aggregate<{ total: number }>([
    { $match: { fundId: fid, state: 'ACTIVE' } },
    { $group: { _id: null, total: { $sum: '$amountCost' } } },
  ]);
  if (session) investedAgg.session(session);

  // Realized profit/loss only (returned/settled investments) — feeds the per-share profit split.
  const profitAgg = Investment.aggregate<{ total: number }>([
    { $match: { fundId: fid, state: { $in: ['RETURNED', 'SETTLED'] } } },
    { $group: { _id: null, total: { $sum: '$profitLoss' } } },
  ]);
  if (session) profitAgg.session(session);

  const [cashAgg, sharesAgg, invested, profit, fund] = await Promise.all([
    sumLedger({ kind: { $in: CASH_KINDS } }, 'amount'),
    sumLedger({}, 'shares'),
    investedAgg,
    profitAgg,
    Fund.findById(fid, { faceValue: 1, policy: 1 })
      .session(session ?? null)
      .lean(),
  ]);

  const cash = cashAgg[0]?.total ?? 0;
  const totalShares = sharesAgg[0]?.total ?? 0;
  const investedAtCost = invested[0]?.total ?? 0;
  const totalAssets = cash + investedAtCost;
  const profitLossTotal = profit[0]?.total ?? 0;

  const faceValue = fund?.faceValue ?? 0;
  const cyclesElapsed = fund
    ? currentCycleIndex(fund.policy.startDate, fund.policy.cycleUnit, new Date(), fund.policy.collectionWeekday)
    : 0;
  // Before the first cycle rolls over, price at one face value (fair price for the founding buy-in).
  const principalPerShare = faceValue * Math.max(cyclesElapsed, 1);
  const profitPerShare = totalShares > 0 ? Math.round(profitLossTotal / totalShares) : 0;
  const nav = principalPerShare + profitPerShare;

  return { nav, totalShares, totalAssets, cash, investedAtCost };
}
