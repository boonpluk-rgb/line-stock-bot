import { Hono } from 'hono';
import type { Env, Role } from '../types';
import * as repo from '../db/repo';
import { AppError, fmtQty } from '../lib/util';
import { assertOwner, ownerOnly, requireAuth, type AuthUser } from './auth';

type Vars = { Variables: { user: AuthUser }; Bindings: Env };

export const api = new Hono<Vars>();

/* config เปิดสาธารณะ — หน้าเว็บต้องรู้ LIFF ID ก่อนจึงจะ init ได้ */
api.get('/config', (c) =>
  c.json({
    liffId: c.env.LIFF_ID ?? '',
    dev: c.env.ENVIRONMENT === 'dev',
    // ที่อยู่เว็บต้นทาง (ไม่มี `/` ต่อท้าย) — ใช้เป็น redirectUri ตอน liff.login()
    // ถ้าใช้ location.href ตรง ๆ เบราว์เซอร์บางตัวจะเติม `/` หรือพารามิเตอร์ ทำให้ LINE ตอบ 400 Bad Request
    endpointUrl: new URL(c.req.url).origin,
  }),
);

api.use('/*', requireAuth);

api.get('/me', (c) => c.json(c.get('user')));

/* ------------------------------------------------------- ผู้ใช้ / สิทธิ์ */

api.get('/users', ownerOnly, async (c) => c.json(await repo.listUsers(c.env.DB)));

api.put('/users/:id/role', ownerOnly, async (c) => {
  const body = await c.req.json<{ role?: string }>();
  const role = body.role as Role;
  if (role !== 'owner' && role !== 'staff') throw new AppError('ระดับสิทธิ์ไม่ถูกต้อง');
  const me = c.get('user');
  const targetId = Number(c.req.param('id'));
  await repo.setUserRole(c.env.DB, targetId, role, { lineUserId: me.lineUserId, role: me.role });
  return c.json({ ok: true, id: targetId, role });
});

api.get('/summary', async (c) => {
  const db = c.env.DB;
  const [summary, low, recent, locations] = await Promise.all([
    repo.getSummary(db),
    repo.lowStockProducts(db, 8),
    repo.listMovements(db, { limit: 12 }),
    repo.listLocations(db),
  ]);
  const byLocation = await db
    .prepare(
      `SELECT l.id, l.code, l.name,
              COALESCE(SUM(CASE WHEN p.active = 1 THEN s.qty ELSE 0 END), 0) AS units,
              COUNT(CASE WHEN p.active = 1 AND s.qty > 0 THEN 1 END) AS items
       FROM locations l
       LEFT JOIN stock_levels s ON s.location_id = l.id
       LEFT JOIN products p ON p.id = s.product_id
       WHERE l.active = 1
       GROUP BY l.id ORDER BY l.is_default DESC, l.code`,
    )
    .all();
  return c.json({ summary, low, recent, locations, byLocation: byLocation.results ?? [] });
});

/* ------------------------------------------------------------ locations */

api.get('/locations', async (c) => c.json(await repo.listLocations(c.env.DB, false)));

api.post('/locations', ownerOnly, async (c) => {
  const body = await c.req.json<{ code: string; name: string; is_default?: boolean }>();
  if (!body.code?.trim() || !body.name?.trim()) throw new AppError('กรุณากรอกรหัสและชื่อคลัง');
  return c.json(await repo.createLocation(c.env.DB, body.code, body.name, !!body.is_default), 201);
});

api.put('/locations/:id', ownerOnly, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const patch: Record<string, unknown> = { ...body };
  if ('is_default' in body) patch.is_default = body.is_default ? 1 : 0;
  if ('active' in body) patch.active = body.active ? 1 : 0;
  return c.json(await repo.updateLocation(c.env.DB, Number(c.req.param('id')), patch as never));
});

