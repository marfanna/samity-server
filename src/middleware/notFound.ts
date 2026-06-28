import { RequestHandler } from 'express';

export const notFound: RequestHandler = (req, res) => {
  res
    .status(404)
    .json({ ok: false, error: { code: 'NOT_FOUND', message: `route not found: ${req.method} ${req.path}` } });
};
