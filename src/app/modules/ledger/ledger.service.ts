import mongoose, { Types } from 'mongoose';
import { AuditLog } from '../audit/auditLog.model';
import { Fund } from '../fund/fund.model';
import { Membership } from '../membership/membership.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { User } from '../user/user.model';
import { LedgerEntry, LedgerKind } from './ledgerEntry.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { memberValue, fundContributed } from '../../../shared/economics';
import { currentCycleIndex, cyclesBehind } from '../../../shared/cycle';
import { withFundLock } from '../../../shared/fundLock';
import { notifyUser } from '../../../shared/notify';
import { ApiError } from '../../../utils/ApiError';

function fid(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

// Only cash-moving kinds are reversible — DUES_PAID/SHARES_ISSUED/SHARES_TRANSFER also
// denormalize onto Membership.paidThroughCycle/shares directly (not purely ledger-derived),
// so reversing just the ledger entry would desync those counters. Out of scope for now.
const REVERSIBLE_KINDS: readonly LedgerKind[] = ['CASH_IN', 'CASH_OUT_INVEST', 'INVEST_RETURN', 'OPENING_CASH'];

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
  const wd = fund.policy.collectionWeekday;
  const currentCycle = currentCycleIndex(fund.policy.startDate, fund.policy.cycleUnit, new Date(), wd);
  const behind = cyclesBehind(fund.policy.startDate, fund.policy.cycleUnit, membership.paidThroughCycle, new Date(), wd);

  return {
    memberName: user?.name ?? '—',
    shares: membership.shares,
    contributed,
    currentValue,
    profitLoss: profitShare,
    paidThroughCycle: membership.paidThroughCycle,
    currentCycle,
    behindCycles: behind,
    entries: entries.map((e) => ({
      kind: e.kind,
      amount: e.amount,
      cyclesCovered: e.cyclesCovered,
      at: e.at,
    })),
  };
}

/**
 * Correct a mistaken cash-moving ledger entry (admin only) by appending an equal-and-opposite
 * REVERSAL entry — the ledger is append-only, so nothing is ever edited or deleted in place.
 * Scoped to CASH_KINDS entries (CASH_IN, CASH_OUT_INVEST, INVEST_RETURN, OPENING_CASH); see
 * REVERSIBLE_KINDS for why DUES_PAID/SHARES_ISSUED/SHARES_TRANSFER aren't supported here.
 */
export async function reverseLedgerEntry(actorId: string, fundId: string, entryId: string, reason: string) {
  return withFundLock(fundId, async () => {
    const session = await mongoose.startSession();
    try {
      let result!: { reversalId: string; nav: number };
      let affectedUserId: string | undefined;

      await session.withTransaction(async () => {
        const original = await LedgerEntry.findOne({ _id: entryId, fundId: fid(fundId) }).session(session);
        if (!original) throw new ApiError(404, 'NOT_FOUND', 'ledger entry not found');
        if (!REVERSIBLE_KINDS.includes(original.kind)) {
          throw new ApiError(
            400,
            'VALIDATION_ERROR',
            `cannot reverse a ${original.kind} entry — only cash-moving entries can be reversed`,
          );
        }
        const alreadyReversed = await LedgerEntry.exists({
          fundId: fid(fundId),
          reversalOf: original._id,
        }).session(session);
        if (alreadyReversed) throw new ApiError(409, 'STATE_CONFLICT', 'this entry was already reversed');

        const reversal = await appendLedger(
          {
            fundId,
            kind: 'REVERSAL',
            amount: -original.amount,
            ...(original.membershipId ? { membershipId: original.membershipId } : {}),
            refType: 'CORRECTION',
            reversalOf: original._id,
            createdBy: actorId,
          },
          session,
        );

        const nav = await computeNav(fundId, session);
        await NavSnapshot.create(
          [
            {
              fundId: fid(fundId),
              nav: nav.nav,
              totalShares: nav.totalShares,
              totalAssets: nav.totalAssets,
              cash: nav.cash,
              investedAtCost: nav.investedAtCost,
              reason: 'CORRECTION',
              meta: { reversalOf: String(original._id), reason },
            },
          ],
          { session },
        );

        await AuditLog.create(
          [
            {
              fundId: fid(fundId),
              actorId: fid(actorId),
              action: 'LEDGER_REVERSE',
              refType: 'CORRECTION',
              refId: original._id,
              before: { kind: original.kind, amount: original.amount },
              after: { reversalEntryId: String(reversal._id), reason },
            },
          ],
          { session },
        );

        if (original.membershipId) {
          const member = await Membership.findById(original.membershipId, { userId: 1 }).session(session).lean();
          affectedUserId = member ? String(member.userId) : undefined;
        }

        result = { reversalId: String(reversal._id), nav: nav.nav };
      });

      if (affectedUserId) {
        void notifyUser(affectedUserId, {
          type: 'LEDGER_CORRECTED',
          title: 'A ledger entry was corrected',
          body: reason,
          fundId,
        });
      }

      return result;
    } finally {
      await session.endSession();
    }
  });
}
