import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as fundService from './fund.service';

export const createFund = catchAsync(async (req: Request, res: Response) => {
  const result = await fundService.createFund(req.userId!, req.body);
  sendResponse(res, httpStatus.CREATED, result);
});

export const getNav = catchAsync(async (req: Request, res: Response) => {
  const data = await fundService.getNav(req.params.fundId!);
  sendResponse(res, httpStatus.OK, data);
});

export const getOverview = catchAsync(async (req: Request, res: Response) => {
  const data = await fundService.getOverview(req.params.fundId!);
  sendResponse(res, httpStatus.OK, data);
});
