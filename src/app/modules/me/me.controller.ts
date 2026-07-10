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

export const getPortfolioHistory = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await meService.getPortfolioHistory(req.userId!));
});

export const deleteMe = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await meService.deleteAccount(req.userId!));
});

export const registerFcmToken = catchAsync(async (req: Request, res: Response) => {
  await meService.registerFcmToken(req.userId!, req.body.token);
  sendResponse(res, httpStatus.OK, { registered: true });
});

export const deregisterFcmToken = catchAsync(async (req: Request, res: Response) => {
  await meService.deregisterFcmToken(req.userId!, req.body.token);
  sendResponse(res, httpStatus.OK, { deregistered: true });
});
