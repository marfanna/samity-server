import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import { validateBody } from '../../../middleware/validate';
import { updateMeSchema } from './me.validation';
import * as ctrl from './me.controller';

const router = Router();

router.use(authGuard);

router.get('/', ctrl.getMe);
router.patch('/', validateBody(updateMeSchema), ctrl.updateMe);
router.get('/funds', ctrl.getMyFunds);

export const meRoutes = router;
