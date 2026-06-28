import { Schema, model } from 'mongoose';

/**
 * Per-fund advisory write-lock (replaces Redis SET NX).
 * _id = "fund:{fundId}:write". Acquire via conditional upsert; correctness comes from
 * the lease-expiry check in the acquire query, NOT the TTL index (which only reaps strays).
 */
export interface LockDoc {
  _id: string;
  owner: string;
  fencingSeq: number;
  acquiredAt: Date;
  expiresAt: Date;
}

const LockSchema = new Schema<LockDoc>(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    fencingSeq: { type: Number, required: true, default: 0 },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// TTL reaper for abandoned locks only — not the mutual-exclusion guarantee.
LockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Lock = model<LockDoc>('Lock', LockSchema);
