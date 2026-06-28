import { User } from '../user/user.model';
import { Membership } from '../membership/membership.model';
import { Fund } from '../fund/fund.model';
import { hashPassword } from '../../../shared/password';
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

/** All memberships for the user, joined with fund headline fields. */
export async function getMyFunds(userId: string) {
  const memberships = await Membership.find({ userId, status: { $ne: 'EXITED' } }).lean();
  const fundIds = memberships.map((m) => m.fundId);
  const funds = await Fund.find({ _id: { $in: fundIds } }).lean();
  const fundById = new Map(funds.map((f) => [String(f._id), f]));

  return memberships.map((m) => {
    const fund = fundById.get(String(m.fundId));
    return {
      fundId: String(m.fundId),
      name: fund?.name ?? '',
      role: m.role,
      status: m.status,
      shares: m.shares,
      cycleUnit: fund?.policy.cycleUnit ?? null,
    };
  });
}
