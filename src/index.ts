import { Hono } from 'hono';
import type { Env } from './types';
import { api } from './api/routes';
import { verifySignature } from './line/client';
import { handleEvent, simulate } from './line/handler';
import * as repo from './db/repo';
import { AppError } from './lib/util';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true, service: 'line-stock' }));

/* ------------------------------------------------------- LINE webhook */

app.post('/line/webhook', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header('x-line-signature') ?? null;

  const valid = await verifySignature(c.env.LINE_CHANNEL_SECRET, raw, signature);
  if (!valid) {
    console.warn('ลายเซ็น webhook ไม่ถูกต้อง');
    return c.text('invalid signature', 401);
  }

  const body = JSON.parse(raw || '{}') as { events?: any[] };
  const events = body.events ?? [];

  // ตอบ 200 ทันทีตามที่ LINE ต้องการ แล้วประมวลผลต่อเบื้องหลัง
  c.executionCtx.waitUntil(
    (async () => {
      for (const event of events) {
        try {
          if (event.webhookEventId && (await repo.isDuplicateEvent(c.env.DB, event.webhookEventId))) continue;
          await handleEvent(c.env, event);
        } catch (err) {
          console.error('handleEvent error', err);
        }
      }
      if (Math.random() < 0.05) await repo.purgeOldEvents(c.env.DB).catch(() => {});
    })(),
  );

  return c.text('OK');
});

/* จำลองบทสนทนาไว้ทดสอบตอนพัฒนา — ปิดสนิทบน production */
app.post('/line/simulate', async (c) => {
  if (c.env.ENVIRONMENT !== 'dev') return c.json({ error: 'ไม่พบเส้นทางนี้' }, 404);
  const body = await c.req.json<{ user?: string; text?: string; postback?: string; as?: string }>();
  const messages = await simulate(c.env, body.user ?? 'Utest0000000000000000000000000001', body);
  return c.json({ messages });
});

/* ------------------------------------------------------------ REST API */

app.route('/api', api);

app.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: err.message }, err.status as 400);
  console.error('unhandled error', err);
  return c.json({ error: 'เกิดข้อผิดพลาดภายในระบบ' }, 500);
});

/* หน้า LIFF (ไฟล์ static ถูกเสิร์ฟโดย assets binding อยู่แล้ว) */
app.notFound(async (c) => {
  if (c.req.path.startsWith('/api') || c.req.path.startsWith('/line')) {
    return c.json({ error: 'ไม่พบเส้นทางนี้' }, 404);
  }
  const url = new URL(c.req.url);
  url.pathname = '/index.html';
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

export default app;
