import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import ms from 'ms';
import { User, UserDoc } from '../user/user.model';
import { RefreshToken } from '../_infra/refreshToken.model';
import { TokenBlacklist } from '../_infra/tokenBlacklist.model';
import { hashPassword, verifyPassword } from '../../../shared/password';
import { issueOtp, consumeOtp, TTL_SEC } from '../../../shared/otp';
import { signAccess, signRefresh, verifyRefresh, decodeExp } from '../../../shared/jwt';
import { ApiError } from '../../../utils/ApiError';
import { env } from '../../../config/env';
import type { RegisterInput, LoginInput, VerifyOtpInput, ResetInput } from './auth.validation';

export interface PublicUser {
  id: string;
  phone: string;
  name: string;
  locale: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const toPublic = (u: UserDoc): PublicUser => ({
  id: String(u._id),
  phone: u.phone,
  name: u.name,
  locale: u.locale,
});

function isPlayReviewLogin(input: LoginInput): boolean {
  return Boolean(env.PLAY_REVIEW_PHONE && env.PLAY_REVIEW_PASSWORD)
    && input.phone === env.PLAY_REVIEW_PHONE
    && input.password === env.PLAY_REVIEW_PASSWORD;
}

async function ensurePlayReviewUser(): Promise<UserDoc> {
  if (!env.PLAY_REVIEW_PHONE || !env.PLAY_REVIEW_PASSWORD) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'invalid phone or password');
  }

  const user = await User.findOneAndUpdate(
    { phone: env.PLAY_REVIEW_PHONE },
    {
      $set: {
        name: env.PLAY_REVIEW_NAME,
        passwordHash: await hashPassword(env.PLAY_REVIEW_PASSWORD),
        status: 'ACTIVE',
        lastLoginAt: new Date(),
      },
      $setOnInsert: { locale: 'en' },
    },
    { upsert: true, new: true, runValidators: true },
  );

  if (!user) throw new ApiError(500, 'INTERNAL_ERROR', 'review account unavailable');
  return user;
}

/** Issue access + a fresh refresh-token family, persisting the refresh hash for rotation. */
async function issueSession(user: UserDoc): Promise<AuthTokens> {
  const { token: accessToken } = signAccess(String(user._id));
  const family = randomUUID();
  const { token: refreshToken } = signRefresh(String(user._id), family);
  await RefreshToken.create({
    userId: user._id,
    tokenHash: await bcrypt.hash(refreshToken, 8),
    family,
    // Derive from the token's own exp claim (driven by JWT_REFRESH_TTL) rather than a
    // hardcoded duration, so the DB TTL-cleanup can't drift out of sync with the JWT itself
    // and misclassify a still-valid refresh as reuse (see the reuse-detection check below).
    expiresAt: decodeExp(refreshToken)!,
  });
  return { accessToken, refreshToken, user: toPublic(user) };
}

/** Step 1: stash hashed credentials on the OTP doc, send code. User is created on verify. */
export async function register(input: RegisterInput): Promise<{ expiresInSec: number }> {
  const existing = await User.findOne({ phone: input.phone, status: 'ACTIVE' }).lean();
  if (existing) throw new ApiError(409, 'DUPLICATE', 'phone already registered');

  const passwordHash = await hashPassword(input.password);
  return issueOtp(input.phone, 'REGISTER', { name: input.name, passwordHash });
}

