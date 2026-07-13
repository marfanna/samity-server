// infra (TTL) collections
import { Lock } from './_infra/lock.model';
import { Otp } from './_infra/otp.model';
import { TokenBlacklist } from './_infra/tokenBlacklist.model';
import { RefreshToken } from './_infra/refreshToken.model';
import { RateLimit } from './_infra/rateLimit.model';

// domain collections
import { User } from './user/user.model';
import { Fund } from './fund/fund.model';
import { Membership } from './membership/membership.model';
import { JoinRequest } from './membership/joinRequest.model';
import { Invite } from './membership/invite.model';
import { Deposit } from './deposit/deposit.model';
import { LedgerEntry } from './ledger/ledgerEntry.model';
import { NavSnapshot } from './nav/navSnapshot.model';
import { Investment } from './investment/investment.model';
import { ShareTransfer } from './transfer/shareTransfer.model';
import { AuditLog } from './audit/auditLog.model';
import { Notification } from './notification/notification.model';

type IndexSyncModel = {
  syncIndexes(): Promise<unknown>;
};

/** Every registered model. dbInit syncs indexes across all of these on boot. */
export const allModels: IndexSyncModel[] = [
  // infra
  Lock,
  Otp,
  TokenBlacklist,
  RefreshToken,
  RateLimit,
  // domain
  User,
  Fund,
  Membership,
  JoinRequest,
  Invite,
  Deposit,
  LedgerEntry,
  NavSnapshot,
  Investment,
  ShareTransfer,
  AuditLog,
  Notification,
];
