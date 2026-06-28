import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as depositService from './deposit.service';
import { listDepositsQuerySchema } from './deposit.validation';

export const submitDeposit = catchAsync(async (req: Request, res: Response) => {
  const result = await depositService.submitDeposit(
    req.userId!,
    req.params.fundId!,
    req.membership!.membershipId,
    req.body,
  );
  sendResponse(res, httpStatus.CREATED, result);
});

export const listDeposits = catchAsync(async (req: Request, res: Response) => {
  const query = listDepositsQuerySchema.parse(req.query);
  const result = await depositService.listDeposits(req.params.fundId!, query);
  sendResponse(res, httpStatus.OK, result);
});

export const listMyDeposits = catchAsync(async (req: Request, res: Response) => {
  const result = await depositService.listMyDeposits(req.params.fundId!, req.membership!.membershipId);
  sendResponse(res, httpStatus.OK, result);
});

export const verifyDeposit = catchAsync(async (req: Request, res: Response) => {
  const result = await depositService.verifyDeposit(req.userId!, req.params.fundId!, req.params.id!);
  sendResponse(res, httpStatus.OK, result);
});

export const rejectDeposit = catchAsync(async (req: Request, res: Response) => {
  const result = await depositService.rejectDeposit(req.userId!, req.params.fundId!, req.params.id!, req.body);
  sendResponse(res, httpStatus.OK, result);
});
