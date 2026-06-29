import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import { fundRole } from '../../../middleware/fundRole';
import { validateBody } from '../../../middleware/validate';
import { createFundSchema } from './fund.validation';
import * as ctrl from './fund.controller';
import * as members from '../membership/membership.controller';
import * as deposits from '../deposit/deposit.controller';
import * as investments from '../investment/investment.controller';
import * as ledger from '../ledger/ledger.controller';
import { decideJoinSchema, createInviteSchema } from '../membership/membership.validation';
import { rejectDepositSchema, submitDepositSchema } from '../deposit/deposit.validation';
import { recordInvestmentSchema, recordReturnSchema } from '../investment/investment.validation';

const router = Router();

router.use(authGuard);

// discovery (literal path — declared before /:fundId/* params)
router.get('/explore', members.explore);

router.post('/', validateBody(createFundSchema), ctrl.createFund);

// fund-scoped (per-fund role resolver)
router.get('/:fundId/nav', fundRole('member'), ctrl.getNav);
router.get('/:fundId/overview', fundRole('member'), ctrl.getOverview);
router.get('/:fundId/members', fundRole('member'), members.getMembers);

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

// ledger
router.get('/:fundId/ledger', fundRole('member'), ledger.getFundLedger);
router.get('/:fundId/me/ledger', fundRole('member'), ledger.getMyLedger);
router.get('/:fundId/members/:membershipId/ledger', fundRole('moderator'), ledger.getMemberLedger);

export const fundRoutes = router;
