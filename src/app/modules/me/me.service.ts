import { User } from '../user/user.model';
import { Membership } from '../membership/membership.model';
import { Fund } from '../fund/fund.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { NavSnapshot } from '../nav/navSnapshot.model';
import { RefreshToken } from '../_infra/refreshToken.model';
import { hashPassword, verifyPassword } from '../../../shared/password';
import { computeNav } from '../../../shared/nav';
import { memberValue } from '../../../shared/economics';
import { cyclesBehind } from '../../../shared/cycle';
import { ApiError } from '../../../utils/ApiError';
import type { UpdateMeInput } from './me.validation';

export async function getMe(userId: string) {
  const user = await User.findOne({ _id: userId, status: 'ACTIVE' }).lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'account not found');
  return { id: String(user._id), phone: user.phone, name: user.name, locale: user.locale };
}

export async function updateMe(userId: string, input: UpdateMeInput) {
  const user = await User.findOne({ _id: userId, status: 'ACTIVE' });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'account not found');

  if (input.name !== undefined) user.name = input.name;
  if (input.locale !== undefined) user.locale = input.locale;
  if (input.password !== undefined) user.passwordHash = await hashPassword(input.password);
  await user.save();

  // A password change is a "was this account compromised?" moment — kill every other
  // session so a leaked credential can't keep riding an old refresh token. Matches
  // resetPassword's behavior (see auth.service.ts).
  if (input.password !== undefined) {
    await RefreshToken.deleteMany({ userId: user._id });
  }

  return { id: String(user._id), phone: user.phone, name: user.name, locale: user.locale };
}

/**
 * Soft-delete the account (status → DELETED) and kill all sessions.
 * Fund records/ledger are retained for audit. Blocked while the user is the admin of any
 * ACTIVE fund — they must transfer ownership or close those funds first.
 * Requires the account password — an irreversible action must not be one accidental tap away.
 */
export async function deleteAccount(userId: string, password: string) {
  const user = await User.findOne({ _id: userId, status: 'ACTIVE' });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'account not found');
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'incorrect password');
  }

  const adminFunds = await Membership.find({ userId, role: 'admin', status: { $ne: 'EXITED' } }).lean();
  if (adminFunds.length > 0) {
    const activeAdmin = await Fund.countDocuments({
      _id: { $in: adminFunds.map((m) => m.fundId) },
      status: 'ACTIVE',
    });
    if (activeAdmin > 0) {
      throw new ApiError(
        409,
        'ADMIN_OF_ACTIVE_FUND',
        'transfer ownership or close your funds before deleting your account',
      );
    }
  }

  user.status = 'DELETED';
  user.fcmTokens = [];
  // Free the phone number for future re-registration — `phone` has a global unique index
  // with no exception for DELETED, so leaving it as-is permanently blocks that number from
  // ever registering again (the tombstone suffix keeps it readable for support/audit).
  user.phone = `${user.phone}#deleted-${user._id}`;
  await user.save();
  await RefreshToken.deleteMany({ userId: user._id });

  return { deleted: true };
}

const FCM_TOKEN_CAP = 10; // avoid unbounded growth from old/replaced devices

/** Register a device FCM token (add if not already present, max FCM_TOKEN_CAP per user). */
export async function registerFcmToken(userId: string, token: string) {
  await User.updateOne(
    { _id: userId },
    { $addToSet: { fcmTokens: token } },
  );
  await User.updateOne(
    { _id: userId, $expr: { $gt: [{ $size: '$fcmTokens' }, FCM_TOKEN_CAP] } },
    [{ $set: { fcmTokens: { $slice: ['$fcmTokens', -FCM_TOKEN_CAP] } } }],
  );
}

/** Remove a FCM token (logout or token refresh). */
export async function deregisterFcmToken(userId: string, token: string) {
  await User.updateOne({ _id: userId }, { $pull: { fcmTokens: token } });
}

