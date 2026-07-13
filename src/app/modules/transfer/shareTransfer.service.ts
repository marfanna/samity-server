import mongoose, { Types } from 'mongoose';
import cron from 'node-cron';
import { ShareTransfer } from './shareTransfer.model';
import { Membership } from '../membership/membership.model';
import { User } from '../user/user.model';
import { AuditLog } from '../audit/auditLog.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { appendLedger } from '../../../shared/ledger';
import { computeNav } from '../../../shared/nav';
import { memberValue, fundContributed } from '../../../shared/economics';
import { withFundLock } from '../../../shared/fundLock';
import { notifyUser, notifyFundManagers } from '../../../shared/notify';
import { ApiError } from '../../../utils/ApiError';
import type { InitiateTransferInput } from './shareTransfer.validation';

/**
 * Seller's fair reference price for N shares = their own contributed principal + profit share
 * (economics.memberValue), NOT fund-wide schedule NAV — so a member behind on dues doesn't get
 * priced as if they'd paid on schedule. Informational only; agreedAmount is what's enforced.
 */
async function sellerReferencePrice(fundId: string, sellerMembershipId: string, shares: number): Promise<number> {
  const [contributedAgg, totalContributed, nav, seller] = await Promise.all([
    LedgerEntry.aggregate<{ total: number }>([
      {
        $match: {
          fundId: new Types.ObjectId(fundId),
          membershipId: new Types.ObjectId(sellerMembershipId),
          kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    fundContributed(fundId),
    computeNav(fundId),
    Membership.findById(sellerMembershipId, { shares: 1 }).lean(),
  ]);

  const contributed = contributedAgg[0]?.total ?? 0;
  const { value } = memberValue(contributed, totalContributed, nav.totalAssets);
  const sellerShares = seller?.shares ?? 0;
  if (sellerShares <= 0) return 0;
  return Math.round((value / sellerShares) * shares);
}

const TRANSFER_EXPIRY_MS = 72 * 60 * 60 * 1000; // 72 hours

/** Seller initiates a share transfer. sellerConfirmed = true at creation. */
export async function initiateTransfer(
  actorMembershipId: string,
  fundId: string,
  input: InitiateTransferInput,
) {
  const sellerMembership = await Membership.findOne({ _id: actorMembershipId, fundId }).lean();
  if (!sellerMembership || sellerMembership.status !== 'ACTIVE') {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'must be an active member to transfer shares');
  }
  if (sellerMembership.shares < input.shares) {
    throw new ApiError(400, 'VALIDATION', `you only hold ${sellerMembership.shares} shares`);
  }

  // Resolve buyer — may not be a member yet (PENDING_BUYIN is fine; new joiner must join first)
  const buyerUser = await User.findOne({ phone: input.toPhone, status: 'ACTIVE' }).lean();
  const buyerMembership = buyerUser
    ? await Membership.findOne({ fundId, userId: buyerUser._id, status: { $ne: 'EXITED' } }).lean()
    : null;

  const navAtTransfer = await sellerReferencePrice(fundId, actorMembershipId, input.shares);

  const transfer = await ShareTransfer.create({
    fundId: new Types.ObjectId(fundId),
    fromMembershipId: new Types.ObjectId(actorMembershipId),
    toPhone: input.toPhone,
    ...(buyerUser ? { toUserId: buyerUser._id } : {}),
    ...(buyerMembership ? { toMembershipId: buyerMembership._id } : {}),
    shares: input.shares,
    navAtTransfer,
    agreedAmount: input.agreedAmount,
    screenshotUrl: input.screenshotUrl,
    sellerConfirmed: true,
    buyerConfirmed: false,
    state: 'INITIATED',
    expiresAt: new Date(Date.now() + TRANSFER_EXPIRY_MS),
  });

  if (buyerUser) {
    void notifyUser(buyerUser._id, {
      type: 'TRANSFER_PENDING_CONFIRM',
      title: 'Share transfer needs your confirmation',
      body: `${input.shares} share${input.shares !== 1 ? 's' : ''} for ৳${Math.round(input.agreedAmount / 100)} — confirm you've paid.`,
      fundId,
    });
  }

  return { transferId: String(transfer._id), state: transfer.state };
}

/**
 * Buyer confirms they have paid the seller offline.
 * Caller must be the buyer identified by toPhone or toMembershipId.
 */
export async function buyerConfirmTransfer(userId: string, fundId: string, transferId: string) {
  const transfer = await ShareTransfer.findOne({ _id: transferId, fundId });
  if (!transfer) throw new ApiError(404, 'NOT_FOUND', 'transfer not found');
  if (transfer.state !== 'INITIATED') {
    throw new ApiError(409, 'STATE_CONFLICT', `transfer is already ${transfer.state}`);
  }

  // Verify caller is the buyer
  const callerUser = await User.findById(userId, { phone: 1 }).lean();
  const byPhone = callerUser?.phone === transfer.toPhone;
  const byMembership = transfer.toMembershipId
    ? await Membership.exists({ _id: transfer.toMembershipId, userId })
    : false;

  if (!byPhone && !byMembership) {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'only the intended buyer can confirm');
  }

  // Link membership if now known
  if (!transfer.toMembershipId) {
    const buyerMembership = await Membership.findOne({ fundId, userId, status: { $ne: 'EXITED' } }).lean();
    if (buyerMembership) {
      transfer.toMembershipId = buyerMembership._id;
      transfer.toUserId = new Types.ObjectId(userId);
    }
  }

  transfer.buyerConfirmed = true;
  transfer.state = transfer.sellerConfirmed ? 'BOTH_CONFIRMED' : 'INITIATED';
  await transfer.save();

  if (transfer.state === 'BOTH_CONFIRMED') {
    notifyFundManagers(fundId, undefined, {
      type: 'TRANSFER_PENDING_APPROVAL',
      title: 'Share transfer needs approval',
      body: `${transfer.shares} share${transfer.shares !== 1 ? 's' : ''} — both sides confirmed, ready to approve.`,
      fundId,
    });
  }

  return { transferId, state: transfer.state };
}

/**
 * Admin/mod approves a BOTH_CONFIRMED transfer.
 * Atomically: seller.shares -= N (→ EXITED if 0), buyer.shares += N (PENDING_BUYIN → ACTIVE).
 * Appends two SHARES_TRANSFER ledger entries.
 */
export async function approveTransfer(actorId: string, fundId: string, transferId: string) {
  return withFundLock(fundId, async () => {
    const session = await mongoose.startSession();
    try {
      let result: { transferId: string; state: string };
      let sellerUserId: string | undefined;
      let buyerUserId: string | undefined;
      let transferShares = 0;

      await session.withTransaction(async () => {
        const transfer = await ShareTransfer.findOne({ _id: transferId, fundId }).session(session);
        if (!transfer) throw new ApiError(404, 'NOT_FOUND', 'transfer not found');
        if (transfer.state !== 'BOTH_CONFIRMED') {
          throw new ApiError(409, 'STATE_CONFLICT', `transfer must be BOTH_CONFIRMED to approve (is ${transfer.state})`);
        }

        const seller = await Membership.findById(transfer.fromMembershipId).session(session);
        if (!seller) throw new ApiError(404, 'NOT_FOUND', 'seller membership not found');
        if (seller.shares < transfer.shares) {
          throw new ApiError(409, 'STATE_CONFLICT', 'seller no longer holds enough shares');
        }

        // Resolve buyer membership
        let buyer = transfer.toMembershipId
          ? await Membership.findById(transfer.toMembershipId).session(session)
          : null;

        if (!buyer && transfer.toUserId) {
          buyer = await Membership.findOne({ fundId, userId: transfer.toUserId }).session(session);
        }
        if (!buyer && transfer.toPhone) {
          const buyerUser = await User.findOne({ phone: transfer.toPhone }).session(session).lean();
          if (buyerUser) {
            buyer = await Membership.findOne({ fundId, userId: buyerUser._id }).session(session);
          }
        }
        if (!buyer) {
          throw new ApiError(409, 'STATE_CONFLICT', 'buyer must join the fund before transfer can be approved');
        }
        if (buyer.status === 'EXITED' || buyer.status === 'SUSPENDED') {
          throw new ApiError(409, 'STATE_CONFLICT', `buyer membership is ${buyer.status}`);
        }

        // Reassign shares
        seller.shares -= transfer.shares;
        if (seller.shares === 0) seller.status = 'EXITED';
        await seller.save({ session });

        buyer.shares += transfer.shares;
        if (buyer.status === 'PENDING_BUYIN') buyer.status = 'ACTIVE';
        await buyer.save({ session });

        // Ledger: from-member loses shares, to-member gains shares
        await appendLedger({
          fundId: new Types.ObjectId(fundId),
          kind: 'SHARES_TRANSFER',
          shares: -transfer.shares,
          amount: 0,
          fromMembershipId: seller._id,
          toMembershipId: buyer._id,
          membershipId: seller._id,
          refType: 'TRANSFER',
          refId: transfer._id,
          createdBy: actorId,
        }, session);

        await appendLedger({
          fundId: new Types.ObjectId(fundId),
          kind: 'SHARES_TRANSFER',
          shares: transfer.shares,
          amount: 0,
          fromMembershipId: seller._id,
          toMembershipId: buyer._id,
          membershipId: buyer._id,
          refType: 'TRANSFER',
          refId: transfer._id,
          createdBy: actorId,
        }, session);

        sellerUserId = String(seller.userId);
        buyerUserId = String(buyer.userId);
        transferShares = transfer.shares;

        transfer.state = 'APPROVED';
        transfer.approvedBy = new Types.ObjectId(actorId);
        await transfer.save({ session });

        await AuditLog.create([{
          fundId: new Types.ObjectId(fundId),
          actorId: new Types.ObjectId(actorId),
          action: 'TRANSFER_APPROVE',
          refType: 'TRANSFER',
          refId: transfer._id,
          after: {
            shares: transfer.shares,
            fromMembershipId: String(seller._id),
            toMembershipId: String(buyer._id),
          },
        }], { session });

        result = { transferId, state: 'APPROVED' };
      });

      const notifyPayload = {
        type: 'TRANSFER_APPROVED',
        title: 'Share transfer approved',
        body: `${transferShares} share${transferShares !== 1 ? 's' : ''} transferred successfully.`,
        fundId,
      };
      if (sellerUserId) void notifyUser(sellerUserId, notifyPayload);
      if (buyerUserId && buyerUserId !== sellerUserId) void notifyUser(buyerUserId, notifyPayload);

      return result!;
    } finally {
      await session.endSession();
    }
  });
}

/** Cancel a transfer (seller or admin/mod). Allowed in INITIATED or BOTH_CONFIRMED states. */
export async function cancelTransfer(
  actorMembershipId: string,
  actorRole: string,
  fundId: string,
  transferId: string,
) {
  const transfer = await ShareTransfer.findOne({ _id: transferId, fundId });
  if (!transfer) throw new ApiError(404, 'NOT_FOUND', 'transfer not found');
  if (transfer.state === 'APPROVED' || transfer.state === 'CANCELLED' || transfer.state === 'EXPIRED') {
    throw new ApiError(409, 'STATE_CONFLICT', `cannot cancel a ${transfer.state} transfer`);
  }

  const isSeller = String(transfer.fromMembershipId) === actorMembershipId;
  const isManager = actorRole === 'admin' || actorRole === 'moderator';
  if (!isSeller && !isManager) {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'only the seller or a fund manager can cancel');
  }

  transfer.state = 'CANCELLED';
  await transfer.save();

  return { transferId, state: 'CANCELLED' };
}

/**
 * Auto-cancel transfers whose 72h window lapsed without both sides confirming + approval.
 * `expiresAt` was written at `initiateTransfer` but nothing ever read it — this is that sweep.
 * CAS per-document (state must still match what we read) so a concurrent confirm/approve/cancel
 * always wins over the sweep instead of racing it.
 */
export async function expireStaleTransfers(now: Date = new Date()): Promise<void> {
  const stale = await ShareTransfer.find({
    state: { $in: ['INITIATED', 'BOTH_CONFIRMED'] },
    expiresAt: { $lt: now },
  }).lean();

  for (const t of stale) {
    const updated = await ShareTransfer.updateOne(
      { _id: t._id, state: t.state },
      { $set: { state: 'EXPIRED' } },
    );
    if (updated.modifiedCount === 0) continue; // raced with a confirm/approve/cancel — leave it

    const seller = await Membership.findById(t.fromMembershipId, { userId: 1 }).lean();
    if (seller) {
      void notifyUser(seller.userId, {
        type: 'TRANSFER_EXPIRED',
        title: 'Share transfer expired',
        body: `Your transfer of ${t.shares} share${t.shares !== 1 ? 's' : ''} expired — it wasn't confirmed and approved in time.`,
        fundId: String(t.fundId),
      });
    }
  }
}

/** Fires every 15 minutes — transfers have a 72h window, so this is frequent enough. */
export function startTransferExpiryCron(): void {
  cron.schedule('*/15 * * * *', async () => {
    try {
      await expireStaleTransfers();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[transferExpiry] sweep failed:', err instanceof Error ? err.message : err);
    }
  });
}

/** My transfers for a fund (both as seller and as buyer). */
export async function listMyTransfers(membershipId: string, fundId: string) {
  const transfers = await ShareTransfer.find({
    fundId,
    $or: [{ fromMembershipId: membershipId }, { toMembershipId: membershipId }],
  })
    .sort({ createdAt: -1 })
    .lean();

  return transfers.map((t) => ({
    transferId: String(t._id),
    shares: t.shares,
    navAtTransfer: t.navAtTransfer,
    agreedAmount: t.agreedAmount,
    state: t.state,
    toPhone: t.toPhone,
    direction: String(t.fromMembershipId) === membershipId ? 'OUTGOING' : 'INCOMING',
    createdAt: t.createdAt,
  }));
}

/** Pending approvals (BOTH_CONFIRMED) — for admin/mod queue. */
export async function listPendingApprovals(fundId: string) {
  const transfers = await ShareTransfer.find({ fundId, state: 'BOTH_CONFIRMED' })
    .sort({ createdAt: -1 })
    .lean();

  const membershipIds = [
    ...transfers.map((t) => t.fromMembershipId),
    ...transfers.filter((t) => t.toMembershipId).map((t) => t.toMembershipId!),
  ];
  const memberships = await Membership.find({ _id: { $in: membershipIds } }, { userId: 1 }).lean();
  const userIds = memberships.map((m) => m.userId);
  const users = await User.find({ _id: { $in: userIds } }, { name: 1 }).lean();
  const nameByUserId = new Map(users.map((u) => [String(u._id), u.name]));
  const userIdByMemberId = new Map(memberships.map((m) => [String(m._id), String(m.userId)]));

  return transfers.map((t) => {
    const sellerUserId = userIdByMemberId.get(String(t.fromMembershipId));
    const buyerUserId = t.toMembershipId ? userIdByMemberId.get(String(t.toMembershipId)) : undefined;
    return {
      transferId: String(t._id),
      shares: t.shares,
      navAtTransfer: t.navAtTransfer,
      agreedAmount: t.agreedAmount,
      state: t.state,
      sellerName: sellerUserId ? nameByUserId.get(sellerUserId) ?? '—' : '—',
      buyerName: buyerUserId ? nameByUserId.get(buyerUserId) ?? '—' : t.toPhone ?? '—',
      toPhone: t.toPhone,
      createdAt: t.createdAt,
    };
  });
}
