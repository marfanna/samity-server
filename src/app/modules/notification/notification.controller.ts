import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as svc from './notification.service';

export const listNotifications = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await svc.listNotifications(req.userId!));
});

export const markAllRead = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await svc.markAllRead(req.userId!));
});

export const markRead = catchAsync(async (req: Request, res: Response) => {
  const ids: string[] = req.body.ids ?? [];
  sendResponse(res, httpStatus.OK, await svc.markRead(req.userId!, ids));
});
