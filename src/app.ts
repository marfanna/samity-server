import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { apiRouter } from './app/routes';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';

export function buildApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // baseline rate limit; /auth/* gets a stricter limiter in Phase 03
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

  // Local-driver file serving. Filenames are unguessable UUIDs; no directory listing.
  // (Screenshots are payment proof — keep the UPLOAD_DIR off any public web root.)
  if (env.STORAGE_ENABLED && env.STORAGE_DRIVER === 'local') {
    app.use('/files', express.static(path.resolve(env.UPLOAD_DIR), { index: false, fallthrough: false }));
  }

  app.use('/api', apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
