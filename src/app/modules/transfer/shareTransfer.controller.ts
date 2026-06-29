import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as svc from './shareTransfer.service';

export const initiateTransfer = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.initiateTransfer(req.membership!.membershipId, req.params.fundId!, req.body);
  sendResponse(res, httpStatus.CREATED, result);
});

export const buyerConfirmTransfer = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.buyerConfirmTransfer(req.userId!, req.params.fundId!, req.params.id!);
  sendResponse(res, httpStatus.OK, result);
});

export const approveTransfer = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.approveTransfer(req.userId!, req.params.fundId!, req.params.id!);
  sendResponse(res, httpStatus.OK, result);
});

export const cancelTransfer = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.cancelTransfer(
    req.membership!.membershipId,
    req.membership!.role,
    req.params.fundId!,
    req.params.id!,
  );
  sendResponse(res, httpStatus.OK, result);
});

export const listMyTransfers = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.listMyTransfers(req.membership!.membershipId, req.params.fundId!);
  sendResponse(res, httpStatus.OK, result);
});

export const listPendingApprovals = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.listPendingApprovals(req.params.fundId!);
  sendResponse(res, httpStatus.OK, result);
});
