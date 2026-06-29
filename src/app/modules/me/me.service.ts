import { User } from '../user/user.model';
import { Membership } from '../membership/membership.model';
import { Fund } from '../fund/fund.model';
import { LedgerEntry } from '../ledger/ledgerEntry.model';
import { hashPassword } from '../../../shared/password';
import { computeNav } from '../../../shared/nav';
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

  return { id: String(user._id), phone: user.phone, name: user.name, locale: user.locale };
}

/** Register a device FCM token (add if not already present, max 10 per user). */
export async function registerFcmToken(userId: string, token: string) {
  await User.updateOne(
    { _id: userId },
    { $addToSet: { fcmTokens: token } },
  );
  // Cap at 10 to avoid unbounded growth (old device tokens)
  await User.updateOne(
    { _id: userId, $expr: { $gt: [{ $size: '$fcmTokens' }, 10] } },
    [{ $set: { fcmTokens: { $slice: ['$fcmTokens', -10] } } }],
  );
}

/** Remove a FCM token (logout or token refresh). */
export async function deregisterFcmToken(userId: string, token: string) {
  await User.updateOne({ _id: userId }, { $pull: { fcmTokens: token } });
}

/** All memberships for the user, joined with fund headline fields. */
export async function getMyFunds(userId: string) {
  const memberships = await Membership.find({ userId, status: { $ne: 'EXITED' } }).lean();
  const fundIds = memberships.map((m) => m.fundId);
  const funds = await Fund.find({ _id: { $in: fundIds } }).lean();
  const fundById = new Map(funds.map((f) => [String(f._id), f]));

  return Promise.all(
    memberships.map(async (m) => {
      const fund = fundById.get(String(m.fundId));
      const [nav, memberCount, contributedAgg] = await Promise.all([
        computeNav(m.fundId),
        Membership.countDocuments({ fundId: m.fundId, status: { $ne: 'EXITED' } }),
        LedgerEntry.aggregate([
          { $match: { fundId: m.fundId, membershipId: m._id, kind: { $in: ['CASH_IN', 'OPENING_CONTRIBUTION'] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);

      const behindCycles =
        fund && m.status === 'ACTIVE' && m.shares > 0
          ? cyclesBehind(fund.policy.startDate, fund.policy.cycleUnit, m.paidThroughCycle)
          : 0;

      const contributedPaisa = (contributedAgg[0] as { total?: number } | undefined)?.total ?? 0;

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
        role: m.role,
        status: m.status,
        behindCycles,
        startDate: fund?.policy.startDate ?? null,
        visibility: fund?.policy.visibility ?? 'INVITE_ONLY',
        shareChange: fund?.policy.shareChange ?? 'FIXED',
        nonPayment: fund?.policy.nonPayment ?? 'TRACK_ONLY',
        joinLock: fund?.policy.joinLock ?? 'ALLOW',
      };
    }),
  );
}
