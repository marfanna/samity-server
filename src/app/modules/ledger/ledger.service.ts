import { Types } from 'mongoose';
import { Fund } from '../fund/fund.model';
import { Membership } from '../membership/membership.model';
import { User } from '../user/user.model';
import { LedgerEntry } from './ledgerEntry.model';
import { computeNav } from '../../../shared/nav';
import { memberValue, fundContributed } from '../../../shared/economics';
import { currentCycleIndex, cyclesBehind } from '../../../shared/cycle';
import { ApiError } from '../../../utils/ApiError';

function fid(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

/** Personal position + cycle status + my own ledger entries. */
export async function getMyLedger(fundId: string, membershipId: string) {
  const [membership, fund, nav] = await Promise.all([
    Membership.findOne({ _id: membershipId, fundId }).lean(),
    Fund.findById(fundId).lean(),
    computeNav(fundId),
  ]);

  if (!membership) throw new ApiError(403, 'FORBIDDEN_ROLE', 'not a member');
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');

  const [contributedAgg, totalContributed, entries] = await Promise.all([
    LedgerEntry.aggregate<{ total: number }>([
      {
        $match: {
          fundId: fid(fundId),
          membershipId: fid(membershipId),
          kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    fundContributed(fundId),
    LedgerEntry.find({ fundId: fid(fundId), membershipId: fid(membershipId) })
      .sort({ at: -1 })
      .limit(50)
      .lean(),
  ]);

  const contributed = contributedAgg[0]?.total ?? 0;
  const { value: currentValue, profitShare: profitLoss } = memberValue(
    contributed,
    totalContributed,
    nav.totalAssets,
  );

  const wd = fund.policy.collectionWeekday;
  const currentCycle = currentCycleIndex(fund.policy.startDate, fund.policy.cycleUnit, new Date(), wd);
  const behind = cyclesBehind(fund.policy.startDate, fund.policy.cycleUnit, membership.paidThroughCycle, new Date(), wd);
  const perCycleDuePaisa = membership.shares * fund.faceValue;
  const amountDuePaisa = behind * perCycleDuePaisa;

  return {
    shares: membership.shares,
    contributed,
    currentValue,
    profitLoss,
    paidThroughCycle: membership.paidThroughCycle,
    currentCycle,
    behindCycles: behind,
    cycleUnit: fund.policy.cycleUnit,
    perCycleDuePaisa,
    amountDuePaisa,
    entries: entries.map((e) => ({
      kind: e.kind,
      amount: e.amount,
      cyclesCovered: e.cyclesCovered,
      at: e.at,
    })),
  };
}

/** Fund-level ledger (all CASH_KINDS entries, no per-member attribution). */
export async function getFundLedger(fundId: string) {
  const entries = await LedgerEntry.find({
    fundId: fid(fundId),
    kind: { $in: ['CASH_IN', 'CASH_OUT_INVEST', 'INVEST_RETURN', 'REVERSAL'] },
  })
    .sort({ at: -1 })
    .limit(100)
    .lean();

  return entries.map((e) => ({
    kind: e.kind,
    amount: e.amount,
    refType: e.refType,
    at: e.at,
  }));
}

/** Member ledger for admin/mod viewing any member. */
export async function getMemberLedger(fundId: string, membershipId: string) {
  const [membership, fund, nav] = await Promise.all([
    Membership.findOne({ _id: membershipId, fundId }).lean(),
    Fund.findById(fundId).lean(),
    computeNav(fundId),
  ]);
  if (!membership) throw new ApiError(404, 'NOT_FOUND', 'membership not found');
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');

  const user = await User.findById(membership.userId, { name: 1 }).lean();

  const [contributedAgg, totalContributed, entries] = await Promise.all([
    LedgerEntry.aggregate<{ total: number }>([
      { $match: { fundId: fid(fundId), membershipId: fid(membershipId), kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    fundContributed(fundId),
    LedgerEntry.find({ fundId: fid(fundId), membershipId: fid(membershipId) })
      .sort({ at: -1 })
      .limit(50)
      .lean(),
  ]);

  const contributed = contributedAgg[0]?.total ?? 0;
  const { value: currentValue, profitShare } = memberValue(contributed, totalContributed, nav.totalAssets);
  const behind = cyclesBehind(
    fund.policy.startDate,
    fund.policy.cycleUnit,
    membership.paidThroughCycle,
    new Date(),
    fund.policy.collectionWeekday,
  );

  return {
    memberName: user?.name ?? '—',
    shares: membership.shares,
    contributed,
    currentValue,
    profitLoss: profitShare,
    paidThroughCycle: membership.paidThroughCycle,
    behindCycles: behind,
    entries: entries.map((e) => ({
      kind: e.kind,
      amount: e.amount,
      cyclesCovered: e.cyclesCovered,
      at: e.at,
    })),
  };
}
