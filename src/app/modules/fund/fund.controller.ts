import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as fundService from './fund.service';

export const createFund = catchAsync(async (req: Request, res: Response) => {
  const result = await fundService.createFund(req.userId!, req.body);
  sendResponse(res, httpStatus.CREATED, result);
});

export const importFund = catchAsync(async (req: Request, res: Response) => {
  const result = await fundService.importFund(req.userId!, req.body);
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

export const updateFundSettings = catchAsync(async (req: Request, res: Response) => {
  const data = await fundService.updateFundSettings(req.params.fundId!, req.userId!, req.body);
  sendResponse(res, httpStatus.OK, data);
});

export const closeFund = catchAsync(async (req: Request, res: Response) => {
  const data = await fundService.closeFund(req.params.fundId!, req.userId!);
  sendResponse(res, httpStatus.OK, data);
});

export const deleteFund = catchAsync(async (req: Request, res: Response) => {
  const data = await fundService.deleteFund(req.params.fundId!, req.userId!);
  sendResponse(res, httpStatus.OK, data);
});

export const getNavHistory = catchAsync(async (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 30;
  const data = await fundService.getNavHistory(req.params.fundId!, limit);
  sendResponse(res, httpStatus.OK, data);
});
