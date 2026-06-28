import { Request, Response, NextFunction, RequestHandler } from 'express';

/** Wrap an async handler so thrown errors reach the central error handler. */
export const catchAsync =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
