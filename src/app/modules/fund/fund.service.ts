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
import { currentCycleIndex } from '../../../shared/cycle';
import { ApiError } from '../../../utils/ApiError';
import type { CreateFundInput, ImportFundInput, UpdateFundInput } from './fund.validation';

export interface CreateFundResult {
  fundId: string;
  membershipId: string;
  nav: number;
}

export interface ImportFundResult extends CreateFundResult {
  memberCount: number;
  invitedCount: number; // placeholder ghosts created (members not yet on the app)
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

/**
 * Import an already-running samiti as an opening balance (Phase 15).
 *
 * No historical replay — we seed today's state so the derived engine is correct from day one:
 *  - shares per member  → SHARES_ISSUED (totalShares)
 *  - liquid cash on hand → OPENING_CASH (NAV cash; net of money already invested)
 *  - active investments  → Investment docs (investedAtCost) — NO CASH_OUT_INVEST
 *  - dues arrears        → paidThroughCycle = currentCycle − cyclesBehind (per member)
 *  - cost basis          → OPENING_CONTRIBUTION (display-only) = paidThroughCycle × shares × faceValue
 *
 * Roster members not yet on the app become INVITED ghost users; they claim by registering
 * with that phone (auth.verifyOtp upgrades the ghost → ACTIVE, inheriting this membership).
 */
export async function importFund(userId: string, input: ImportFundInput): Promise<ImportFundResult> {
  const caller = await User.findById(userId).lean();
  if (!caller) throw new ApiError(404, 'NOT_FOUND', 'account not found');

  // Resolve optional successor by phone (may be unregistered → ignored).
  let successorUserId: Types.ObjectId | undefined;
  if (input.successorPhone) {
    const successor = await User.findOne({ phone: input.successorPhone, status: 'ACTIVE' }).lean();
    if (successor) successorUserId = successor._id;
  }

  const startDate = input.policy.startDate;
  const cycleUnit = input.policy.cycleUnit;
  const currentCycle = currentCycleIndex(startDate, cycleUnit);
  const paidThrough = (cyclesBehindNow: number) => Math.max(0, currentCycle - cyclesBehindNow);

  // Dedupe roster by phone, drop anyone matching the caller (admin is added separately).
  const seenPhones = new Set<string>([caller.phone]);
  const roster = input.members.filter((m) => {
    if (seenPhones.has(m.phone)) return false;
    seenPhones.add(m.phone);
    return true;
  });

  const session = await mongoose.startSession();
  try {
    let result!: ImportFundResult;

    await session.withTransaction(async () => {
      const genesisAt = new Date();
      const [fund] = await Fund.create(
        [
          {
            name: input.name,
            faceValue: input.faceValue,
            policy: input.policy,
            createdBy: new Types.ObjectId(userId),
            originType: 'IMPORTED',
            genesisAt,
            ...(successorUserId ? { successorUserId } : {}),
          },
        ],
        { session },
      );
      const fundId = fund!._id;

      // Seed one member: SHARES_ISSUED + OPENING_CONTRIBUTION (cost basis at genesis).
      const seedMember = async (membershipId: Types.ObjectId, shares: number, paidThroughCycle: number) => {
        await appendLedger(
          { fundId, kind: 'SHARES_ISSUED', shares, membershipId, refType: 'GENESIS', createdBy: userId },
          session,
        );
        const contribution = paidThroughCycle * shares * input.faceValue;
        if (contribution > 0) {
          await appendLedger(
            {
              fundId,
              kind: 'OPENING_CONTRIBUTION',
              amount: contribution,
              membershipId,
              refType: 'GENESIS',
              createdBy: userId,
            },
            session,
          );
        }
      };

      // Admin membership (the caller).
      const adminPaidThrough = paidThrough(input.adminCyclesBehind);
      const [adminMembership] = await Membership.create(
        [
          {
            userId: new Types.ObjectId(userId),
            fundId,
            role: 'admin',
            status: 'ACTIVE',
            shares: input.adminShares,
            joinNav: input.faceValue,
            joinCycle: 0,
            paidThroughCycle: adminPaidThrough,
          },
        ],
        { session },
      );
      await seedMember(adminMembership!._id, input.adminShares, adminPaidThrough);

      // Roster members: link to an existing ACTIVE account, else create an INVITED ghost.
      let invitedCount = 0;
      for (const m of roster) {
        let memberUser = await User.findOne({
          phone: m.phone,
          status: { $in: ['ACTIVE', 'INVITED'] },
        }).session(session);

        if (!memberUser) {
          const [ghost] = await User.create(
            [{ phone: m.phone, name: m.name, passwordHash: '!', status: 'INVITED' }],
            { session },
          );
          memberUser = ghost!;
          invitedCount += 1;
        } else if (memberUser.status === 'INVITED') {
          invitedCount += 1;
        }

        const memberPaidThrough = paidThrough(m.cyclesBehind);
        const [membership] = await Membership.create(
          [
            {
              userId: memberUser._id,
              fundId,
              role: 'member',
              status: 'ACTIVE',
              shares: m.shares,
              joinNav: input.faceValue,
              joinCycle: 0,
              paidThroughCycle: memberPaidThrough,
            },
          ],
          { session },
        );
        await seedMember(membership!._id, m.shares, memberPaidThrough);
      }

      // Fund liquid cash on hand (already net of money out in investments).
      if (input.openingCashPaisa > 0) {
        await appendLedger(
          {
            fundId,
            kind: 'OPENING_CASH',
            amount: input.openingCashPaisa,
            refType: 'GENESIS',
            createdBy: userId,
          },
          session,
        );
      }

      // Active investments — counted via investedAtCost; no CASH_OUT_INVEST (cash already excludes them).
      if (input.investments.length > 0) {
        await Investment.create(
          input.investments.map((inv) => ({
            fundId,
            amountCost: inv.amountCost,
            destination: inv.destination,
            expectedReturn: inv.expectedReturn,
            ...(inv.expectedDate ? { expectedDate: inv.expectedDate } : {}),
            state: 'ACTIVE',
            recordedBy: new Types.ObjectId(userId),
          })),
          { session },
        );
      }

      const nav = await computeNav(fundId, session);
      await NavSnapshot.create(
        [
          {
            fundId,
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
            fundId,
            actorId: new Types.ObjectId(userId),
            action: 'FUND_IMPORT',
            refType: 'FUND',
            refId: fundId,
            after: {
              name: input.name,
              faceValue: input.faceValue,
              startDate,
              currentCycle,
              memberCount: roster.length + 1,
              invitedCount,
              openingCashPaisa: input.openingCashPaisa,
              investments: input.investments.length,
              nav: nav.nav,
            },
          },
        ],
        { session },
      );

      result = {
        fundId: String(fundId),
        membershipId: String(adminMembership!._id),
        nav: nav.nav,
        memberCount: roster.length + 1,
        invitedCount,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

/** Update editable fund settings (admin only). cycleUnit + startDate are immutable. */
export async function updateFundSettings(fundId: string, actorId: string, input: UpdateFundInput) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');
  if (fund.status !== 'ACTIVE') throw new ApiError(409, 'FUND_CLOSED', 'fund is closed');

  const policyPatch: Record<string, unknown> = {};
  const topPatch: Record<string, unknown> = {};

  if (input.name !== undefined) topPatch['name'] = input.name;
  if (input.bankDetails !== undefined) topPatch['bankDetails'] = input.bankDetails;
  if (input.visibility !== undefined) policyPatch['policy.visibility'] = input.visibility;
  if (input.shareChange !== undefined) policyPatch['policy.shareChange'] = input.shareChange;
  if (input.nonPayment !== undefined) policyPatch['policy.nonPayment'] = input.nonPayment;
  if (input.joinLock !== undefined) policyPatch['policy.joinLock'] = input.joinLock;
  if (input.graceCycles !== undefined) policyPatch['policy.graceCycles'] = input.graceCycles;
  if (input.penaltyPaisa !== undefined) policyPatch['policy.penaltyPaisa'] = input.penaltyPaisa;
  if (input.suspendAfterMisses !== undefined) policyPatch['policy.suspendAfterMisses'] = input.suspendAfterMisses;
  if (input.inactivityDays !== undefined) policyPatch['policy.inactivityDays'] = input.inactivityDays;

  const patch = { ...topPatch, ...policyPatch };
  if (Object.keys(patch).length === 0) return { updated: false };

  await Fund.updateOne({ _id: fundId }, { $set: patch });

  await AuditLog.create([{
    fundId: new Types.ObjectId(fundId),
    actorId: new Types.ObjectId(actorId),
    action: 'FUND_SETTINGS_UPDATE',
    refType: 'FUND',
    refId: new Types.ObjectId(fundId),
    after: patch,
  }]);

  return { updated: true };
}

/** Close a fund (admin only). Requires no active investments. Irreversible. */
export async function closeFund(fundId: string, actorId: string) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');
  if (fund.status === 'CLOSED') throw new ApiError(409, 'ALREADY_CLOSED', 'fund is already closed');

  const activeInvestments = await Investment.countDocuments({ fundId, state: 'ACTIVE' });
  if (activeInvestments > 0) {
    throw new ApiError(409, 'ACTIVE_INVESTMENTS', 'close all active investments before closing the fund');
  }

  await Fund.updateOne({ _id: fundId }, { $set: { status: 'CLOSED' } });

  await AuditLog.create([{
    fundId: new Types.ObjectId(fundId),
    actorId: new Types.ObjectId(actorId),
    action: 'FUND_CLOSE',
    refType: 'FUND',
    refId: new Types.ObjectId(fundId),
    after: { status: 'CLOSED' },
  }]);

  return { closed: true };
}

/** Current derived NAV for a fund (member+). */
export async function getNav(fundId: string) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');
  const nav = await computeNav(fundId);
  return { ...nav, at: new Date().toISOString() };
}

/** NAV history for the chart. Returns up to `limit` snapshots oldest→newest. */
export async function getNavHistory(fundId: string, limit = 30) {
  const fund = await Fund.findById(fundId).lean();
  if (!fund) throw new ApiError(404, 'NOT_FOUND', 'fund not found');

  const snapshots = await NavSnapshot.find({ fundId })
    .sort({ at: -1 })
    .limit(limit)
    .lean();

  // Reverse so chart renders oldest-first (left→right)
  return snapshots.reverse().map((s) => ({ nav: s.nav, at: s.at.toISOString() }));
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
