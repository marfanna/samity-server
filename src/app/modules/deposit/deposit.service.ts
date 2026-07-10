import mongoose, { Types } from 'mongoose';
import { AuditLog } from '../audit/auditLog.model';
import { Fund } from '../fund/fund.model';
import { Investment } from '../investment/investment.model';
import { Membership } from '../membership/membership.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { User } from '../user/user.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { presignedUrl } from '../../../shared/storage';
import { withFundLock } from '../../../shared/fundLock';
import { notifyUser, notifyFundManagers } from '../../../shared/notify';
import { ApiError } from '../../../utils/ApiError';
import { Deposit, DepositStatus } from './deposit.model';
import type { ListDepositsQuery, RejectDepositInput, SubmitDepositInput } from './deposit.validation';

type DepositListItem = {
  depositId: string;
  membershipId: string;
  memberName: string;
  type: string;
  amount: number;
  cyclesCovered: number;
  sharesRequested: number;
  screenshotUrl: string;
  screenshotViewUrl?: string;
  status: DepositStatus;
  reason?: string;
  createdAt: Date;
};

function oid(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

async function assertDepositShape(fundId: string, membershipId: string, input: SubmitDepositInput): Promise<number> {
  const [fund, membership, nav] = await Promise.all([
    Fund.findById(fundId).lean(),
    Membership.findOne({ _id: membershipId, fundId }).lean(),
    computeNav(fundId),
  ]);

  if (!fund || fund.status !== 'ACTIVE') throw new ApiError(404, 'NOT_FOUND', 'fund not found');
  if (!membership) throw new ApiError(403, 'FORBIDDEN_ROLE', 'not a member of this fund');

  if (input.type === 'BUY_IN') {
    if (!['PENDING_BUYIN', 'ACTIVE'].includes(membership.status)) {
      throw new ApiError(409, 'STATE_CONFLICT', 'buy-in requires a pending or active membership');
    }
    if (membership.status === 'ACTIVE' && !['BUY_AT_NAV', 'BOTH'].includes(fund.policy.shareChange)) {
      throw new ApiError(403, 'FORBIDDEN_ROLE', 'this fund does not allow buying more shares');
    }
    if (input.sharesRequested <= 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'BUY_IN requires sharesRequested');
    }
    if (input.cyclesCovered !== 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'BUY_IN cyclesCovered must be 0');
    }
    if (fund.policy.joinLock === 'BLOCK_DURING_INVESTMENT') {
      const activeInvestment = await Investment.exists({ fundId, state: 'ACTIVE' });
      if (activeInvestment) throw new ApiError(403, 'JOIN_LOCKED', 'buy-in is blocked during an active investment');
    }
    const expected = input.sharesRequested * nav.nav;
    if (input.amount !== expected) {
      throw new ApiError(409, 'AMOUNT_MISMATCH', 'buy-in amount must equal sharesRequested × current NAV');
    }
    return nav.nav;
  }

  if (membership.status !== 'ACTIVE') {
    throw new ApiError(409, 'STATE_CONFLICT', 'regular deposits require an active membership');
  }
  if (membership.shares <= 0) {
    throw new ApiError(409, 'STATE_CONFLICT', 'regular deposits require issued shares');
  }
  if (input.sharesRequested !== 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${input.type} sharesRequested must be 0`);
  }

  const expectedCycles = input.type === 'REGULAR' ? 1 : input.cyclesCovered;
  if (input.cyclesCovered !== expectedCycles || expectedCycles <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${input.type} cyclesCovered is invalid`);
  }

  const expectedAmount = membership.shares * fund.faceValue * expectedCycles;
  if (input.amount !== expectedAmount) {
    throw new ApiError(409, 'AMOUNT_MISMATCH', 'deposit amount must equal shares × faceValue × cyclesCovered');
  }

  return 0;
}

export async function submitDeposit(
  actorId: string,
  fundId: string,
  membershipId: string,
  input: SubmitDepositInput,
) {
  const navAtSubmit = await assertDepositShape(fundId, membershipId, input);
  const deposit = await Deposit.create({
    fundId: oid(fundId),
    membershipId: oid(membershipId),
    type: input.type,
    amount: input.amount,
    cyclesCovered: input.type === 'BUY_IN' ? 0 : input.cyclesCovered,
    sharesRequested: input.type === 'BUY_IN' ? input.sharesRequested : 0,
    screenshotUrl: input.screenshotUrl,
    navAtSubmit,
    status: 'PENDING',
    note: input.note,
  });

  await AuditLog.create({
    fundId: oid(fundId),
    actorId: oid(actorId),
    action: 'DEPOSIT_SUBMIT',
    refType: 'DEPOSIT',
    refId: deposit._id,
    after: { type: deposit.type, amount: deposit.amount, membershipId },
  });

  notifyFundManagers(fundId, actorId, {
    type: 'DEPOSIT_SUBMITTED',
    title: 'Deposit awaiting verification',
    body: `৳${Math.round(deposit.amount / 100)} ${deposit.type.toLowerCase()} deposit submitted — needs review.`,
    fundId,
  });

  return {
    depositId: String(deposit._id),
    status: deposit.status,
    navAtSubmit: deposit.navAtSubmit,
  };
}

