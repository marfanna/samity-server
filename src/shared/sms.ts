import { isProd } from '../config/env';

/**
 * SMS gateway adapter. No provider wired yet (Phase 03 stub) — in dev we log the code so the
 * flow is testable. In prod without SMS_API_KEY this throws, so OTP can't silently no-op.
 */
export async function sendSms(phone: string, message: string): Promise<void> {
  if (!isProd) {
    // eslint-disable-next-line no-console
    console.log(`📱 [DEV SMS] to ${phone}: ${message}`);
    return;
  }
  // TODO(Phase 03): integrate BD provider (SSL Wireless) / Twilio fallback via SMS_API_KEY.
  throw new Error('SMS provider not configured');
}
