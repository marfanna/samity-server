import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import * as members from './membership.controller';

const router = Router();

router.use(authGuard);

// accept an invite by its token (the invitee must be authenticated)
router.post('/:token/accept', members.acceptInvite);

export const inviteRoutes = router;
