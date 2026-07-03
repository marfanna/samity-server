import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';
import { isProd } from '../config/env';

/** Central error handler -> uniform { ok:false, error:{ code, message } } per docs/7. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  void _next;

  let statusCode = 500;
  let code = 'INTERNAL';
  let message = 'Something went wrong';

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  } else if (
    err instanceof Error &&
    err.name === 'MongoServerError' &&
    (err as { code?: number }).code === 11000
  ) {
    statusCode = 409;
    code = 'DUPLICATE';
    message = 'resource already exists';
  } else if (err instanceof Error && err.name === 'MulterError') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message =
      (err as { code?: string }).code === 'LIMIT_FILE_SIZE'
        ? 'image must be 15 MB or smaller'
        : 'file upload failed';
  }

  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message,
      ...(isProd ? {} : { stack: err instanceof Error ? err.stack : undefined }),
    },
  });
};
