import { randomInt } from 'crypto';
import bcrypt from 'bcryptjs';
import { Otp, OtpDoc } from '../app/modules/_infra/otp.model';
import { sendSms } from './sms';
import { ApiError } from '../utils/ApiError';

const TTL_SEC = 300; // mirrors the otps TTL index
const RESEND_COOLDOWN_SEC = 60;
const MAX_ATTEMPTS = 5;

type Purpose = OtpDoc['purpose'];

/**
 * Issue a 6-digit OTP for a phone+purpose. Upserts a single live doc (one OTP per phone+purpose),
 * enforces a resend cooldown, stores only the hash, and dispatches via SMS.
 */
export async function issueOtp(
  phone: string,
  purpose: Purpose,
  payload?: Record<string, unknown>,
): Promise<{ expiresInSec: number }> {
  const existing = await Otp.findOne({ phone, purpose }).lean();
  if (existing) {
    const ageSec = (Date.now() - new Date(existing.createdAt).getTime()) / 1000;
    if (ageSec < RESEND_COOLDOWN_SEC) {
      throw new ApiError(429, 'RATE_LIMITED', `wait ${Math.ceil(RESEND_COOLDOWN_SEC - ageSec)}s before resending`);
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 8);

  await Otp.findOneAndUpdate(
    { phone, purpose },
    { $set: { codeHash, attempts: 0, payload: payload ?? null, createdAt: new Date() } },
    { upsert: true },
  );

  // Delivery is best-effort: the OTP is already persisted above, so a gateway quirk
  // (e.g. an unexpected success-response body) must not fail issuance — that would block
  // the user even when the SMS actually went out. Log failures for visibility/regex tuning.
  try {
    await sendSms(phone, `Your Samity code is ${code}. Valid ${TTL_SEC / 60} minutes.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`⚠️ OTP SMS dispatch issue for ${phone} (code still issued):`, (err as Error).message);
  }
  return { expiresInSec: TTL_SEC };
}

/**
 * Verify and consume an OTP. Deletes on success. Counts attempts and locks out after MAX_ATTEMPTS.
 * Throws on any failure — callers treat a clean return as proof of phone ownership.
 */
export async function consumeOtp(
  phone: string,
  purpose: Purpose,
  code: string,
): Promise<Record<string, unknown> | undefined> {
  const doc = await Otp.findOne({ phone, purpose });
  if (!doc) throw new ApiError(400, 'VALIDATION_ERROR', 'no active code — request a new one');

  if (doc.attempts >= MAX_ATTEMPTS) {
    await doc.deleteOne();
    throw new ApiError(429, 'RATE_LIMITED', 'too many attempts — request a new code');
  }

  const ok = await bcrypt.compare(code, doc.codeHash);
  if (!ok) {
    doc.attempts += 1;
    await doc.save();
    throw new ApiError(400, 'VALIDATION_ERROR', 'incorrect code');
  }

  const payload = doc.payload ?? undefined;
  await doc.deleteOne();
  return payload;
}
