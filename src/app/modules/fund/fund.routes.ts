import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import { fundRole } from '../../../middleware/fundRole';
import { validateBody } from '../../../middleware/validate';
import { createFundSchema } from './fund.validation';
import * as ctrl from './fund.controller';
import * as members from '../membership/membership.controller';
import { decideJoinSchema, createInviteSchema } from '../membership/membership.validation';

const router = Router();

router.use(authGuard);

// discovery (literal path — declared before /:fundId/* params)
router.get('/explore', members.explore);

router.post('/', validateBody(createFundSchema), ctrl.createFund);

// fund-scoped (per-fund role resolver)
router.get('/:fundId/nav', fundRole('member'), ctrl.getNav);
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

export const fundRoutes = router;
