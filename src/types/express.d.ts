import type { Role, MembershipStatus } from '../app/modules/membership/membership.model';

/** Context attached by authGuard / fundRole middleware. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by authGuard — the authenticated user's id (string). */
      userId?: string;
      /** Set by authGuard — the access-token jti (for blacklist on logout). */
      jti?: string;
      /** Set by fundRole — the caller's membership for the route's :fundId. */
      membership?: {
        membershipId: string;
        fundId: string;
        role: Role;
        status: MembershipStatus;
      };
    }
  }
}

export {};
