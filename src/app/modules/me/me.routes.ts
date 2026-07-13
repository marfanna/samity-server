import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import { validateBody } from '../../../middleware/validate';
import { updateMeSchema, fcmTokenSchema, deleteAccountSchema } from './me.validation';
import * as ctrl from './me.controller';

const router = Router();

router.use(authGuard);

router.get('/', ctrl.getMe);
router.patch('/', validateBody(updateMeSchema), ctrl.updateMe);
router.delete('/', validateBody(deleteAccountSchema), ctrl.deleteMe);
router.get('/funds', ctrl.getMyFunds);
router.get('/portfolio-history', ctrl.getPortfolioHistory);
router.post('/fcm-token', validateBody(fcmTokenSchema), ctrl.registerFcmToken);
router.delete('/fcm-token', validateBody(fcmTokenSchema), ctrl.deregisterFcmToken);

export const meRoutes = router;
