import { RequestHandler } from 'express';
import { Membership, Role } from '../app/modules/membership/membership.model';
import { ApiError } from '../utils/ApiError';

const RANK: Record<Role, number> = { member: 1, moderator: 2, admin: 3 };

/**
 * Resolve the caller's per-fund role from their Membership for `:fundId` and enforce a minimum.
 * Run AFTER authGuard. Attaches req.membership. `admin/mod` = pass `'moderator'` as min.
 *
 *   router.use('/funds/:fundId', authGuard, fundRole('member'));
 */
export function fundRole(minRole: Role): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.userId) throw new ApiError(401, 'UNAUTHENTICATED', 'auth required');

      const fundId = req.params.fundId;
      if (!fundId) throw new ApiError(400, 'VALIDATION_ERROR', 'missing fundId');

      const membership = await Membership.findOne({ fundId, userId: req.userId }).lean();
      if (!membership) throw new ApiError(403, 'FORBIDDEN_ROLE', 'not a member of this fund');

      if (RANK[membership.role] < RANK[minRole]) {
        throw new ApiError(403, 'FORBIDDEN_ROLE', `requires ${minRole} or higher`);
      }

      req.membership = {
        membershipId: String(membership._id),
        fundId: String(membership.fundId),
        role: membership.role,
        status: membership.status,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
