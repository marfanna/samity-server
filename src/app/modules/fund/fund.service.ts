import mongoose, { Types } from 'mongoose';
import { Fund } from './fund.model';
import { Membership } from '../membership/membership.model';
import { Deposit } from '../deposit/deposit.model';
import { Investment } from '../investment/investment.model';
import { User } from '../user/user.model';
import { getMembers } from '../membership/membership.service';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { AuditLog } from '../audit/auditLog.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { ApiError } from '../../../utils/ApiError';
import type { CreateFundInput } from './fund.validation';

export interface CreateFundResult {
  fundId: string;
  membershipId: string;
  nav: number;
}

/**
 * Create a fund. The caller becomes admin. If `initialShares > 0`, the admin's founding
 * capital (shares × faceValue) is recorded in the ledger as the fund's opening event —
 * keeping shares/cash derivable from the ledger. NAV opens at face value.
 */
export async function createFund(userId: string, input: CreateFundInput): Promise<CreateFundResult> {
  // Resolve an optional successor: explicit id wins, else look up by phone (may be unregistered).
  let successorUserId: Types.ObjectId | undefined;
  if (input.successorUserId) {
    successorUserId = new Types.ObjectId(input.successorUserId);
  } else if (input.successorPhone) {
    const successor = await User.findOne({ phone: input.successorPhone, status: 'ACTIVE' }).lean();
    if (successor) successorUserId = successor._id;
  }

  const session = await mongoose.startSession();
  try {
    let result!: CreateFundResult;

    await session.withTransaction(async () => {
      const [fund] = await Fund.create(
        [
          {
            name: input.name,
            faceValue: input.faceValue,
            policy: input.policy,
            createdBy: new Types.ObjectId(userId),
            ...(successorUserId ? { successorUserId } : {}),
          },
        ],
        { session },
      );

      const [membership] = await Membership.create(
        [
          {
            userId: new Types.ObjectId(userId),
            fundId: fund!._id,
            role: 'admin',
            status: 'ACTIVE',
            shares: input.initialShares,
            joinNav: input.faceValue,
            joinCycle: 0,
            paidThroughCycle: 0,
          },
        ],
        { session },
      );

      if (input.initialShares > 0) {
        // Founding capitalization: the admin's seed capital is modelled as a FOUNDING buy-in
        // deposit that is verified at creation (the creator attests their own opening contribution —
        // the only point where self-verification is allowed, since no other member exists yet).
        // Recording a Deposit keeps the invariant "every cash event references a deposit" intact;
        // the ledger entries reference it, so shares/cash stay derivable and auditable.
        const amount = input.initialShares * input.faceValue;
        const [deposit] = await Deposit.create(
          [
            {
              fundId: fund!._id,
              membershipId: membership!._id,
              type: 'BUY_IN',
              amount,
              sharesRequested: input.initialShares,
              sharesIssued: input.initialShares,
              navAtSubmit: input.faceValue,
              navAtVerify: input.faceValue,
              screenshotUrl: 'FOUNDING',
              status: 'VERIFIED',
              verifiedBy: new Types.ObjectId(userId),
              decidedAt: new Date(),
              note: 'Founding capital (fund creation)',
            },
          ],
          { session },
        );

        await appendLedger(
          {
            fundId: fund!._id,
            kind: 'CASH_IN',
            amount,
            membershipId: membership!._id,
            refType: 'DEPOSIT',
            refId: deposit!._id,
            createdBy: userId,
          },
          session,
        );
        await appendLedger(
          {
            fundId: fund!._id,
            kind: 'SHARES_ISSUED',
            shares: input.initialShares,
            membershipId: membership!._id,
            refType: 'DEPOSIT',
            refId: deposit!._id,
            createdBy: userId,
          },
          session,
        );
      }

      const nav = await computeNav(fund!._id, session);
      await NavSnapshot.create(
        [
          {
            fundId: fund!._id,
            nav: nav.nav,
            totalShares: nav.totalShares,
            totalAssets: nav.totalAssets,
            cash: nav.cash,
            investedAtCost: nav.investedAtCost,
            reason: 'INIT',
          },
        ],
        { session },
      );

      await AuditLog.create(
        [
          {
            fundId: fund!._id,
            actorId: new Types.ObjectId(userId),
            action: 'FUND_CREATE',
            refType: 'FUND',
            refId: fund!._id,
            after: { name: input.name, faceValue: input.faceValue, initialShares: input.initialShares },
          },
        ],
        { session },
      );

      result = { fundId: String(fund!._id), membershipId: String(membership!._id), nav: nav.nav };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

/** Current derived NAV for a fund (member+). */
export async function getNav(fundId: string) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');
  const nav = await computeNav(fundId);
  return { ...nav, at: new Date().toISOString() };
}

/**
 * Fund detail for the overview screen: fund-level investments (visible to all members)
 * + the member roster (names + roles only — no per-member amounts).
 */
export async function getOverview(fundId: string) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');

  const investments = await Investment.find({ fundId }).sort({ createdAt: -1 }).lean();
  const members = await getMembers(fundId);

  return {
    investments: investments.map((inv) => ({
      id: String(inv._id),
      destination: inv.destination,
      amountCost: inv.amountCost,
      state: inv.state,
      actualReturn: inv.state === 'RETURNED' || inv.state === 'SETTLED' ? inv.actualReturn : null,
    })),
    members,
  };
}