api.delete('/locations/:id', ownerOnly, async (c) => {
  await repo.deleteLocation(c.env.DB, Number(c.req.param('id')));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------- products */

api.get('/products', async (c) => {
  const q = c.req.query('q') ?? '';
  const locationId = c.req.query('locationId') ? Number(c.req.query('locationId')) : undefined;
  const status = (c.req.query('status') as 'all' | 'low' | 'out' | undefined) ?? 'all';
  const requestedLimit = Number(c.req.query('limit') ?? 1000);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 1000) : 1000;
  const products = await repo.listProducts(c.env.DB, { q, locationId, status, limit });
  return c.json(products);
});

api.get('/products/lookup/:code', async (c) => {
  const lookup = await repo.lookupProductByScan(c.env.DB, c.req.param('code'));
  if (!lookup.product) {
    if (lookup.matchedBy === 'ambiguous') {
      return c.json(
        {
          error: 'QR นี้ตรงกับสินค้ามากกว่าหนึ่งรายการ กรุณาค้นหาชื่อหรือรหัสสินค้าแทน',
          candidates: lookup.candidates.map((p) => ({ id: p.id, sku: p.sku, name: p.name })),
        },
        409,
      );
    }
    return c.json({ error: 'ไม่พบสินค้าที่มีรหัสหรือ QR นี้' }, 404);
  }
  const levels = await repo.getLevels(c.env.DB, lookup.product.id);
  return c.json({ product: lookup.product, levels, matchedBy: lookup.matchedBy });
});

api.post('/products/import/preview', ownerOnly, async (c) => {
  // ป้องกันไม่ให้ส่งข้อมูลใหญ่เกินจนทำให้ Worker หรือ D1 รับไม่ไหว
  const contentLength = Number(c.req.header('content-length') ?? 0);
  if (contentLength > 4 * 1024 * 1024) {
    throw new AppError('ไฟล์ใหญ่เกินไป กรุณาแบ่งไฟล์เป็นหลายชุดแล้วนำเข้าทีละชุด', 413);
  }
  const body = await c.req.json<{
    rows?: unknown;
    locationId?: number;
    duplicatePolicy?: repo.ImportDuplicatePolicy;
    filename?: string;
  }>();
  const user = c.get('user');
  const plan = await repo.stageProductImport(
    c.env.DB,
    body.rows,
    { locationId: Number(body.locationId), duplicatePolicy: body.duplicatePolicy },
    { lineUserId: user.lineUserId, name: user.name, source: 'liff' },
    body.filename,
  );
  return c.json(plan);
});

api.post('/products/import', ownerOnly, async (c) => {
  const body = await c.req.json<{ token?: unknown }>();
  if (typeof body.token !== 'string' || !body.token.trim()) {
    throw new AppError('ไม่พบรหัสยืนยันการนำเข้า กรุณาตรวจไฟล์ใหม่');
  }
  const user = c.get('user');
  const result = await repo.commitStagedProductImport(c.env.DB, body.token.trim(), {
    lineUserId: user.lineUserId, name: user.name, source: 'liff',
  });
  return c.json(result);
});

api.get('/products/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const product = await repo.getProduct(c.env.DB, id);
  if (!product) return c.json({ error: 'ไม่พบสินค้า' }, 404);
  const [levels, movements] = await Promise.all([
    repo.getLevels(c.env.DB, id),
    repo.listMovements(c.env.DB, { productId: id, limit: 30 }),
  ]);
  return c.json({ product, levels, movements, total: levels.reduce((s, l) => s + l.qty, 0) });
});

api.post('/products', ownerOnly, async (c) => {
  const body = await c.req.json<Record<string, never>>();
  const product = await repo.createProduct(c.env.DB, body);
  // ตั้งยอดเริ่มต้นถ้าระบุมา
  const initialQty = Number((body as Record<string, unknown>).initial_qty ?? 0);
  const locationId = Number((body as Record<string, unknown>).location_id ?? 0);
  if (initialQty > 0 && locationId) {
    const user = c.get('user');
    await repo.receive(c.env.DB, product.id, locationId, initialQty, 'ยอดยกมาตอนสร้างสินค้า', {
      lineUserId: user.lineUserId, name: user.name, source: 'liff',
    });
  }
  return c.json(product, 201);
});

api.put('/products/:id', ownerOnly, async (c) => {
  const body = await c.req.json<Record<string, never>>();
  return c.json(await repo.updateProduct(c.env.DB, Number(c.req.param('id')), body));
});

api.delete('/products/:id', ownerOnly, async (c) => {
  await repo.archiveProduct(c.env.DB, Number(c.req.param('id')));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------- requests */

/** พนักงานดูคำขอของตัวเองได้ (เจ้าของดูของตัวเองด้้วยวิธีเดียวกัน) */
api.get('/requests/mine', async (c) => {
  const me = c.get('user');
  return c.json(await repo.listRequestsByUser(c.env.DB, me.lineUserId, 30));
});

/** รายการรอจัด — เฉพาะผู้ดูแล */
api.get('/requests', ownerOnly, async (c) => {
  const status = (c.req.query('status') ?? 'pending') as 'pending' | 'all' | 'fulfilled' | 'cancelled';
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 300);
  return c.json(await repo.listRequests(c.env.DB, status, limit));
});

api.post('/requests/:id/fulfill', ownerOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
  const actor = { lineUserId: user.lineUserId, name: user.name, source: 'liff' as const };
  const { request, movement } = await repo.fulfillRequest(
    c.env.DB,
    Number(c.req.param('id')),
    actor,
    body.note ?? null,
  );
  return c.json({ ok: true, request, movement });
});

