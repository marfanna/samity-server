import { Router } from 'express';
import { authGuard } from '../../../middleware/authGuard';
import * as ctrl from './notification.controller';

const router = Router();

router.use(authGuard);

router.get('/', ctrl.listNotifications);
router.get('/unread-count', ctrl.getUnreadCount);
router.patch('/read-all', ctrl.markAllRead);
router.patch('/read', ctrl.markRead);

export const notificationRoutes = router;
