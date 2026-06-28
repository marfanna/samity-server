import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as meService from './me.service';

export const getMe = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await meService.getMe(req.userId!));
});

export const updateMe = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await meService.updateMe(req.userId!, req.body));
});

export const getMyFunds = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await meService.getMyFunds(req.userId!));
});
