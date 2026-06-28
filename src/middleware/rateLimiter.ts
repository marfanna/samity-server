import rateLimit from 'express-rate-limit';

/** Stricter limiter for /auth/* — blunts OTP bombing and credential stuffing. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'too many auth attempts, slow down' } },
});
