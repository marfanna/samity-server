import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import { fundRole } from '../../../middleware/fundRole';
import { validateBody } from '../../../middleware/validate';
import {
  createFundSchema,
  importFundSchema,
  updateFundSchema,
  changeMemberRoleSchema,
  transferOwnershipSchema,
} from './fund.validation';
import * as ctrl from './fund.controller';
import * as members from '../membership/membership.controller';
import * as deposits from '../deposit/deposit.controller';
import * as investments from '../investment/investment.controller';
import * as ledger from '../ledger/ledger.controller';
import { decideJoinSchema, createInviteSchema } from '../membership/membership.validation';
import { rejectDepositSchema, submitDepositSchema } from '../deposit/deposit.validation';
import { recordInvestmentSchema, recordReturnSchema } from '../investment/investment.validation';
import * as transfers from '../transfer/shareTransfer.controller';
import { initiateTransferSchema } from '../transfer/shareTransfer.validation';
import { reverseLedgerEntrySchema } from '../ledger/ledger.validation';

const router = Router();

router.use(authGuard);

// discovery (literal path — declared before /:fundId/* params)
router.get('/explore', members.explore);

router.post('/', validateBody(createFundSchema), ctrl.createFund);
router.post('/import', validateBody(importFundSchema), ctrl.importFund);

// fund-scoped (per-fund role resolver)
router.get('/:fundId/nav', fundRole('member'), ctrl.getNav);
router.get('/:fundId/nav/history', fundRole('member'), ctrl.getNavHistory);
router.get('/:fundId/overview', fundRole('member'), ctrl.getOverview);
router.patch('/:fundId', fundRole('admin'), validateBody(updateFundSchema), ctrl.updateFundSettings);
router.delete('/:fundId', fundRole('admin'), ctrl.closeFund);
router.delete('/:fundId/purge', fundRole('admin'), ctrl.deleteFund);
router.get('/:fundId/members', fundRole('member'), members.getMembers);

// governance
router.patch(
  '/:fundId/members/:membershipId/role',
  fundRole('admin'),
  validateBody(changeMemberRoleSchema),
  members.changeMemberRole,
);
router.post(
  '/:fundId/transfer-ownership',
  fundRole('admin'),
  validateBody(transferOwnershipSchema),
  members.transferOwnership,
);
router.patch('/:fundId/members/:membershipId/reactivate', fundRole('admin'), members.reactivateMembership);

// join requests — POST is open to any authenticated user (not yet a member)
router.post('/:fundId/join-requests', members.requestJoin);
router.get('/:fundId/join-requests', fundRole('moderator'), members.listJoinRequests);
router.patch(
  '/:fundId/join-requests/:id',
  fundRole('moderator'),
  validateBody(decideJoinSchema),
  members.decideJoinRequest,
);

// invites
router.post('/:fundId/invites', fundRole('moderator'), validateBody(createInviteSchema), members.createInvite);

// deposits
router.post('/:fundId/deposits', fundRole('member'), validateBody(submitDepositSchema), deposits.submitDeposit);
router.get('/:fundId/deposits', fundRole('moderator'), deposits.listDeposits);
router.get('/:fundId/me/deposits', fundRole('member'), deposits.listMyDeposits);
router.patch('/:fundId/deposits/:id/verify', fundRole('moderator'), deposits.verifyDeposit);
router.patch('/:fundId/deposits/:id/reject', fundRole('moderator'), validateBody(rejectDepositSchema), deposits.rejectDeposit);

// investments
router.post('/:fundId/investments', fundRole('moderator'), validateBody(recordInvestmentSchema), investments.recordInvestment);
router.get('/:fundId/investments', fundRole('member'), investments.listInvestments);
router.patch('/:fundId/investments/:id/return', fundRole('moderator'), validateBody(recordReturnSchema), investments.recordReturn);

// share transfers
router.post('/:fundId/transfers', fundRole('member'), validateBody(initiateTransferSchema), transfers.initiateTransfer);
router.get('/:fundId/transfers', fundRole('member'), transfers.listMyTransfers);
router.get('/:fundId/transfers/pending', fundRole('moderator'), transfers.listPendingApprovals);
router.patch('/:fundId/transfers/:id/confirm', fundRole('member'), transfers.buyerConfirmTransfer);
router.patch('/:fundId/transfers/:id/approve', fundRole('moderator'), transfers.approveTransfer);
router.delete('/:fundId/transfers/:id', fundRole('member'), transfers.cancelTransfer);

// ledger
router.get('/:fundId/ledger', fundRole('member'), ledger.getFundLedger);
router.get('/:fundId/me/ledger', fundRole('member'), ledger.getMyLedger);
router.get('/:fundId/members/:membershipId/ledger', fundRole('moderator'), ledger.getMemberLedger);
router.post(
  '/:fundId/ledger/:entryId/reverse',
  fundRole('admin'),
  validateBody(reverseLedgerEntrySchema),
  ledger.reverseLedgerEntry,
);

export const fundRoutes = router;
