import { Response } from 'express';

/**
 * Uniform success envelope per docs/7: { ok: true, data }.
 * Errors use the central error handler -> { ok: false, error: { code, message } }.
 */
export function sendResponse<T>(res: Response, statusCode: number, data: T): void {
  res.status(statusCode).json({ ok: true, data });
}
