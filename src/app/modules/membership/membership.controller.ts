import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import * as svc from './membership.service';
import { listJoinRequestsQuerySchema } from './membership.validation';

export const explore = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await svc.exploreFunds(req.userId!));
});

export const getMembers = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, httpStatus.OK, await svc.getMembers(req.params.fundId!));
});

export const requestJoin = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.requestJoin(req.userId!, req.params.fundId!);
  sendResponse(res, httpStatus.CREATED, result);
});

export const listJoinRequests = catchAsync(async (req: Request, res: Response) => {
  const { status } = listJoinRequestsQuerySchema.parse(req.query);
  sendResponse(res, httpStatus.OK, await svc.listJoinRequests(req.params.fundId!, status));
});

export const decideJoinRequest = catchAsync(async (req: Request, res: Response) => {
  const { decision, reason } = req.body;
  const result = await svc.decideJoinRequest(req.userId!, req.params.fundId!, req.params.id!, decision, reason);
  sendResponse(res, httpStatus.OK, result);
});

export const createInvite = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.createInvite(req.userId!, req.params.fundId!, req.body.phone);
  sendResponse(res, httpStatus.CREATED, result);
});

export const acceptInvite = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.acceptInvite(req.userId!, req.params.token!);
  sendResponse(res, httpStatus.OK, result);
});

export const changeMemberRole = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.changeMemberRole(
    req.userId!,
    req.params.fundId!,
    req.params.membershipId!,
    req.body.role,
  );
  sendResponse(res, httpStatus.OK, result);
});

export const reactivateMembership = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.reactivateMembership(req.userId!, req.params.fundId!, req.params.membershipId!);
  sendResponse(res, httpStatus.OK, result);
});

export const transferOwnership = catchAsync(async (req: Request, res: Response) => {
  const result = await svc.transferOwnership(
    req.userId!,
    req.params.fundId!,
    req.body.membershipId,
  );
  sendResponse(res, httpStatus.OK, result);
});
