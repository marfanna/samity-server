import { Router } from 'express';
import { validateBody } from '../../../middleware/validate';
import { authGuard } from '../../../middleware/authGuard';
import { authLimiter } from '../../../middleware/rateLimiter';
import * as ctrl from './auth.controller';
import {
  registerSchema,
  verifyOtpSchema,
  loginSchema,
  forgotSchema,
  resetSchema,
} from './auth.validation';

const router = Router();

router.use(authLimiter);

router.post('/register', validateBody(registerSchema), ctrl.register);
router.post('/verify-otp', validateBody(verifyOtpSchema), ctrl.verifyOtp);
router.post('/login', validateBody(loginSchema), ctrl.login);
router.post('/forgot-password', validateBody(forgotSchema), ctrl.forgotPassword);
router.post('/reset-password', validateBody(resetSchema), ctrl.resetPassword);
router.post('/refresh', ctrl.refresh);
router.post('/logout', authGuard, ctrl.logout);

export const authRoutes = router;
