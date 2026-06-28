import { RequestHandler } from 'express';
import { verifyAccess } from '../shared/jwt';
import { TokenBlacklist } from '../app/modules/_infra/tokenBlacklist.model';
import { ApiError } from '../utils/ApiError';

/**
 * Require a valid access token. Attaches req.userId + req.jti.
 * Rejects blacklisted tokens (logout). Token carries NO role — role is resolved per fund.
 */
export const authGuard: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'missing bearer token');
    }
    const payload = verifyAccess(header.slice(7));

    const revoked = await TokenBlacklist.exists({ jti: payload.jti });
    if (revoked) throw new ApiError(401, 'UNAUTHENTICATED', 'token revoked');

    req.userId = payload.sub;
    req.jti = payload.jti;
    next();
  } catch (err) {
    next(err);
  }
};