api.post('/requests/:id/cancel', ownerOnly, async (c) => {
  const user = c.get('user');
  const actor = { lineUserId: user.lineUserId, name: user.name, source: 'liff' as const };
  return c.json({ ok: true, request: await repo.cancelRequest(c.env.DB, Number(c.req.param('id')), actor) });
});

api.post('/requests/fulfill-all', ownerOnly, async (c) => {
  const user = c.get('user');
  const actor = { lineUserId: user.lineUserId, name: user.name, source: 'liff' as const };
  const { done, failed } = await repo.fulfillAllRequests(c.env.DB, actor);
  return c.json({
    ok: failed.length === 0,
    doneCount: done.length,
    failedCount: failed.length,
    failed: failed.map((f) => ({ id: f.request.id, product: f.request.product_name, reason: f.reason })),
  });
});

/* ------------------------------------------------------------ movements */

api.get('/movements', async (c) => {
  const productId = c.req.query('productId') ? Number(c.req.query('productId')) : undefined;
  const locationId = c.req.query('locationId') ? Number(c.req.query('locationId')) : undefined;
  const limit = Math.min(Number(c.req.query('limit') ?? 60), 200);
  return c.json(await repo.listMovements(c.env.DB, { productId, locationId, limit }));
});

api.post('/movements', async (c) => {
  const body = await c.req.json<{
    action: 'issue' | 'receive' | 'adjust' | 'transfer';
    productId: number;
    locationId: number;
    toLocationId?: number;
    qty: number;
    note?: string;
  }>();
  const user = c.get('user');
  // พนักงานสั่งได้แค่ "เบิก" ส่วนรับเข้า / ปรับยอด / ย้ายคลัง เป็นหน้าที่ผู้ดูแลเท่านั้น
  if (body.action !== 'issue') assertOwner(user);
  const actor = { lineUserId: user.lineUserId, name: user.name, source: 'liff' as const };
  const db = c.env.DB;
  const qty = Number(body.qty);
  if (!body.productId || !body.locationId) throw new AppError('ข้อมูลไม่ครบ');
  if (!Number.isFinite(qty)) throw new AppError('จำนวนไม่ถูกต้อง');

  // พนักงานสั่งเบิกจากแดชบอร์ด → เข้ารายการรอผู้ดูแลเหมือนกับที่สั่งในแชท (ยังไม่ตัดสต๊อก)
  if (body.action === 'issue' && user.role !== 'owner') {
    const current = await repo.getQty(db, body.productId, body.locationId);
    const shortNote =
      current < qty
        ? current <= 0
          ? `ของหมดในคลังนี้ (คงเหลือ 0 จากที่ขอ ${fmtQty(qty)})`
          : `ของไม่พอ คงเหลือ ${fmtQty(current)} จากที่ขอ ${fmtQty(qty)}`
        : null;
    const created = await repo.createRequest(db, {
      lineUserId: user.lineUserId,
      userName: user.name,
      productId: body.productId,
      locationId: body.locationId,
      qty,
      note: body.note ?? null,
      shortNote,
    });
    return c.json({ ok: true, asRequest: true, ...created, shortNote, currentQty: current });
  }

  let result;
  switch (body.action) {
    case 'issue':
      result = await repo.issue(db, body.productId, body.locationId, qty, body.note ?? null, actor);
      break;
    case 'receive':
      result = await repo.receive(db, body.productId, body.locationId, qty, body.note ?? null, actor);
      break;
    case 'adjust':
      result = await repo.adjust(db, body.productId, body.locationId, qty, body.note ?? null, actor);
      break;
    case 'transfer':
      if (!body.toLocationId) throw new AppError('กรุณาเลือกคลังปลายทาง');
      result = await repo.transfer(db, body.productId, body.locationId, body.toLocationId, qty, body.note ?? null, actor);
      break;
    default:
      throw new AppError('ประเภทรายการไม่ถูกต้อง');
  }
  const levels = await repo.getLevels(db, body.productId);
  return c.json({ ...result, levels });
});
