import { ClientSession, Types } from 'mongoose';
import { LedgerEntry } from '../app/modules/ledger/ledgerEntry.model';
import { Investment } from '../app/modules/investment/investment.model';
import { Fund } from '../app/modules/fund/fund.model';

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
 * NAV = (cash + investedAtCost) / totalShares. Outstanding dues are NOT assets.
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

  const [cashAgg, sharesAgg, invested, fund] = await Promise.all([
    sumLedger({ kind: { $in: CASH_KINDS } }, 'amount'),
    sumLedger({}, 'shares'),
    investedAgg,
    Fund.findById(fid, { faceValue: 1 })
      .session(session ?? null)
      .lean(),
  ]);

  const cash = cashAgg[0]?.total ?? 0;
  const totalShares = sharesAgg[0]?.total ?? 0;
  const investedAtCost = invested[0]?.total ?? 0;
  const totalAssets = cash + investedAtCost;

  // No shares yet → NAV anchors to face value (fair price for the first buy-in).
  const nav = totalShares > 0 ? Math.round(totalAssets / totalShares) : (fund?.faceValue ?? 0);

  return { nav, totalShares, totalAssets, cash, investedAtCost };
}
