import type { Context, Next } from 'hono';
import type { Env, Role } from '../types';
import * as repo from '../db/repo';
import { AppError } from '../lib/util';

export interface AuthUser {
  lineUserId: string;
  name: string | null;
  picture: string | null;
  /** ระดับสิทธิ์ — owner ทำได้ทุกอย่าง, staff ทำได้แค่ดูและสั่งเบิก */
  role: Role;
}

interface VerifyResponse {
  sub: string;
  name?: string;
  picture?: string;
  aud?: string;
  exp?: number;
}

/** ตรวจ ID token ที่ได้จาก liff.getIDToken() กับเซิร์ฟเวอร์ของ LINE */
export async function verifyIdToken(env: Env, idToken: string): Promise<Omit<AuthUser, 'role'> | null> {
  if (!env.LINE_LOGIN_CHANNEL_ID) {
    console.error('LINE_LOGIN_CHANNEL_ID ยังไม่ได้ตั้งค่า');
    return null;
  }
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_LOGIN_CHANNEL_ID }),
  });
  if (!res.ok) {
    console.warn('verify id_token failed', res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as VerifyResponse;
  if (!data.sub) return null;
  return { lineUserId: data.sub, name: data.name ?? null, picture: data.picture ?? null };
}

export type AppContext = Context<{ Bindings: Env; Variables: { user: AuthUser } }>;

export async function requireAuth(c: AppContext, next: Next): Promise<Response | void> {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  // โหมดพัฒนา: ข้ามการยืนยันตัวตนเพื่อเปิดหน้า LIFF ในเบราว์เซอร์ปกติได้
  if (!token && c.env.ENVIRONMENT === 'dev' && c.env.DEV_LINE_USER_ID) {
    const name = c.env.DEV_LINE_DISPLAY_NAME ?? 'Dev User';
    const role = await repo.ensureUser(c.env.DB, c.env.DEV_LINE_USER_ID, name, null);
    c.set('user', { lineUserId: c.env.DEV_LINE_USER_ID, name, picture: null, role });
    return next();
  }

  if (!token) return c.json({ error: 'กรุณาเข้าสู่ระบบผ่าน LINE' }, 401);

  const verified = await verifyIdToken(c.env, token);
  if (!verified) return c.json({ error: 'เซสชันหมดอายุ กรุณาเปิดแอปใหม่อีกครั้ง' }, 401);

  const role = await repo.ensureUser(c.env.DB, verified.lineUserId, verified.name, verified.picture);
  c.set('user', { ...verified, role });
  return next();
}

/** บล็อกเฉพาะผู้ดูแล — ใช้กับทุกอย่างที่แก้ข้อมูลหรือย้อนแก้สต๊อกได้ */
export function assertOwner(user: AuthUser): void {
  if (user.role !== 'owner') {
    throw new AppError('คำสั่งนี้ใช้ได้เฉพาะผู้ดูแลระบบเท่านั้น', 403);
  }
}

/** ครอบ route ที่อนุญาตเฉพาะผู้ดูแล */
export function ownerOnly(c: AppContext, next: Next): Promise<Response | void> {
  assertOwner(c.get('user'));
  return next();
}
