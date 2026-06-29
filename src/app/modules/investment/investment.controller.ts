import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as investmentService from './investment.service';

export const recordInvestment = catchAsync(async (req: Request, res: Response) => {
  const result = await investmentService.recordInvestment(
    req.userId!,
    req.params.fundId!,
    req.body,
  );
  sendResponse(res, httpStatus.CREATED, result);
});

export const listInvestments = catchAsync(async (req: Request, res: Response) => {
  const result = await investmentService.listInvestments(req.params.fundId!);
  sendResponse(res, httpStatus.OK, result);
});

export const recordReturn = catchAsync(async (req: Request, res: Response) => {
  const result = await investmentService.recordReturn(
    req.userId!,
    req.params.fundId!,
    req.params.id!,
    req.body,
  );
  sendResponse(res, httpStatus.OK, result);
});
