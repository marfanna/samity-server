import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as ledgerService from './ledger.service';

export const getMyLedger = catchAsync(async (req: Request, res: Response) => {
  const result = await ledgerService.getMyLedger(
    req.params.fundId!,
    req.membership!.membershipId,
  );
  sendResponse(res, httpStatus.OK, result);
});

export const getFundLedger = catchAsync(async (req: Request, res: Response) => {
  const result = await ledgerService.getFundLedger(req.params.fundId!);
  sendResponse(res, httpStatus.OK, result);
});

export const getMemberLedger = catchAsync(async (req: Request, res: Response) => {
  const result = await ledgerService.getMemberLedger(
    req.params.fundId!,
    req.params.membershipId!,
  );
  sendResponse(res, httpStatus.OK, result);
});

export const reverseLedgerEntry = catchAsync(async (req: Request, res: Response) => {
  const result = await ledgerService.reverseLedgerEntry(
    req.userId!,
    req.params.fundId!,
    req.params.entryId!,
    req.body.reason,
  );
  sendResponse(res, httpStatus.OK, result);
});