/** Step 2: verify OTP. For REGISTER, create the user. Returns a session in both cases. */
export async function verifyOtp(input: VerifyOtpInput): Promise<AuthTokens> {
  const payload = await consumeOtp(input.phone, input.purpose, input.otp);

  if (input.purpose === 'REGISTER') {
    if (!payload && input.phone === env.PLAY_REVIEW_PHONE && input.otp === env.PLAY_REVIEW_OTP) {
      return issueSession(await ensurePlayReviewUser());
    }

    if (!payload?.name || !payload?.passwordHash) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'registration data expired — start over');
    }
    // An INVITED ghost (placeholder from an imported fund's roster) is claimed here:
    // upgrade it in place so its existing memberships transfer to the real account.
    // Also guard the race where another verify already created/claimed it.
    const existing = await User.findOne({ phone: input.phone, status: { $in: ['ACTIVE', 'INVITED'] } });
    let user: UserDoc;
    if (existing) {
      if (existing.status === 'INVITED') {
        existing.name = String(payload.name);
        existing.passwordHash = String(payload.passwordHash);
        existing.status = 'ACTIVE';
        await existing.save();
      }
      user = existing;
    } else {
      user = await User.create({
        phone: input.phone,
        name: String(payload.name),
        passwordHash: String(payload.passwordHash),
      });
    }
    return issueSession(user);
  }

  // RESET: prove ownership; password change happens in resetPassword. Issue a session too.
  const user = await User.findOne({ phone: input.phone, status: 'ACTIVE' });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'no account for this phone');
  return issueSession(user);
}

export async function login(input: LoginInput): Promise<AuthTokens> {
  if (isPlayReviewLogin(input)) {
    return issueSession(await ensurePlayReviewUser());
  }

  const user = await User.findOne({ phone: input.phone, status: 'ACTIVE' });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'invalid phone or password');
  }
  user.lastLoginAt = new Date();
  await user.save();
  return issueSession(user);
}

export async function forgotPassword(phone: string): Promise<{ expiresInSec: number }> {
  const user = await User.findOne({ phone, status: 'ACTIVE' }).lean();
  // Don't leak whether the phone exists — pretend success, only send if real.
  // Must match the real OTP TTL exactly, or a mismatched expiresInSec becomes the leak.
  if (!user) return { expiresInSec: TTL_SEC };
  return issueOtp(phone, 'RESET');
}

export async function resetPassword(input: ResetInput): Promise<void> {
  await consumeOtp(input.phone, 'RESET', input.otp);
  const user = await User.findOne({ phone: input.phone, status: 'ACTIVE' });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'no account for this phone');
  user.passwordHash = await hashPassword(input.newPassword);
  await user.save();
  // invalidate all existing refresh sessions on password change
  await RefreshToken.deleteMany({ userId: user._id });
}

/** Rotate: validate the presented refresh token, detect reuse, issue a new pair. */
export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const payload = verifyRefresh(refreshToken);
  const candidates = await RefreshToken.find({ userId: payload.sub, family: payload.family });

  let matched = null;
  for (const c of candidates) {
    if (await bcrypt.compare(refreshToken, c.tokenHash)) {
      matched = c;
      break;
    }
  }

  if (!matched) {
    // token not found in a live family = reuse/theft → nuke the whole family
    await RefreshToken.deleteMany({ userId: payload.sub, family: payload.family });
    throw new ApiError(401, 'UNAUTHENTICATED', 'refresh token reuse detected');
  }

  await matched.deleteOne(); // one-time use

  const user = await User.findOne({ _id: payload.sub, status: 'ACTIVE' });
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'account unavailable');

  const { token: accessToken } = signAccess(String(user._id));
  const { token: newRefresh } = signRefresh(String(user._id), payload.family);
  await RefreshToken.create({
    userId: user._id,
    tokenHash: await bcrypt.hash(newRefresh, 8),
    family: payload.family,
    expiresAt: decodeExp(newRefresh)!,
  });
  return { accessToken, refreshToken: newRefresh, user: toPublic(user) };
}

/** Blacklist the access token until its natural expiry + drop the refresh family. */
export async function logout(accessJti: string, accessToken: string, refreshToken?: string): Promise<void> {
  const exp = decodeExp(accessToken) ?? new Date(Date.now() + ms(env.JWT_ACCESS_TTL as ms.StringValue));
  await TokenBlacklist.create({ jti: accessJti, expiresAt: exp });
  if (refreshToken) {
    try {
      const payload = verifyRefresh(refreshToken);
      await RefreshToken.deleteMany({ userId: payload.sub, family: payload.family });
    } catch {
      // ignore an invalid refresh cookie on logout
    }
  }
}
