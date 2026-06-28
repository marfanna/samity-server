import { env, isProd } from '../config/env';

type SmsPayload = Record<string, string>;

function buildSmsUrl(payload: SmsPayload): URL {
  const base = env.SMS_BASE_URL;
  if (!base) throw new Error('SMS_BASE_URL is required when SMS_ENABLED=true');

  const url = new URL(env.SMS_SEND_PATH, base.endsWith('/') ? base : `${base}/`);
  if (env.SMS_METHOD === 'GET' || env.SMS_BODY_FORMAT === 'query') {
    for (const [key, value] of Object.entries(payload)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function buildPayload(phone: string, message: string): SmsPayload {
  if (!env.SMS_API_KEY) throw new Error('SMS_API_KEY is required when SMS_ENABLED=true');
  if (!env.SMS_SENDER_ID) throw new Error('SMS_SENDER_ID is required when SMS_ENABLED=true');

  return {
    [env.SMS_AUTH_PARAM]: env.SMS_API_KEY,
    [env.SMS_SENDER_PARAM]: env.SMS_SENDER_ID,
    [env.SMS_TO_PARAM]: phone.replace(/^\+/, ''),
    [env.SMS_MESSAGE_PARAM]: message,
  };
}

async function postSms(url: URL, payload: SmsPayload): Promise<Response> {
  if (env.SMS_BODY_FORMAT === 'query') {
    return fetch(url, { method: 'POST' });
  }

  if (env.SMS_BODY_FORMAT === 'json') {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload),
  });
}

/**
 * SMS gateway adapter. Set SMS_ENABLED=true to send real OTP messages.
 * In development without SMS_ENABLED, logs the OTP so auth flows stay testable.
 */
export async function sendSms(phone: string, message: string): Promise<void> {
  if (!env.SMS_ENABLED) {
    if (!isProd) {
      // eslint-disable-next-line no-console
      console.log(`[DEV SMS] to ${phone}: ${message}`);
      return;
    }
    throw new Error('SMS provider not configured');
  }

  const payload = buildPayload(phone, message);
  const url = buildSmsUrl(payload);
  const response = env.SMS_METHOD === 'GET' ? await fetch(url) : await postSms(url, payload);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`SMS gateway failed (${response.status}): ${body.slice(0, 200)}`);
  }
  if (env.SMS_SUCCESS_REGEX && !new RegExp(env.SMS_SUCCESS_REGEX, 'i').test(body)) {
    throw new Error(`SMS gateway returned an unexpected response: ${body.slice(0, 200)}`);
  }
}
