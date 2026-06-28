import jwt, { SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

export interface AccessPayload {
  sub: string; // userId — token carries NO role (role is per-fund, resolved from Membership)
  jti: string; // for blacklist on logout
}

export interface RefreshPayload {
  sub: string;
  family: string; // rotation family
  jti: string;
}

export function signAccess(userId: string): { token: string; jti: string } {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, jti } satisfies AccessPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as SignOptions);
  return { token, jti };
}

export function signRefresh(userId: string, family: string): { token: string; jti: string } {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, family, jti } satisfies RefreshPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  } as SignOptions);
  return { token, jti };
}

export function verifyAccess(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AccessPayload;
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'invalid or expired access token');
  }
}

export function verifyRefresh(token: string): RefreshPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'invalid or expired refresh token');
  }
}

/** Decode without verifying (for reading exp of an already-validated token). */
export function decodeExp(token: string): Date | undefined {
  const decoded = jwt.decode(token);
  if (decoded && typeof decoded === 'object' && typeof decoded.exp === 'number') {
    return new Date(decoded.exp * 1000);
  }
  return undefined;
}
