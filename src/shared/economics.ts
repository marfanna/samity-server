import { ClientSession, Types } from 'mongoose';
import { LedgerEntry } from '../app/modules/ledger/ledgerEntry.model';

/**
 * A member's value = their contributed principal + their share of fund profit.
 * Profit is split by money actually paid (paid-up members only), NOT by committed shares.
 * So a member who paid ৳0 gets ৳0 profit; whoever paid more earns proportionally more.
 *
 *   profit        = totalAssets − totalContributed   (0 until an investment returns a gain)
 *   myProfitShare = (myContributed ÷ totalContributed) × profit
 *   myValue       = myContributed + myProfitShare
 */
export function memberValue(
  myContributed: number,
  totalContributed: number,
  totalAssets: number,
): { value: number; profitShare: number } {
  const profit = totalAssets - totalContributed;
  const profitShare = totalContributed > 0 ? Math.round((myContributed / totalContributed) * profit) : 0;
  return { value: myContributed + profitShare, profitShare };
}

/** Sum of everyone's paid-in principal for a fund (CASH_IN + imported OPENING_CONTRIBUTION). */
export async function fundContributed(fundId: Types.ObjectId | string, session?: ClientSession): Promise<number> {
  const agg = LedgerEntry.aggregate<{ total: number }>([
    { $match: { fundId: new Types.ObjectId(fundId), kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  if (session) agg.session(session);
  const res = await agg;
  return res[0]?.total ?? 0;
}