export async function listDeposits(fundId: string, query: ListDepositsQuery): Promise<DepositListItem[]> {
  const filter: Record<string, unknown> = { fundId };
  if (query.status) filter.status = query.status;

  const deposits = await Deposit.find(filter).sort({ createdAt: 1 }).limit(query.limit).lean();
  const memberships = await Membership.find({ _id: { $in: deposits.map((d) => d.membershipId) } }).lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }, { name: 1 }).lean();
  const membershipById = new Map(memberships.map((m) => [String(m._id), m]));
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  return Promise.all(deposits.map(async (deposit) => {
    const membership = membershipById.get(String(deposit.membershipId));
    const reason = deposit.reason;
    const screenshotViewUrl = deposit.screenshotUrl === 'FOUNDING'
      ? undefined
      : await presignedUrl(deposit.screenshotUrl);
    return {
      depositId: String(deposit._id),
      membershipId: String(deposit.membershipId),
      memberName: membership ? (nameById.get(String(membership.userId)) ?? '—') : '—',
      type: deposit.type,
      amount: deposit.amount,
      cyclesCovered: deposit.cyclesCovered,
      sharesRequested: deposit.sharesRequested,
      screenshotUrl: deposit.screenshotUrl,
      ...(screenshotViewUrl ? { screenshotViewUrl } : {}),
      status: deposit.status,
      ...(reason ? { reason } : {}),
      createdAt: deposit.createdAt,
    };
  }));
}

export async function listMyDeposits(fundId: string, membershipId: string): Promise<DepositListItem[]> {
  const deposits = await Deposit.find({ fundId, membershipId }).sort({ createdAt: -1 }).lean();
  return Promise.all(deposits.map(async (deposit) => {
    const reason = deposit.reason;
    const screenshotViewUrl = deposit.screenshotUrl === 'FOUNDING'
      ? undefined
      : await presignedUrl(deposit.screenshotUrl);
    return {
      depositId: String(deposit._id),
      membershipId: String(deposit.membershipId),
      memberName: 'You',
      type: deposit.type,
      amount: deposit.amount,
      cyclesCovered: deposit.cyclesCovered,
      sharesRequested: deposit.sharesRequested,
      screenshotUrl: deposit.screenshotUrl,
      ...(screenshotViewUrl ? { screenshotViewUrl } : {}),
      status: deposit.status,
      ...(reason ? { reason } : {}),
      createdAt: deposit.createdAt,
    };
  }));
}

