import { RequestHandler } from 'express';
import { ZodTypeAny, TypeOf } from 'zod';

/**
 * Validate & coerce req.body against a zod schema. On success, req.body is the parsed value.
 * Failure throws ZodError -> central handler -> 400 VALIDATION_ERROR.
 */
export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.parse(req.body) as TypeOf<T>;
    req.body = parsed;
    next();
  };
}
