import { Schema, model } from 'mongoose';

/** Revoked access tokens (logout). TTL on expiresAt = original token lifetime. */
export interface TokenBlacklistDoc {
  jti: string;
  expiresAt: Date;
}

const TokenBlacklistSchema = new Schema<TokenBlacklistDoc>(
  {
    jti: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

TokenBlacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TokenBlacklist = model<TokenBlacklistDoc>('TokenBlacklist', TokenBlacklistSchema);