export async function verifyDeposit(actorId: string, fundId: string, depositId: string) {
  return withFundLock(fundId, async () => {
    const session = await mongoose.startSession();
    try {
      let result:
        | {
            depositId: string;
            status: DepositStatus;
            sharesIssued: number;
            navAtVerify: number;
            nav: number;
          }
        | undefined;
      let depositorUserId = '';
      let depositAmountPaisa = 0;

      await session.withTransaction(async () => {
        const deposit = await Deposit.findOne({ _id: depositId, fundId }).session(session);
        if (!deposit) throw new ApiError(404, 'NOT_FOUND', 'deposit not found');
        if (deposit.status !== 'PENDING') throw new ApiError(409, 'STATE_CONFLICT', 'deposit already decided');

        const membership = await Membership.findOne({ _id: deposit.membershipId, fundId }).session(session);
        if (!membership) throw new ApiError(404, 'NOT_FOUND', 'membership not found');
        if (String(membership.userId) === actorId) {
          throw new ApiError(403, 'SELF_DEAL_BLOCKED', 'cannot verify your own deposit');
        }
        depositorUserId = String(membership.userId);
        depositAmountPaisa = deposit.amount;

        const before = {
          status: deposit.status,
          shares: membership.shares,
          paidThroughCycle: membership.paidThroughCycle,
        };
        const navBefore = await computeNav(fundId, session);
        let sharesIssued = 0;

        if (deposit.type === 'BUY_IN') {
          const fund = await Fund.findById(fundId).session(session).lean();
          if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');
          if (!['PENDING_BUYIN', 'ACTIVE'].includes(membership.status)) {
            throw new ApiError(409, 'STATE_CONFLICT', 'buy-in requires a pending or active membership');
          }
          if (membership.status === 'ACTIVE' && !['BUY_AT_NAV', 'BOTH'].includes(fund.policy.shareChange)) {
            throw new ApiError(403, 'FORBIDDEN_ROLE', 'this fund does not allow buying more shares');
          }
          if (fund.policy.joinLock === 'BLOCK_DURING_INVESTMENT') {
            const activeInvestment = await Investment.exists({ fundId, state: 'ACTIVE' }).session(session);
            if (activeInvestment) throw new ApiError(403, 'JOIN_LOCKED', 'buy-in is blocked during an active investment');
          }
          const expected = deposit.sharesRequested * navBefore.nav;
          if (deposit.amount !== expected) {
            throw new ApiError(409, 'AMOUNT_MISMATCH', 'buy-in amount no longer matches current NAV');
          }
          sharesIssued = deposit.sharesRequested;
        }

        const updated = await Deposit.updateOne(
          { _id: deposit._id, status: 'PENDING' },
          {
            $set: {
              status: 'VERIFIED',
              verifiedBy: oid(actorId),
              decidedAt: new Date(),
              navAtVerify: deposit.type === 'BUY_IN' ? navBefore.nav : 0,
              sharesIssued,
            },
          },
          { session },
        );
        if (updated.matchedCount === 0) {
          throw new ApiError(409, 'STATE_CONFLICT', 'deposit already decided');
        }

        await appendLedger(
          {
            fundId,
            kind: 'CASH_IN',
            amount: deposit.amount,
            membershipId: membership._id,
            refType: 'DEPOSIT',
            refId: deposit._id,
            createdBy: actorId,
          },
          session,
        );

        if (deposit.type === 'BUY_IN') {
          await Membership.updateOne(
            { _id: membership._id },
            {
              $inc: { shares: sharesIssued },
              $set: { status: 'ACTIVE', joinNav: navBefore.nav },
            },
            { session },
          );
          await appendLedger(
            {
              fundId,
              kind: 'SHARES_ISSUED',
              shares: sharesIssued,
              membershipId: membership._id,
              refType: 'DEPOSIT',
              refId: deposit._id,
              createdBy: actorId,
            },
            session,
          );
        } else {
          await Membership.updateOne(
            { _id: membership._id },
            { $inc: { paidThroughCycle: deposit.cyclesCovered } },
            { session },
          );
          await appendLedger(
            {
              fundId,
              kind: 'DUES_PAID',
              cyclesCovered: deposit.cyclesCovered,
              membershipId: membership._id,
              refType: 'DEPOSIT',
              refId: deposit._id,
              createdBy: actorId,
            },
            session,
          );
        }

        const nav = await computeNav(fundId, session);
        await NavSnapshot.create(
          [
            {
              fundId: oid(fundId),
              nav: nav.nav,
              totalShares: nav.totalShares,
              totalAssets: nav.totalAssets,
              cash: nav.cash,
              investedAtCost: nav.investedAtCost,
              reason: 'DEPOSIT',
              meta: { depositId, type: deposit.type },
            },
          ],
          { session },
        );

        await AuditLog.create(
          [
            {
              fundId: oid(fundId),
              actorId: oid(actorId),
              action: 'DEPOSIT_VERIFY',
              refType: 'DEPOSIT',
              refId: deposit._id,
              before,
              after: {
                status: 'VERIFIED',
                sharesIssued,
                navAtVerify: deposit.type === 'BUY_IN' ? navBefore.nav : 0,
                nav: nav.nav,
              },
            },
          ],
          { session },
        );

        result = {
          depositId,
          status: 'VERIFIED',
          sharesIssued,
          navAtVerify: deposit.type === 'BUY_IN' ? navBefore.nav : 0,
          nav: nav.nav,
        };
      });

      if (depositorUserId) {
        void notifyUser(depositorUserId, {
          type: 'DEPOSIT_VERIFIED',
          title: 'Deposit verified',
          body: `Your deposit of ৳${Math.round(depositAmountPaisa / 100)} has been approved.`,
          fundId,
        });
      }
      return result!;
    } finally {
      await session.endSession();
    }
  });
}

export async function rejectDeposit(actorId: string, fundId: string, depositId: string, input: RejectDepositInput) {
  const deposit = await Deposit.findOne({ _id: depositId, fundId });
  if (!deposit) throw new ApiError(404, 'NOT_FOUND', 'deposit not found');
  if (deposit.status !== 'PENDING') throw new ApiError(409, 'STATE_CONFLICT', 'deposit already decided');

  const before = { status: deposit.status };
  const updated = await Deposit.updateOne(
    { _id: deposit._id, status: 'PENDING' },
    { $set: { status: 'REJECTED', rejectedBy: oid(actorId), reason: input.reason, decidedAt: new Date() } },
  );
  if (updated.matchedCount === 0) throw new ApiError(409, 'STATE_CONFLICT', 'deposit already decided');

  await AuditLog.create({
    fundId: oid(fundId),
    actorId: oid(actorId),
    action: 'DEPOSIT_REJECT',
    refType: 'DEPOSIT',
    refId: deposit._id,
    before,
    after: { status: 'REJECTED', reason: input.reason },
  });

  const membership = await Membership.findById(deposit.membershipId).lean();
  if (membership) {
    void notifyUser(String(membership.userId), {
      type: 'DEPOSIT_REJECTED',
      title: 'Deposit rejected',
      body: input.reason ?? 'Your deposit could not be verified.',
      fundId,
    });
  }

  return { depositId, status: 'REJECTED' as DepositStatus };
}
