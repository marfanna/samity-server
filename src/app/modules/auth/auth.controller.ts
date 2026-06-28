import { Request, Response, CookieOptions } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../../utils/catchAsync';
import { sendResponse } from '../../../utils/sendResponse';
import { isProd } from '../../../config/env';
import { ApiError } from '../../../utils/ApiError';
import * as authService from './auth.service';

const REFRESH_COOKIE = 'refreshToken';
const refreshCookieOpts: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
  path: '/api/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOpts);
}

export const register = catchAsync(async (req: Request, res: Response) => {
  const data = await authService.register(req.body);
  sendResponse(res, httpStatus.OK, { otpSent: true, ...data });
});

export const verifyOtp = catchAsync(async (req: Request, res: Response) => {
  const { accessToken, refreshToken, user } = await authService.verifyOtp(req.body);
  setRefreshCookie(res, refreshToken);
  sendResponse(res, httpStatus.OK, { accessToken, user });
});

export const login = catchAsync(async (req: Request, res: Response) => {
  const { accessToken, refreshToken, user } = await authService.login(req.body);
  setRefreshCookie(res, refreshToken);
  sendResponse(res, httpStatus.OK, { accessToken, user });
});

export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const data = await authService.forgotPassword(req.body.phone);
  sendResponse(res, httpStatus.OK, { otpSent: true, ...data });
});

export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  await authService.resetPassword(req.body);
  sendResponse(res, httpStatus.OK, { reset: true });
});

export const refresh = catchAsync(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'missing refresh token');
  const { accessToken, refreshToken, user } = await authService.refresh(token);
  setRefreshCookie(res, refreshToken);
  sendResponse(res, httpStatus.OK, { accessToken, user });
});

export const logout = catchAsync(async (req: Request, res: Response) => {
  const header = req.headers.authorization ?? '';
  const accessToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (req.jti && accessToken) {
    await authService.logout(req.jti, accessToken, req.cookies?.[REFRESH_COOKIE]);
  }
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOpts, maxAge: undefined });
  sendResponse(res, httpStatus.OK, { loggedOut: true });
});
