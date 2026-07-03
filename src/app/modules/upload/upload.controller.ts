import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import { ApiError } from '../../../utils/ApiError';
import * as svc from './upload.service';

export const uploadScreenshot = catchAsync(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw new ApiError(400, 'VALIDATION_ERROR', 'file is required');
  const result = await svc.uploadScreenshot(req.userId!, {
    buffer: file.buffer,
    mimetype: file.mimetype,
  });
  sendResponse(res, httpStatus.CREATED, result);
});
