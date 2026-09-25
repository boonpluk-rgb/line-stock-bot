import type { Env } from '../types';

const API = 'https://api.line.me/v2/bot';

export interface LineMessage {
  type: string;
  [k: string]: unknown;
}

interface ApiResult {
  ok: boolean;
  status: number;
  body: string;
}

const RETRY_DELAYS_MS = [300, 900];

async function request(
  env: Env,
  path: string,
  body: unknown,
  retryKey?: string,
): Promise<ApiResult> {
  const payload = JSON.stringify(body);
  let lastError: unknown = new Error('LINE API request failed');

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      };
      if (retryKey) headers['x-line-retry-key'] = retryKey;

      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers,
        body: payload,
      });
      const responseBody = await res.text();

      // 409 เกิดเมื่อคำขอเดิมถูก LINE รับแล้ว แต่การตอบกลับหลุดหาย
      if (res.status === 409 && retryKey) {
        return { ok: true, status: res.status, body: responseBody };
      }
      if (res.status < 500 || attempt === RETRY_DELAYS_MS.length) {
        return { ok: res.ok, status: res.status, body: responseBody };
      }
    } catch (err) {
      lastError = err;
      if (attempt === RETRY_DELAYS_MS.length) throw err;
    }

    console.warn(`LINE_API_RETRY ${JSON.stringify({ path, attempt: attempt + 1 })}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }

  throw lastError;
}

async function call(env: Env, path: string, body: unknown): Promise<void> {
  const result = await request(env, path, body, crypto.randomUUID());
  if (!result.ok) {
    console.error(`LINE_API_ERROR ${JSON.stringify({ path, status: result.status, body: result.body })}`);
  }
}

export async function reply(env: Env, replyToken: string, messages: LineMessage[]): Promise<void> {
  const limited = messages.slice(0, 5);
  const result = await request(
    env,
    '/message/reply',
    { replyToken, messages: limited },
    crypto.randomUUID(),
  );
  if (result.ok) return;

  console.error(`LINE_REPLY_ERROR ${JSON.stringify({ status: result.status, body: result.body })}`);
  if (result.status !== 400) return;

  const validation = await request(env, '/message/validate/reply', { messages: limited });
  console.error(
    `LINE_REPLY_VALIDATION ${JSON.stringify({ status: validation.status, body: validation.body })}`,
  );
  if (!validation.ok) {
    const fallback = await request(
      env,
      '/message/reply',
      {
        replyToken,
        messages: [{ type: 'text', text: 'ขออภัย ระบบสร้างการ์ดคำตอบไม่สำเร็จ กรุณาพิมพ์ "ช่วยเหลือ" อีกครั้ง' }],
      },
      crypto.randomUUID(),
    );
    console.error(`LINE_FALLBACK ${JSON.stringify({ status: fallback.status, body: fallback.body })}`);
  }
}

export function push(env: Env, to: string, messages: LineMessage[]): Promise<void> {
  return call(env, '/message/push', { to, messages: messages.slice(0, 5) });
}

export async function getProfile(
  env: Env,
  userId: string,
): Promise<{ displayName?: string; pictureUrl?: string } | null> {
  try {
    const res = await fetch(`${API}/profile/${userId}`, {
      headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { displayName?: string; pictureUrl?: string };
  } catch {
    return null;
  }
}

/** ตรวจลายเซ็น x-line-signature (HMAC-SHA256 ของ raw body, base64) */
export async function verifySignature(secret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