/** All memberships for the user, joined with fund headline fields (closed funds included). */
export async function getMyFunds(userId: string) {
  const memberships = await Membership.find({ userId, status: { $ne: 'EXITED' } }).lean();
  const fundIds = memberships.map((m) => m.fundId);
  const funds = await Fund.find({ _id: { $in: fundIds } }).lean();
  const fundById = new Map(funds.map((f) => [String(f._id), f]));

  return Promise.all(
    memberships.map(async (m) => {
      const fund = fundById.get(String(m.fundId));
      const [nav, memberCount, contributedAgg, fundContribAgg] = await Promise.all([
        computeNav(m.fundId),
        Membership.countDocuments({ fundId: m.fundId, status: { $ne: 'EXITED' } }),
        LedgerEntry.aggregate([
          { $match: { fundId: m.fundId, membershipId: m._id, kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        LedgerEntry.aggregate([
          { $match: { fundId: m.fundId, kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);

      const behindCycles =
        fund && m.status === 'ACTIVE' && m.shares > 0
          ? cyclesBehind(
              fund.policy.startDate,
              fund.policy.cycleUnit,
              m.paidThroughCycle,
              new Date(),
              fund.policy.collectionWeekday,
            )
          : 0;

      const contributedPaisa = (contributedAgg[0] as { total?: number } | undefined)?.total ?? 0;
      // Value = my contributed principal + my share of fund profit, split by money paid
      // (paid-up members only). Profit = total assets − total contributed. Zero until invested.
      const fundContributed = (fundContribAgg[0] as { total?: number } | undefined)?.total ?? 0;
      const profit = nav.totalAssets - fundContributed;
      const myProfitPaisa =
        fundContributed > 0 ? Math.round((contributedPaisa / fundContributed) * profit) : 0;
      const valuePaisa = contributedPaisa + myProfitPaisa;

      return {
        fundId: String(m.fundId),
        membershipId: String(m._id),
        name: fund?.name ?? '',
        cycleUnit: fund?.policy.cycleUnit ?? 'WEEKLY',
        faceValue: fund?.faceValue ?? 0,
        nav: nav.nav,
        totalShares: nav.totalShares,
        memberCount,
        myShares: m.shares,
        contributedPaisa,
        valuePaisa,
        profitPaisa: myProfitPaisa,
        poolPaisa: nav.totalAssets,
        fundProfitPaisa: profit,
        role: m.role,
        status: m.status,
        fundStatus: fund?.status ?? 'ACTIVE',
        behindCycles,
        bankDetails: fund?.bankDetails ?? null,
        startDate: fund?.policy.startDate ?? null,
        visibility: fund?.policy.visibility ?? 'INVITE_ONLY',
        shareChange: fund?.policy.shareChange ?? 'FIXED',
        nonPayment: fund?.policy.nonPayment ?? 'TRACK_ONLY',
        joinLock: fund?.policy.joinLock ?? 'ALLOW',
      };
    }),
  );
}

/**
 * My total portfolio value (sum of memberValue across all my funds) over time, for the
 * dashboard trend chart. Resampled at every NavSnapshot across any of my funds — each point
 * carries forward the latest known value for funds that didn't change at that instant.
 */
export async function getPortfolioHistory(userId: string, limit = 30) {
  const memberships = await Membership.find({ userId }).lean();
  if (memberships.length === 0) return [];

  const fundIds = memberships.map((m) => m.fundId);
  const membershipIdByFund = new Map(memberships.map((m) => [String(m.fundId), String(m._id)]));

  const [snapshots, contributionEntries] = await Promise.all([
    NavSnapshot.find({ fundId: { $in: fundIds } }, { fundId: 1, totalAssets: 1, at: 1 })
      .sort({ at: 1 })
      .lean(),
    LedgerEntry.find(
      { fundId: { $in: fundIds }, kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } },
      { fundId: 1, membershipId: 1, amount: 1, at: 1 },
    )
      .sort({ at: 1 })
      .lean(),
  ]);
  if (snapshots.length === 0) return [];

  const fundTotalContributed = new Map<string, number>();
  const myContributed = new Map<string, number>();
  const latestFundValue = new Map<string, number>();
  let entryIdx = 0;

  const points: { at: string; value: number }[] = [];
  for (const snap of snapshots) {
    while (entryIdx < contributionEntries.length && (contributionEntries[entryIdx]?.at.getTime() ?? Infinity) <= snap.at.getTime()) {
      const e = contributionEntries[entryIdx]!;
      const fid = String(e.fundId);
      fundTotalContributed.set(fid, (fundTotalContributed.get(fid) ?? 0) + e.amount);
      if (e.membershipId && String(e.membershipId) === membershipIdByFund.get(fid)) {
        myContributed.set(fid, (myContributed.get(fid) ?? 0) + e.amount);
      }
      entryIdx++;
    }

    const fid = String(snap.fundId);
    const { value } = memberValue(myContributed.get(fid) ?? 0, fundTotalContributed.get(fid) ?? 0, snap.totalAssets);
    latestFundValue.set(fid, value);

    let total = 0;
    for (const v of latestFundValue.values()) total += v;
    points.push({ at: snap.at.toISOString(), value: total });
  }

  return points.length > limit ? points.slice(points.length - limit) : points;
}
