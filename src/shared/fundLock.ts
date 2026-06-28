import { randomUUID } from 'crypto';
import { Lock } from '../app/modules/_infra/lock.model';
import { ApiError } from '../utils/ApiError';

const LEASE_MS = 30_000; // short lease; long mutations must renew (rare for money txns)

/**
 * Per-fund advisory write-lock backed by Mongo (replaces Redis SET NX).
 *
 * Correctness comes from the conditional acquire (lease-expiry check), NOT the TTL index.
 * Acquire succeeds only if no doc exists, or the existing lease has expired. A live lock
 * triggers a duplicate-key (11000) on upsert -> we surface STATE_CONFLICT (fail-fast).
 *
 * Pair every money mutation with this lock AND a Mongo transaction + compare-and-set.
 */
export async function withFundLock<T>(fundId: string, fn: (fencingSeq: number) => Promise<T>): Promise<T> {
  const _id = `fund:${fundId}:write`;
  const owner = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);

  let acquired;
  try {
    acquired = await Lock.findOneAndUpdate(
      { _id, $or: [{ expiresAt: { $lt: now } }, { expiresAt: { $exists: false } }] },
      { $set: { owner, acquiredAt: now, expiresAt }, $inc: { fencingSeq: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new ApiError(409, 'STATE_CONFLICT', 'fund is busy, retry shortly');
    }
    throw err;
  }

  if (!acquired || acquired.owner !== owner) {
    throw new ApiError(409, 'STATE_CONFLICT', 'fund is busy, retry shortly');
  }

  try {
    return await fn(acquired.fencingSeq);
  } finally {
    // release only if still ours (a slow op past the lease must not delete a newer holder's lock)
    await Lock.deleteOne({ _id, owner });
  }
}
