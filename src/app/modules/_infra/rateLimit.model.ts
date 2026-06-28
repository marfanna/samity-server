import { Schema, model } from 'mongoose';

/**
 * OTP / auth throttle counters (replaces Redis counters).
 * `rate-limit-mongo` manages its own collection for HTTP rate limiting; this model is for
 * app-level throttles (e.g. OTP issuance per phone) where we want explicit control.
 */
export interface RateLimitDoc {
  key: string;
  count: number;
  expiresAt: Date;
}

const RateLimitSchema = new Schema<RateLimitDoc>(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit = model<RateLimitDoc>('RateLimit', RateLimitSchema);
