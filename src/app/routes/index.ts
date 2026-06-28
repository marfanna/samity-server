import { Router } from 'express';
import mongoose from 'mongoose';
import { authRoutes } from '../modules/auth/auth.routes';
import { meRoutes } from '../modules/me/me.routes';
import { fundRoutes } from '../modules/fund/fund.routes';
import { inviteRoutes } from '../modules/membership/invite.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/me', meRoutes);
router.use('/funds', fundRoutes);
router.use('/invites', inviteRoutes);

// More fund-scoped routers (deposits, investments, transfers, …) mount here in Phase 07+.

router.get('/health', (_req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'] as const;
  res.json({
    ok: true,
    data: {
      service: 'samity-server',
      db: states[mongoose.connection.readyState as number] ?? 'unknown',
      time: new Date().toISOString(),
    },
  });
});

export const apiRouter = router;
