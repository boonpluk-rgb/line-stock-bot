import type { Actor, Draft, DraftPayload, DraftStep, Location, MovementType, Product } from '../types';
import { AppError, makeRef, norm, parseNumber } from '../lib/util';

/* ------------------------------------------------------------------ users */

export async function ensureUser(
  db: D1Database,
  lineUserId: string,
  displayName?: string | null,
  pictureUrl?: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (line_user_id, display_name, picture_url)
       VALUES (?, ?, ?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name),
         picture_url  = COALESCE(excluded.picture_url, users.picture_url),
         last_seen_at = datetime('now')`,
    )
    .bind(lineUserId, displayName ?? null, pictureUrl ?? null)
    .run();
}

/* -------------------------------------------------------------- locations */

export async function listLocations(db: D1Database, activeOnly = true): Promise<Location[]> {
  const sql = `SELECT * FROM locations ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY is_default DESC, code`;
  const { results } = await db.prepare(sql).all<Location>();
  return results ?? [];
}

export async function getLocation(db: D1Database, id: number): Promise<Location | null> {
  return db.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first<Location>();
}

export async function defaultLocation(db: D1Database): Promise<Location | null> {
  return db
    .prepare('SELECT * FROM locations WHERE active = 1 ORDER BY is_default DESC, id LIMIT 1')
    .first<Location>();
}

/** หาคลังจากคำที่ผู้ใช้พิมพ์ เช่น "MAIN" หรือ "คลังกลาง" หรือ "หน้าร้าน" */
export async function findLocationByKeyword(db: D1Database, keyword: string): Promise<Location | null> {
  const k = norm(keyword);
  if (!k) return null;
  const all = await listLocations(db, true);
  return (
    all.find((l) => norm(l.code) === k || norm(l.name) === k) ??
    all.find((l) => norm(l.name).includes(k) || norm(l.code).includes(k)) ??
    null
  );
}

export async function createLocation(db: D1Database, code: string, name: string, isDefault = false): Promise<Location> {
  const row = await db
    .prepare('INSERT INTO locations (code, name, is_default) VALUES (?, ?, ?) RETURNING *')
    .bind(code.trim().toUpperCase(), name.trim(), isDefault ? 1 : 0)
    .first<Location>();
  if (isDefault) {
    await db.prepare('UPDATE locations SET is_default = 0 WHERE id != ?').bind(row!.id).run();
  }
  return row!;
}

export async function updateLocation(db: D1Database, id: number, patch: Partial<Location>): Promise<Location | null> {
  const current = await getLocation(db, id);
  if (!current) throw new AppError('ไม่พบคลังที่ต้องการแก้ไข', 404);
  const next = {
    code: (patch.code ?? current.code).trim().toUpperCase(),
    name: (patch.name ?? current.name).trim(),
    is_default: patch.is_default ?? current.is_default,
    active: patch.active ?? current.active,
  };
  await db
    .prepare('UPDATE locations SET code = ?, name = ?, is_default = ?, active = ? WHERE id = ?')
    .bind(next.code, next.name, next.is_default, next.active, id)
    .run();
  if (next.is_default) await db.prepare('UPDATE locations SET is_default = 0 WHERE id != ?').bind(id).run();
  return getLocation(db, id);
}

export async function deleteLocation(db: D1Database, id: number): Promise<void> {
  const used = await db
    .prepare('SELECT COUNT(*) AS c FROM stock_levels WHERE location_id = ? AND qty != 0')
    .bind(id)
    .first<{ c: number }>();
  if ((used?.c ?? 0) > 0) throw new AppError('คลังนี้ยังมีสินค้าคงเหลืออยู่ ย้ายสินค้าออกก่อนจึงจะลบได้');
  await db.prepare('UPDATE locations SET active = 0 WHERE id = ?').bind(id).run();
}

/* --------------------------------------------------------------- products */

export interface ProductWithStock extends Product {
  total_qty: number;
  location_count: number;
}

export async function searchProducts(db: D1Database, query: string, limit = 20): Promise<ProductWithStock[]> {
  const terms = norm(query).split(' ').filter(Boolean).slice(0, 5);
  const where: string[] = ['p.active = 1'];
  const binds: unknown[] = [];
  for (const t of terms) {
    // ใช้ instr() แทน LIKE เพราะ D1 จำกัดความยาว pattern ของ LIKE ไว้ที่ 50 ตัวอักษร
    // ถ้ายาวเกินจะ error "LIKE or GLOB pattern too complex" ทำให้บอทตอบไม่ได้
    where.push('(instr(LOWER(p.name), ?) > 0 OR instr(LOWER(p.sku), ?) > 0 OR instr(LOWER(p.category), ?) > 0 OR p.barcode = ?)');
    binds.push(t, t, t, t);
  }
  const sql = `
    SELECT p.*,
           COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) AS total_qty,
           (SELECT COUNT(*) FROM stock_levels s WHERE s.product_id = p.id AND s.qty > 0) AS location_count
    FROM products p
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE WHEN LOWER(p.name) = ? THEN 0
           WHEN LOWER(p.sku)  = ? THEN 0
           WHEN p.barcode     = ? THEN 0
           WHEN instr(LOWER(p.name), ?) = 1 THEN 1
           ELSE 2 END,
      p.name
    LIMIT ?`;
  const q = norm(query);
  const { results } = await db
    .prepare(sql)
    .bind(...binds, q, q, q, q, limit)
    .all<ProductWithStock>();
  return results ?? [];
}

export async function listProducts(
  db: D1Database,
  opts: { q?: string; locationId?: number; status?: 'all' | 'low' | 'out'; limit?: number } = {},
): Promise<ProductWithStock[]> {
  const limit = opts.limit ?? 200;
  const binds: unknown[] = [];
  const where: string[] = ['p.active = 1'];

  if (opts.q && opts.q.trim()) {
    // instr() แทน LIKE — D1 จำกัด pattern ของ LIKE ไว้ 50 ตัวอักษร (ดู searchProducts)
    where.push('(instr(LOWER(p.name), ?) > 0 OR instr(LOWER(p.sku), ?) > 0 OR instr(LOWER(p.category), ?) > 0 OR instr(p.barcode, ?) > 0)');
    const term = norm(opts.q);
    binds.push(term, term, term, term);
  }

  const qtyExpr = opts.locationId
    ? 'COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id AND s.location_id = ?), 0)'
    : 'COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0)';
  const qtyBinds = opts.locationId ? [opts.locationId] : [];

  let having = '';
  if (opts.status === 'low') having = `HAVING total_qty > 0 AND total_qty <= p.min_qty`;
  else if (opts.status === 'out') having = `HAVING total_qty <= 0`;

  const sql = `
    SELECT p.*, ${qtyExpr} AS total_qty,
           (SELECT COUNT(*) FROM stock_levels s WHERE s.product_id = p.id AND s.qty > 0) AS location_count
    FROM products p
    WHERE ${where.join(' AND ')}
    GROUP BY p.id
    ${having}
    ORDER BY p.name
    LIMIT ?`;

  // ลำดับ bind: qtyExpr อยู่ใน SELECT จึงมาก่อน WHERE
  const { results } = await db.prepare(sql).bind(...qtyBinds, ...binds, limit).all<ProductWithStock>();
  return results ?? [];
}

export async function getProduct(db: D1Database, id: number): Promise<Product | null> {
  return db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Product>();
}

export async function getProductByBarcode(db: D1Database, barcode: string): Promise<Product | null> {
  return db
    .prepare('SELECT * FROM products WHERE (barcode = ? OR sku = ?) AND active = 1')
    .bind(barcode.trim(), barcode.trim())
    .first<Product>();
}

export interface ProductScanLookup {
  product: Product | null;
  candidates: Product[];
  matchedBy: 'barcode' | 'sku' | 'legacy' | 'ambiguous' | 'none';
}

/**
 * อ่าน QR ได้ทั้งแบบใหม่ (SKU) และแบบเดิมที่เก็บข้อความเป็น
 * หมวดหมู่-รหัสสินค้า-ชื่อสินค้า  รวมถึง SKU ที่ถูกต่อท้ายด้วย -2, -3
 */
function extractLegacySku(value: string): string[] {
  const found = new Set<string>();
  const upper = value.toUpperCase();
  // รูปแบบเดิมมีทั้งรหัส 88500000-... และรหัสสั้น เช่น ABC-001
  // เก็บ substring ที่มีอย่างน้อยสองช่วงคั่นด้วย - แล้วลองช่วยย่อยทีละช่วง
  // เพื่อให้ชื่อสินค้าที่เป็นภาษาอังกฤษหรือมีเครื่องหมายคั่นไม่ทำให้หา SKU ไม่เจอ
  const re = /(?:^|[^A-Z0-9])((?:[A-Z0-9]+-)+[A-Z0-9]+)(?=$|[^A-Z0-9])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(upper))) {
    const parts = match[1].split('-');
    if (parts.length < 2) continue;
    for (let start = 0; start < parts.length - 1; start += 1) {
      for (let end = start + 1; end < parts.length; end += 1) {
        const candidate = parts.slice(start, end + 1).join('-');
        if (candidate.length > 80) continue;
        const hasLetter = /[A-Z]/.test(candidate);
        // รหัสตัวเลขล้วนต้องมีขีดคั่นอย่างน้อยหนึ่งจุด ไม่งั้นจะไปตรงกับเลขสุ่มในชื่อสินค้า
        const hasNumber = /\d/.test(candidate);
        const numericParts = candidate.split('-').filter((part) => part !== '');
        const allNumeric = numericParts.length >= 2 && numericParts.every((part) => /^\d+$/.test(part));
        if (hasNumber && (hasLetter || allNumeric)) found.add(candidate);
      }
    }
  }
  return [...found];
}

function scanText(value: string): string {
  return norm(value.replace(/[–—_]/g, ' ').replace(/[-\s]+/g, ' ').trim());
}

export async function lookupProductByScan(db: D1Database, raw: string): Promise<ProductScanLookup> {
  const value = raw.trim();
  if (!value) return { product: null, candidates: [], matchedBy: 'none' };

  const exact = await db
    .prepare(
      `SELECT * FROM products
       WHERE active = 1 AND (barcode = ? COLLATE NOCASE OR sku = ? COLLATE NOCASE)
       ORDER BY CASE WHEN barcode = ? COLLATE NOCASE THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(value, value, value)
    .first<Product>();
  if (exact) {
    return {
      product: exact,
      candidates: [exact],
      matchedBy: exact.barcode?.toLowerCase() === value.toLowerCase() ? 'barcode' : 'sku',
    };
  }

  for (const legacySku of extractLegacySku(value)) {
    const exactLegacy = await db
      .prepare('SELECT * FROM products WHERE active = 1 AND sku = ? COLLATE NOCASE LIMIT 1')
      .bind(legacySku)
      .first<Product>();
    const upper = value.toUpperCase();
    const foundAt = upper.indexOf(legacySku);
    const suffix = foundAt >= 0 ? value.slice(foundAt + legacySku.length).replace(/^[\s\-–—_:]+/, '').trim() : '';
    // ถ้าเป็นรหัสตรง ๆ ให้ใช้ผลตรงทันที ส่วน QR รุ่นเก่าที่มีชื่อต่อท้าย
    // ต้องตรวจรหัสต่อท้ายด้วย เพื่อเลือกสินค้าที่ซ้ำได้ถูกตัว
    if (exactLegacy && !suffix) return { product: exactLegacy, candidates: [exactLegacy], matchedBy: 'legacy' };

    const { results = [] } = await db
      .prepare(
        `SELECT * FROM products
         WHERE active = 1
           AND (
             sku = ? COLLATE NOCASE
             OR (
               substr(sku, 1, length(?)) = ? COLLATE NOCASE
               AND substr(sku, length(?) + 1, 1) = '-'
             )
           )
         ORDER BY sku`,
      )
      .bind(legacySku, legacySku, legacySku, legacySku)
      .all<Product>();
    if (results.length === 0) continue;

    if (results.length === 1) return { product: results[0], candidates: results, matchedBy: 'legacy' };

    // QR รุ่นเก่ามีชื่อสินค้าต่อท้าย ใช้ชื่อช่วยเลือกเมื่อรหัสซ้ำ
    const wanted = scanText(suffix);
    const named = results.filter((p) => {
      const name = scanText(p.name);
      return wanted === name || wanted.endsWith(` ${name}`) || name.endsWith(` ${wanted}`);
    });
    if (named.length === 1) return { product: named[0], candidates: named, matchedBy: 'legacy' };
    return { product: null, candidates: results, matchedBy: 'ambiguous' };
  }

  return { product: null, candidates: [], matchedBy: 'none' };
}

export async function createProduct(db: D1Database, input: Partial<Product>): Promise<Product> {
  if (!input.name?.trim()) throw new AppError('กรุณาระบุชื่อสินค้า');
  const sku = input.sku?.trim() || (await nextSku(db));
  const dup = await db.prepare('SELECT id FROM products WHERE sku = ?').bind(sku).first();
  if (dup) throw new AppError(`รหัสสินค้า ${sku} ถูกใช้ไปแล้ว`);
  if (input.barcode?.trim()) {
    const dupBc = await db.prepare('SELECT id FROM products WHERE barcode = ?').bind(input.barcode.trim()).first();
    if (dupBc) throw new AppError(`บาร์โค้ด ${input.barcode.trim()} ถูกใช้ไปแล้ว`);
  }
  const row = await db
    .prepare(
      `INSERT INTO products (sku, barcode, name, category, unit, min_qty, note)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      sku,
      input.barcode?.trim() || null,
      input.name.trim(),
      input.category?.trim() || null,
      input.unit?.trim() || 'ชิ้น',
      Number(input.min_qty ?? 0),
      input.note?.trim() || null,
    )
    .first<Product>();
  return row!;
}

async function nextSku(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM products").first<{ c: number }>();
  return `SKU-${String((row?.c ?? 0) + 1).padStart(4, '0')}`;
}

export async function updateProduct(db: D1Database, id: number, patch: Partial<Product>): Promise<Product | null> {
  const current = await getProduct(db, id);
  if (!current) throw new AppError('ไม่พบสินค้า', 404);
  const barcode = patch.barcode !== undefined ? patch.barcode?.trim() || null : current.barcode;
  if (barcode && barcode !== current.barcode) {
    const dup = await db.prepare('SELECT id FROM products WHERE barcode = ? AND id != ?').bind(barcode, id).first();
    if (dup) throw new AppError(`บาร์โค้ด ${barcode} ถูกใช้ไปแล้ว`);
  }
  await db
    .prepare(
      `UPDATE products SET sku = ?, barcode = ?, name = ?, category = ?, unit = ?, min_qty = ?, note = ?, active = ?,
         updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(
      (patch.sku ?? current.sku).trim(),
      barcode,
      (patch.name ?? current.name).trim(),
      patch.category !== undefined ? patch.category?.trim() || null : current.category,
      (patch.unit ?? current.unit).trim(),
      Number(patch.min_qty ?? current.min_qty),
      patch.note !== undefined ? patch.note?.trim() || null : current.note,
      patch.active ?? current.active,
      id,
    )
    .run();
  return getProduct(db, id);
}

export async function archiveProduct(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
}

/* ------------------------------------------------------------ bulk import */

export type ImportDuplicatePolicy = 'suffix' | 'skip' | 'error';
export type ImportAction = 'create' | 'update' | 'unchanged' | 'skip' | 'error';

export interface ImportOptions {
  locationId: number;
  duplicatePolicy?: ImportDuplicatePolicy;
}

export interface ImportPlanRow {
  rowNumber: number;
  inputSku: string;
  sku: string;
  name: string;
  category: string | null;
  unit: string | null;
  minQty: number;
  stockQty: number;
  barcode: string | null;
  note: string | null;
  action: ImportAction;
  reason: string;
  renamed: boolean;
  existingId: number | null;
  existingUpdatedAt: string | null;
  currentQty: number;
  delta: number;
}

export interface ImportPlanSummary {
  totalRows: number;
  createCount: number;
  updateCount: number;
  unchangedCount: number;
  skippedCount: number;
  errorCount: number;
  renamedCount: number;
  movementCount: number;
  totalTargetQty: number;
}

export interface ImportPlan {
  location: Pick<Location, 'id' | 'code' | 'name'>;
  duplicatePolicy: ImportDuplicatePolicy;
  rows: ImportPlanRow[];
  summary: ImportPlanSummary;
  canCommit: boolean;
}

export interface ImportCommitResult {
  ref: string | null;
  totalRows: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  renamed: number;
  movements: number;
  totalTargetQty: number;
}

interface NormalizedImportRow {
  rowNumber: number;
  inputSku: string;
  sku: string;
  name: string;
  category: string | null;
  unit: string | null;
  minQty: number;
  stockQty: number;
  barcode: string | null;
  note: string | null;
  error: string | null;
  duplicateSkipped: boolean;
  ignoredNonProduct: boolean;
  renamed: boolean;
}

interface ExistingImportProduct extends Product {
  current_qty: number;
}

const IMPORT_MAX_ROWS = 1000;
// เผื่อพื้นที่จากข้อจำกัดขนาดข้อความของ D1 (ประมาณ 2 MB ต่อแถว) โดยลดลงอีกครึ่งหนึ่ง
const IMPORT_MAX_DRAFT_BYTES = 900_000;
const IMPORT_MAX_NAME = 200;
const IMPORT_MAX_UNIT = 40;
const IMPORT_MAX_CATEGORY = 100;
const IMPORT_MAX_NOTE = 500;
const IMPORT_MAX_BARCODE = 80;

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}
// แบ่งเป็นชุดเล็กเพื่อให้ทุกชุดอยู่ในข้อจำกัด 100 KB และมีจำนวน query ไม่เกิน 50
// (ทั้งหมดยังอยู่ใน db.batch เดียวกัน จึง rollback พร้อมกันทั้งไฟล์)
const IMPORT_CHUNK_SIZE = 75;
const IMPORT_QTY_EPSILON = 0.000001;

function importText(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

function importNumber(value: unknown, field: string, rowNumber: number): { value: number; error: string | null } {
  const text = importText(value);
  if (!text) return { value: 0, error: null };
  const parsed = parseNumber(text.replace(/\s+/g, ''));
  if (parsed === null || !Number.isFinite(parsed)) {
    return { value: 0, error: `แถว ${rowNumber}: คอลัมน์ ${field} ไม่ใช่จำนวน` };
  }
  if (parsed < 0) return { value: 0, error: `แถว ${rowNumber}: ${field} ติดลบไม่ได้` };
  if (parsed > 1_000_000_000) return { value: 0, error: `แถว ${rowNumber}: ${field} มีจำนวนมากเกินไป` };
  return { value: Math.round(parsed * 1000) / 1000, error: null };
}

function normalizeImportRows(input: unknown, policy: ImportDuplicatePolicy): NormalizedImportRow[] {
  if (!Array.isArray(input)) throw new AppError('ข้อมูลไฟล์ไม่ถูกต้อง');
  if (input.length === 0) throw new AppError('ไม่พบรายการสินค้าในไฟล์');
  if (input.length > IMPORT_MAX_ROWS) {
    throw new AppError(`นำเข้าได้ไม่เกิน ${IMPORT_MAX_ROWS.toLocaleString('th-TH')} แถวต่อครั้ง`);
  }

  const rows: NormalizedImportRow[] = input.map((value, index) => {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const rowNumberValue = Number(raw.rowNumber);
    const rowNumber = Number.isInteger(rowNumberValue) && rowNumberValue > 0 ? rowNumberValue : index + 2;
    const inputSku = importText(raw.sku ?? raw.SKU ?? raw.id).toUpperCase();
    const name = importText(raw.name ?? raw.product_name ?? raw.product);
    const category = importText(raw.category) || null;
    const unit = importText(raw.unit) || null;
    const barcode = importText(raw.barcode) || null;
    const note = importText(raw.note) || null;
    const minResult = importNumber(raw.min_qty ?? raw.minQty, 'จุดสั่งซื้อขั้นต่ำ', rowNumber);
    const stockInput = raw.stock_qty ?? raw.stockQty ?? raw.qty;
    const hasStock = stockInput !== undefined;
    const stockResult = hasStock
      ? importNumber(stockInput, 'จำนวนคงเหลือในคลัง', rowNumber)
      : { value: 0, error: `แถว ${rowNumber}: ไม่พบคอลัมน์จำนวนคงเหลือในคลัง` };

    // ไฟล์บางชนิดมีแถวผลรวม/หัวข้อระหว่างชีต แม้ไม่มี SKU หรือชื่อสินค้า
    // แต่มียอดหรือสูตรของแถวรวม จึงไม่ควรถูกนำเข้าเป็นสินค้า
    // แถวที่มีข้อมูลสินค้าอื่นอย่างชัดเจนจะยังถูกตรวจพบว่าขาดรหัส/ชื่อตามปกติ
    const stockText = importText(stockInput);
    const minText = importText(raw.min_qty ?? raw.minQty);
    const ignoredNonProduct =
      !inputSku &&
      !name &&
      !category &&
      !unit &&
      !barcode &&
      !note &&
      stockText !== '' &&
      stockResult.error === null &&
      (minText === '' || (minResult.error === null && minResult.value >= 0));

    const errors = [minResult.error, stockResult.error].filter((v): v is string => !!v);
    if (!ignoredNonProduct) {
      if (!inputSku) errors.push(`แถว ${rowNumber}: ไม่พบรหัสสินค้า`);
      if (!name) errors.push(`แถว ${rowNumber}: ไม่พบชื่อสินค้า`);
    }
    if (inputSku.length > 80) errors.push(`แถว ${rowNumber}: รหัสสินค้ายาวเกิน 80 ตัวอักษร`);
    if (name.length > IMPORT_MAX_NAME) errors.push(`แถว ${rowNumber}: ชื่อสินค้ายาวเกิน ${IMPORT_MAX_NAME} ตัวอักษร`);
    if (category && category.length > IMPORT_MAX_CATEGORY) {
      errors.push(`แถว ${rowNumber}: หมวดหมู่ยาวเกิน ${IMPORT_MAX_CATEGORY} ตัวอักษร`);
    }
    if (unit && unit.length > IMPORT_MAX_UNIT) errors.push(`แถว ${rowNumber}: หน่วยยาวเกิน ${IMPORT_MAX_UNIT} ตัวอักษร`);
    if (barcode && barcode.length > IMPORT_MAX_BARCODE) {
      errors.push(`แถว ${rowNumber}: บาร์โค้ดยาวเกิน ${IMPORT_MAX_BARCODE} ตัวอักษร`);
    }
    if (note && note.length > IMPORT_MAX_NOTE) errors.push(`แถว ${rowNumber}: หมายเหตุยาวเกิน ${IMPORT_MAX_NOTE} ตัวอักษร`);

    return {
      rowNumber,
      inputSku,
      sku: inputSku,
      name,
      category,
      unit,
      minQty: minResult.value,
      stockQty: stockResult.value,
      barcode,
      note,
      error: errors.length ? errors.join(' · ') : null,
      duplicateSkipped: false,
      ignoredNonProduct,
      renamed: false,
    };
  });

  // สงวนชื่อ SKU ที่มีอยู่ในไฟล์ไว้ก่อน เพื่อไม่ให้การเติม -2 ไปชนกับ SKU จริงที่มีอยู่แล้ว
  const reserved = new Set(rows.filter((r) => !r.error && !r.ignoredNonProduct && r.inputSku).map((r) => r.inputSku));
  const seen = new Map<string, number>();
  const used = new Set<string>();
  for (const row of rows) {
    if (row.error || row.ignoredNonProduct || !row.inputSku) continue;
    const count = (seen.get(row.inputSku) ?? 0) + 1;
    seen.set(row.inputSku, count);

    if (count > 1 && policy === 'error') {
      row.error = `แถว ${row.rowNumber}: รหัส ${row.inputSku} ซ้ำในไฟล์ (เลือกวิธีจัดการรหัสซ้ำ)`;
      continue;
    }
    if (count > 1 && policy === 'skip') {
      row.duplicateSkipped = true;
      row.sku = row.inputSku;
      continue;
    }

    if (count === 1) {
      row.sku = row.inputSku;
    } else {
      let suffix = 2;
      let candidate = `${row.inputSku}-${suffix}`;
      while (reserved.has(candidate) || used.has(candidate)) {
        suffix += 1;
        candidate = `${row.inputSku}-${suffix}`;
      }
      row.sku = candidate;
      row.renamed = true;
    }
    used.add(row.sku);
  }
  return rows;
}

/**
 * ถ้า SKU ซ้ำในไฟล์และต้องเติม -2, -3 ให้ข้าม SKU ที่มีอยู่ในฐานข้อมูลด้วย
 * เพื่อไม่ให้รหัสที่ระบบสร้างไปอัปเดตสินค้าเดิมโดยไม่ตั้งใจ
 */
async function avoidExistingImportSkuCollisions(db: D1Database, rows: NormalizedImportRow[]): Promise<void> {
  const renamedRows = rows.filter((row) => row.renamed && !row.error && !row.ignoredNonProduct && !row.duplicateSkipped);
  if (!renamedRows.length) return;

  const baseSkus = [...new Set(renamedRows.map((row) => row.inputSku))];
  const existing = await db
    .prepare(
      `SELECT DISTINCT p.sku
       FROM products p
       JOIN json_each(?) AS b
       ON p.sku COLLATE NOCASE = b.value COLLATE NOCASE
          OR (
            substr(p.sku, 1, length(b.value)) = b.value COLLATE NOCASE
            AND substr(p.sku, length(b.value) + 1, 1) = '-'
          )`,
    )
    .bind(JSON.stringify(baseSkus))
    .all<{ sku: string }>();
  const existingSkus = new Set((existing.results ?? []).map((row) => row.sku.toUpperCase()));
  if (!existingSkus.size) return;

  // ชื่อ SKU ที่มีอยู่ในไฟล์เอง ต้องถูกสงวนไว้ก่อนเช่นกัน
  const reservedInputSkus = new Set(
    rows.filter((row) => !row.error && !row.ignoredNonProduct && row.inputSku).map((row) => row.inputSku.toUpperCase()),
  );
  const usedSkus = new Set(
    rows.filter((row) => !row.error && !row.ignoredNonProduct && !row.duplicateSkipped && !row.renamed).map((row) => row.sku.toUpperCase()),
  );

  for (const row of renamedRows) {
    const match = row.sku.match(/^(.*)-(\d+)$/);
    let suffix = match && match[1] === row.inputSku ? Number(match[2]) : 2;
    if (!Number.isInteger(suffix) || suffix < 2) suffix = 2;
    let candidate = `${row.inputSku}-${suffix}`;
    while (existingSkus.has(candidate.toUpperCase()) || usedSkus.has(candidate.toUpperCase()) || reservedInputSkus.has(candidate.toUpperCase())) {
      suffix += 1;
      candidate = `${row.inputSku}-${suffix}`;
    }
    row.sku = candidate;
    usedSkus.add(candidate.toUpperCase());
  }
}

async function lookupImportProducts(
  db: D1Database,
  locationId: number,
  rows: NormalizedImportRow[],
): Promise<{ bySku: Map<string, ExistingImportProduct>; barcodeOwners: Map<string, Product> }> {
  const eligible = rows.filter((r) => !r.error && !r.ignoredNonProduct && !r.duplicateSkipped);
  const bySku = new Map<string, ExistingImportProduct>();
  const barcodeOwners = new Map<string, Product>();
  if (eligible.length === 0) return { bySku, barcodeOwners };

  const payload = JSON.stringify(eligible.map((row) => ({ sku: row.sku, barcode: row.barcode })));
  const existing = await db
    .prepare(
      `SELECT p.*, COALESCE(s.qty, 0) AS current_qty
       FROM products p
       JOIN json_each(?) AS j
         ON p.sku COLLATE NOCASE = json_extract(j.value, '$.sku') COLLATE NOCASE
       LEFT JOIN stock_levels s
         ON s.product_id = p.id AND s.location_id = ?`,
    )
    .bind(payload, locationId)
    .all<ExistingImportProduct>();
  for (const row of existing.results ?? []) bySku.set(row.sku.toUpperCase(), row);

  const barcodes = eligible.filter((r) => r.barcode).map((r) => ({ barcode: r.barcode }));
  if (barcodes.length) {
    const owners = await db
      .prepare(
        `SELECT p.*
         FROM products p
         JOIN json_each(?) AS j
           ON p.barcode COLLATE NOCASE = json_extract(j.value, '$.barcode') COLLATE NOCASE`,
      )
      .bind(JSON.stringify(barcodes))
      .all<Product>();
    for (const row of owners.results ?? []) barcodeOwners.set(row.barcode!.toUpperCase(), row);
  }
  return { bySku, barcodeOwners };
}

function nullableNorm(value: string | null): string {
  return value ? norm(value) : '';
}

function importChangedFields(existing: Product, row: NormalizedImportRow): string[] {
  const changed: string[] = [];
  if (existing.name !== row.name) changed.push('ชื่อสินค้า');
  if (row.category !== null && nullableNorm(existing.category) !== nullableNorm(row.category)) changed.push('หมวดหมู่');
  if (row.unit !== null && nullableNorm(existing.unit) !== nullableNorm(row.unit)) changed.push('หน่วย');
  if (Number(existing.min_qty) !== row.minQty) changed.push('จุดสั่งซื้อ');
  if (row.barcode !== null && nullableNorm(existing.barcode) !== nullableNorm(row.barcode)) changed.push('บาร์โค้ด');
  if (row.note !== null && nullableNorm(existing.note) !== nullableNorm(row.note)) changed.push('หมายเหตุ');
  return changed;
}

export async function previewProductImport(
  db: D1Database,
  input: unknown,
  options: ImportOptions,
): Promise<ImportPlan> {
  const locationId = Number(options.locationId);
  if (!Number.isInteger(locationId) || locationId <= 0) throw new AppError('กรุณาเลือกคลังที่จะรับยอดยกมา');
  const location = await getLocation(db, locationId);
  if (!location || !location.active) throw new AppError('ไม่พบคลังที่เลือก หรือคลังถูกปิดใช้งาน');

  const policy = options.duplicatePolicy ?? 'suffix';
  if (!['suffix', 'skip', 'error'].includes(policy)) throw new AppError('วิธีจัดการรหัสสินค้าซ้ำไม่ถูกต้อง');
  const normalized = normalizeImportRows(input, policy);
  await avoidExistingImportSkuCollisions(db, normalized);
  const { bySku, barcodeOwners } = await lookupImportProducts(db, locationId, normalized);

  const inputBarcodeCounts = new Map<string, number>();
  for (const row of normalized) {
    if (!row.error && !row.ignoredNonProduct && !row.duplicateSkipped && row.barcode) {
      const key = row.barcode.toUpperCase();
      inputBarcodeCounts.set(key, (inputBarcodeCounts.get(key) ?? 0) + 1);
    }
  }

  const planRows: ImportPlanRow[] = normalized.map((row) => {
    const base: ImportPlanRow = {
      rowNumber: row.rowNumber,
      inputSku: row.inputSku,
      sku: row.sku,
      name: row.name,
      category: row.category,
      unit: row.unit,
      minQty: row.minQty,
      stockQty: row.stockQty,
      barcode: row.barcode,
      note: row.note,
      action: 'error',
      reason: row.error ?? '',
      renamed: row.renamed,
      existingId: null,
      existingUpdatedAt: null,
      currentQty: 0,
      delta: 0,
    };
    if (row.error) return base;
    if (row.ignoredNonProduct) {
      return { ...base, action: 'skip', reason: 'แถวสรุป/หัวข้อที่ไม่มีรหัสและชื่อสินค้า — ข้ามอัตโนมัติ' };
    }
    if (row.duplicateSkipped) {
      return { ...base, action: 'skip', reason: 'รหัสซ้ำในไฟล์ — ข้ามตามที่เลือก' };
    }

    if (row.barcode) {
      const key = row.barcode.toUpperCase();
      if ((inputBarcodeCounts.get(key) ?? 0) > 1) {
        return { ...base, reason: `บาร์โค้ด ${row.barcode} ซ้ำในไฟล์` };
      }
      const owner = barcodeOwners.get(key);
      if (owner && owner.sku.toUpperCase() !== row.sku.toUpperCase()) {
        return { ...base, reason: `บาร์โค้ดนี้ถูกใช้กับสินค้า ${owner.sku} แล้ว` };
      }
    }

    const existing = bySku.get(row.sku.toUpperCase());
    if (existing && !existing.active) {
      return { ...base, sku: existing.sku, existingId: existing.id, reason: 'รหัสนี้อยู่ในรายการที่ซ่อนอยู่ กรุณาใช้รหัสใหม่หรือเปิดใช้งานสินค้าเดิมก่อน' };
    }

    // เก็บเคส SKU เดิมที่ใช้ตัวพิมพ์เล็ก/ใหญ่ผสมกัน ให้ upsert ชนแถวเดิมจริง
    const resolvedBase = existing ? { ...base, sku: existing.sku } : base;
    if (!existing) {
      return {
        ...resolvedBase,
        action: 'create',
        reason: row.renamed ? `รหัสซ้ำในไฟล์ — ใช้ ${row.sku} แทน` : 'จะเพิ่มสินค้าใหม่',
        delta: row.stockQty,
      };
    }

    const currentQty = Number(existing.current_qty) || 0;
    const delta = Math.round((row.stockQty - currentQty) * 1000) / 1000;
    const changed = importChangedFields(existing, row);
    const hasStockChange = Math.abs(delta) > IMPORT_QTY_EPSILON;
    const action: ImportAction = changed.length || hasStockChange ? 'update' : 'unchanged';
    const reasons: string[] = [];
    if (changed.length) reasons.push(`แก้ ${changed.join(', ')}`);
    if (hasStockChange) reasons.push(delta > 0 ? `เพิ่มยอด ${delta}` : `ลดยอด ${Math.abs(delta)}`);
    return {
      ...resolvedBase,
      action,
      reason: reasons.length ? reasons.join(' · ') : 'ข้อมูลตรงกับที่มีอยู่แล้ว',
      existingId: existing.id,
      existingUpdatedAt: existing.updated_at,
      currentQty,
      delta,
    };
  });

  const count = (action: ImportAction) => planRows.filter((row) => row.action === action).length;
  const summary: ImportPlanSummary = {
    totalRows: planRows.length,
    createCount: count('create'),
    updateCount: count('update'),
    unchangedCount: count('unchanged'),
    skippedCount: count('skip'),
    errorCount: count('error'),
    renamedCount: planRows.filter((row) => row.renamed).length,
    movementCount: planRows.filter(
      (row) => (row.action === 'create' || row.action === 'update') && Math.abs(row.delta) > IMPORT_QTY_EPSILON,
    ).length,
    totalTargetQty: Math.round(
      planRows
        .filter((row) => row.action !== 'error' && row.action !== 'skip')
        .reduce((sum, row) => sum + row.stockQty, 0) * 1000,
    ) / 1000,
  };
  return {
    location: { id: location.id, code: location.code, name: location.name },
    duplicatePolicy: policy,
    rows: planRows,
    summary,
    canCommit: summary.errorCount === 0,
  };
}

export interface StagedImportPlan extends ImportPlan {
  token: string | null;
  expiresAt: number | null;
}

export interface ProductImportDraft {
  id: number;
  token: string;
  actor_line_id: string;
  location_id: number;
  duplicate_policy: ImportDuplicatePolicy;
  filename: string | null;
  payload: string;
  plan_json: string;
  status: 'preview' | 'committing' | 'committed' | 'cancelled';
  ref: string | null;
  result_json: string | null;
  expires_at: number;
}

/**
 * เก็บผล preview ไว้ใน D1 เพื่อให้ปุ่มยืนยันส่งกลับเพียง token
 * ไม่ใช้ข้อมูลจากเบราว์เซอร์ที่อาจถูกแก้หลังจากผู้ใช้ตรวจแล้ว
 */
export async function stageProductImport(
  db: D1Database,
  input: unknown,
  options: ImportOptions,
  actor: Actor,
  filename?: string | null,
): Promise<StagedImportPlan> {
  const plan = await previewProductImport(db, input, options);
  if (!plan.canCommit) return { ...plan, token: null, expiresAt: null };

  const payloadRows = plan.rows
    .filter((row) => row.action === 'create' || row.action === 'update')
    .map((row) => ({
      sku: row.sku,
      barcode: row.barcode,
      name: row.name,
      category: row.category,
      unit: row.unit,
      min_qty: row.minQty,
      note: row.note,
      stock_qty: row.stockQty,
      is_new: row.action === 'create' ? 1 : 0,
      expected_id: row.existingId,
      expected_qty: row.currentQty,
      expected_updated_at: row.existingUpdatedAt,
    }));
  const token = `IMP-${crypto.randomUUID()}`;
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const payloadJson = JSON.stringify(payloadRows);
  const planJson = JSON.stringify(plan);
  // D1 จำกัดขนาดข้อความในหนึ่งแถว จึงต้องกันไว้ก่อนบันทึก ไม่ให้ผู้ใช้เจอ error กลาง ๆ
  if (utf8Size(payloadJson) + utf8Size(planJson) > IMPORT_MAX_DRAFT_BYTES) {
    throw new AppError(
      `ไฟล์นี้ใหญ่เกินไปสำหรับการนำเข้าพร้อมกัน (สูงสุด ${Math.floor(IMPORT_MAX_DRAFT_BYTES / 1024).toLocaleString('th-TH')} KB) กรุณาแบ่งไฟล์เป็นหลายชุด`,
      413,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    // ร่างเก่าของผู้ใช้คนเดิมไม่ต้องเก็บไว้ เพราะจะยกเลิกไปเมื่อมีการตรวจไฟล์ใหม่
    db
      .prepare(
        `UPDATE product_import_drafts SET status = 'cancelled'
         WHERE actor_line_id = ? AND status = 'preview'`,
      )
      .bind(actor.lineUserId),
    // เก็บกวาดร่างที่หมดอายุ และผลของรายการเก่าที่ยืนยันเสร็จแล้วเกิน 7 วัน
    db
      .prepare(
        `DELETE FROM product_import_drafts
         WHERE (status <> 'committed' AND expires_at < ?)
            OR (status = 'committed' AND committed_at IS NOT NULL AND committed_at < datetime('now', '-7 days'))`,
      )
      .bind(now),
  ]);
  await db
    .prepare(
      `INSERT INTO product_import_drafts
        (token, actor_line_id, location_id, duplicate_policy, filename, payload, plan_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      token,
      actor.lineUserId,
      plan.location.id,
      plan.duplicatePolicy,
      filename ? filename.slice(0, 255) : null,
      payloadJson,
      planJson,
      expiresAt,
    )
    .run();
  return { ...plan, token, expiresAt };
}

async function getProductImportDraft(db: D1Database, token: string, actorLineId: string): Promise<ProductImportDraft | null> {
  return db
    .prepare('SELECT * FROM product_import_drafts WHERE token = ? AND actor_line_id = ? LIMIT 1')
    .bind(token, actorLineId)
    .first<ProductImportDraft>();
}

const STAGED_GUARD_SQL = `
  UPDATE product_import_drafts
  SET status = 'committing'
  WHERE id = ? AND token = ? AND actor_line_id = ?
    AND status = 'preview' AND expires_at >= ?
    AND EXISTS (SELECT 1 FROM locations l WHERE l.id = product_import_drafts.location_id AND l.active = 1)
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(product_import_drafts.payload) j
      LEFT JOIN products p
        ON p.sku COLLATE NOCASE = json_extract(j.value, '$.sku') COLLATE NOCASE
      LEFT JOIN stock_levels s
        ON s.product_id = p.id AND s.location_id = product_import_drafts.location_id
      WHERE
        (json_extract(j.value, '$.expected_id') IS NULL AND p.id IS NOT NULL)
        OR (
          json_extract(j.value, '$.expected_id') IS NOT NULL
          AND (
            p.id IS NULL
            OR p.id != CAST(json_extract(j.value, '$.expected_id') AS INTEGER)
            OR p.active != 1
            OR ABS(COALESCE(s.qty, 0) - CAST(json_extract(j.value, '$.expected_qty') AS REAL)) > ${IMPORT_QTY_EPSILON}
            OR p.updated_at IS NOT json_extract(j.value, '$.expected_updated_at')
          )
        )
        OR EXISTS (
          SELECT 1 FROM products bc
          WHERE json_extract(j.value, '$.barcode') IS NOT NULL
            AND bc.barcode COLLATE NOCASE = json_extract(j.value, '$.barcode') COLLATE NOCASE
            AND (
              json_extract(j.value, '$.expected_id') IS NULL
              OR bc.id != CAST(json_extract(j.value, '$.expected_id') AS INTEGER)
            )
        )
    )
`;

const STAGED_PRODUCT_UPSERT_SQL = `
  INSERT INTO products (sku, barcode, name, category, unit, min_qty, note)
  SELECT
    json_extract(j.value, '$.sku'),
    json_extract(j.value, '$.barcode'),
    json_extract(j.value, '$.name'),
    json_extract(j.value, '$.category'),
    COALESCE(json_extract(j.value, '$.unit'), 'ชิ้น'),
    CAST(COALESCE(json_extract(j.value, '$.min_qty'), 0) AS REAL),
    json_extract(j.value, '$.note')
  FROM json_each(?) AS j
  JOIN product_import_drafts AS i
    ON i.token = ? AND i.actor_line_id = ? AND i.status = 'committing'
  WHERE 1
  ON CONFLICT(sku) DO UPDATE SET
    barcode = COALESCE(excluded.barcode, products.barcode),
    name = excluded.name,
    category = COALESCE(excluded.category, products.category),
    unit = COALESCE(excluded.unit, products.unit),
    min_qty = excluded.min_qty,
    note = COALESCE(excluded.note, products.note),
    active = 1,
    updated_at = datetime('now')
`;

const STAGED_MOVEMENT_SQL = `
  INSERT INTO movements
    (ref, type, product_id, location_id, qty, delta, balance_after, note, actor_line_id, actor_name, source)
  SELECT
    ?,
    CASE WHEN CAST(json_extract(j.value, '$.is_new') AS INTEGER) = 1 THEN 'receive' ELSE 'adjust' END,
    p.id,
    i.location_id,
    ABS(CAST(json_extract(j.value, '$.stock_qty') AS REAL) - COALESCE(s.qty, 0)),
    CAST(json_extract(j.value, '$.stock_qty') AS REAL) - COALESCE(s.qty, 0),
    CAST(json_extract(j.value, '$.stock_qty') AS REAL),
    'นำเข้าไฟล์ Excel/CSV',
    ?, ?, ?
  FROM json_each(?) AS j
  JOIN product_import_drafts AS i
    ON i.token = ? AND i.actor_line_id = ? AND i.status = 'committing'
  JOIN products p
    ON p.sku COLLATE NOCASE = json_extract(j.value, '$.sku') COLLATE NOCASE
  LEFT JOIN stock_levels s
    ON s.product_id = p.id AND s.location_id = i.location_id
  WHERE ABS(CAST(json_extract(j.value, '$.stock_qty') AS REAL) - COALESCE(s.qty, 0)) > ${IMPORT_QTY_EPSILON}
`;

const STAGED_STOCK_SQL = `
  INSERT INTO stock_levels (product_id, location_id, qty)
  SELECT p.id, i.location_id, CAST(json_extract(j.value, '$.stock_qty') AS REAL)
  FROM json_each(?) AS j
  JOIN product_import_drafts AS i
    ON i.token = ? AND i.actor_line_id = ? AND i.status = 'committing'
  JOIN products p
    ON p.sku COLLATE NOCASE = json_extract(j.value, '$.sku') COLLATE NOCASE
  WHERE 1
  ON CONFLICT(product_id, location_id) DO UPDATE SET
    qty = excluded.qty,
    updated_at = datetime('now')
`;

/**
 * เลขอ้างอิงสร้างจาก token ของร่างนำเข้า จึงได้ค่าเดิมเสมอแม้ผู้ใช้กดยืนยันซ้ำ
 * หรือมีสองคำขอยืนยันพร้อมกัน (ต่างกันแค่เรื่องสุ่มเดิมของ makeRef)
 */
function importRefFromToken(token: string): string {
  const bkk = new Date(Date.now() + 7 * 3600_000);
  const yy = String((bkk.getUTCFullYear() + 543) % 100).padStart(2, '0');
  const mm = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bkk.getUTCDate()).padStart(2, '0');
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash = Math.imul(hash ^ token.charCodeAt(i), 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).toUpperCase().padStart(8, '0');
  return `IMP-${yy}${mm}${dd}-${suffix.slice(0, 4)}-${suffix.slice(4, 8)}`;
}

function importResultFromPlan(plan: ImportPlan, ref: string | null): ImportCommitResult {
  return {
    ref,
    totalRows: plan.summary.totalRows,
    created: plan.summary.createCount,
    updated: plan.summary.updateCount,
    unchanged: plan.summary.unchangedCount,
    skipped: plan.summary.skippedCount,
    renamed: plan.summary.renamedCount,
    movements: plan.summary.movementCount,
    totalTargetQty: plan.summary.totalTargetQty,
  };
}

export async function commitStagedProductImport(
  db: D1Database,
  token: string,
  actor: Actor,
): Promise<ImportCommitResult> {
  const actorLineId = actor.lineUserId;
  if (!actorLineId) throw new AppError('ไม่พบผู้ใช้ผู้ดำเนินการ', 401);
  const draft = await getProductImportDraft(db, token, actorLineId);
  if (!draft) throw new AppError('ไม่พบร่างนำเข้านี้ หรือร่างหมดอายุแล้ว กรุณาตรวจไฟล์ใหม่', 404);
  if (draft.status === 'committed' && draft.result_json) {
    try {
      return JSON.parse(draft.result_json) as ImportCommitResult;
    } catch {
      throw new AppError('บันทึกผลนำเข้าไม่สำเร็จ กรุณาตรวจสอบประวัติการเคลื่อนไหว', 500);
    }
  }
  if (draft.status !== 'preview') throw new AppError('ร่างนำเข้านี้กำลังถูกบันทึกอยู่ หรือถูกยกเลิกแล้ว กรุณาตรวจไฟล์ใหม่', 409);
  if (draft.expires_at < Math.floor(Date.now() / 1000)) throw new AppError('ร่างนำเข้าหมดอายุ กรุณาตรวจไฟล์ใหม่', 410);

  const plan = JSON.parse(draft.plan_json) as ImportPlan;
  const payloadRows = JSON.parse(draft.payload) as Array<Record<string, unknown>>;
  const ref = importRefFromToken(token);
  const result = importResultFromPlan(plan, ref);
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    db.prepare(STAGED_GUARD_SQL).bind(draft.id, token, actorLineId, now),
  ];
  for (const chunk of chunkImportRows(payloadRows)) {
    statements.push(db.prepare(STAGED_PRODUCT_UPSERT_SQL).bind(JSON.stringify(chunk), token, actorLineId));
  }
  for (const chunk of chunkImportRows(payloadRows)) {
    statements.push(
      db
        .prepare(STAGED_MOVEMENT_SQL)
        .bind(ref, actorLineId, actor.name, actor.source, JSON.stringify(chunk), token, actorLineId),
    );
  }
  for (const chunk of chunkImportRows(payloadRows)) {
    statements.push(db.prepare(STAGED_STOCK_SQL).bind(JSON.stringify(chunk), token, actorLineId));
  }
  statements.push(
    db
      .prepare(
        `UPDATE product_import_drafts
         SET status = 'committed', ref = ?, result_json = ?, committed_at = datetime('now')
         WHERE id = ? AND token = ? AND actor_line_id = ? AND status = 'committing'`,
      )
      .bind(ref, JSON.stringify(result), draft.id, token, actorLineId),
  );

  let batchOk = false;
  try {
    const batchResults = await db.batch(statements);
    // ผลของคำสั่งแรกคือการล็อกร่างนำเข้า (guard) ถ้าไม่ผ่าน แปลว่ามีอีกคำขอยืนยัน
    // ค้างอยู่หรือข้อมูลเปลี่ยนไปแล้ว ต้องไม่เข้าใจว่านำเข้าสำเร็จ
    const guardChanges = (batchResults[0]?.meta?.changes ?? 0) as number;
    batchOk = guardChanges === 1;
  } catch (error) {
    console.error('product import batch failed', error);
    throw new AppError('ข้อมูลบางรายการเปลี่ยนไปหรือชนกับข้อมูลเดิม ระบบยกเลิกทั้งไฟล์แล้ว กรุณาตรวจไฟล์ใหม่', 409);
  }
  const after = await getProductImportDraft(db, token, actorLineId);
  if (after && after.status === 'committed' && after.result_json) {
    // อ่านผลจากฐานข้อมูลเสมอ เผื่อมีการกดยืนยันซ้ำหรือกดพร้อมกันสองคำขอ
    try {
      return JSON.parse(after.result_json) as ImportCommitResult;
    } catch {
      return result;
    }
  }
  if (!batchOk) throw new AppError('มีการกดยืนยันรายการนี้อยู่แล้ว กรุณารอสักครู่แล้วกดยืนยันอีกครั้ง', 409);
  if (!after) throw new AppError('ไม่พบร่างนำเข้านี้ กรุณาตรวจไฟล์ใหม่', 404);
  if (draft.expires_at < Math.floor(Date.now() / 1000)) throw new AppError('ร่างนำเข้าหมดอายุ กรุณาตรวจไฟล์ใหม่', 410);
  throw new AppError('ข้อมูลสินค้าหรือยอดคงเหลือเปลี่ยนไปหลังตรวจแล้ว กรุณาตรวจไฟล์ใหม่อีกครั้ง', 409);
}

function chunkImportRows<T>(rows: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) chunks.push(rows.slice(i, i + IMPORT_CHUNK_SIZE));
  return chunks;
}

/* ----------------------------------------------------------------- stock */

export interface LevelRow {
  location_id: number;
  code: string;
  name: string;
  qty: number;
}

export async function getLevels(db: D1Database, productId: number): Promise<LevelRow[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id AS location_id, l.code, l.name, COALESCE(s.qty, 0) AS qty
       FROM locations l
       LEFT JOIN stock_levels s ON s.location_id = l.id AND s.product_id = ?
       WHERE l.active = 1
       ORDER BY l.is_default DESC, l.code`,
    )
    .bind(productId)
    .all<LevelRow>();
  return results ?? [];
}

export async function getQty(db: D1Database, productId: number, locationId: number): Promise<number> {
  const row = await db
    .prepare('SELECT qty FROM stock_levels WHERE product_id = ? AND location_id = ?')
    .bind(productId, locationId)
    .first<{ qty: number }>();
  return row?.qty ?? 0;
}

export async function totalQty(db: D1Database, productId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_levels WHERE product_id = ?')
    .bind(productId)
    .first<{ q: number }>();
  return row?.q ?? 0;
}

/** บวก/ลบสต๊อกแบบกันติดลบ (atomic ที่ระดับ statement) */
async function addStock(db: D1Database, productId: number, locationId: number, delta: number): Promise<number> {
  await db
    .prepare('INSERT OR IGNORE INTO stock_levels (product_id, location_id, qty) VALUES (?, ?, 0)')
    .bind(productId, locationId)
    .run();
  const row = await db
    .prepare(
      `UPDATE stock_levels SET qty = qty + ?, updated_at = datetime('now')
       WHERE product_id = ? AND location_id = ? AND qty + ? >= 0
       RETURNING qty`,
    )
    .bind(delta, productId, locationId, delta)
    .first<{ qty: number }>();
  if (!row) {
    const have = await getQty(db, productId, locationId);
    throw new AppError(`สต๊อกไม่พอ (คงเหลือ ${have})`);
  }
  return row.qty;
}

async function logMovement(
  db: D1Database,
  args: {
    ref: string;
    type: MovementType;
    productId: number;
    locationId: number;
    qty: number;
    delta: number;
    balanceAfter: number;
    note?: string | null;
    actor: Actor;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO movements (ref, type, product_id, location_id, qty, delta, balance_after, note, actor_line_id, actor_name, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.ref,
      args.type,
      args.productId,
      args.locationId,
      Math.abs(args.qty),
      args.delta,
      args.balanceAfter,
      args.note ?? null,
      args.actor.lineUserId,
      args.actor.name,
      args.actor.source,
    )
    .run();
}

export interface MovementResult {
  ref: string;
  balanceAfter: number;
  balanceAfterTo?: number;
  total: number;
}

/** เบิกออก */
export async function issue(
  db: D1Database,
  productId: number,
  locationId: number,
  qty: number,
  note: string | null,
  actor: Actor,
): Promise<MovementResult> {
  if (qty <= 0) throw new AppError('จำนวนต้องมากกว่า 0');
  const ref = makeRef('OUT');
  const balance = await addStock(db, productId, locationId, -qty);
  await logMovement(db, {
    ref, type: 'issue', productId, locationId, qty, delta: -qty, balanceAfter: balance, note, actor,
  });
  return { ref, balanceAfter: balance, total: await totalQty(db, productId) };
}

/** รับเข้า */
export async function receive(
  db: D1Database,
  productId: number,
  locationId: number,
  qty: number,
  note: string | null,
  actor: Actor,
): Promise<MovementResult> {
  if (qty <= 0) throw new AppError('จำนวนต้องมากกว่า 0');
  const ref = makeRef('IN');
  const balance = await addStock(db, productId, locationId, qty);
  await logMovement(db, {
    ref, type: 'receive', productId, locationId, qty, delta: qty, balanceAfter: balance, note, actor,
  });
  return { ref, balanceAfter: balance, total: await totalQty(db, productId) };
}

/** ปรับยอดให้เท่ากับจำนวนที่นับได้จริง */
export async function adjust(
  db: D1Database,
  productId: number,
  locationId: number,
  targetQty: number,
  note: string | null,
  actor: Actor,
): Promise<MovementResult> {
  if (targetQty < 0) throw new AppError('จำนวนคงเหลือติดลบไม่ได้');
  const ref = makeRef('ADJ');
  await db
    .prepare('INSERT OR IGNORE INTO stock_levels (product_id, location_id, qty) VALUES (?, ?, 0)')
    .bind(productId, locationId)
    .run();

  let delta = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getQty(db, productId, locationId);
    delta = targetQty - current;
    const row = await db
      .prepare(
        `UPDATE stock_levels SET qty = ?, updated_at = datetime('now')
         WHERE product_id = ? AND location_id = ? AND qty = ? RETURNING qty`,
      )
      .bind(targetQty, productId, locationId, current)
      .first<{ qty: number }>();
    if (row) {
      await logMovement(db, {
        ref, type: 'adjust', productId, locationId, qty: Math.abs(delta), delta,
        balanceAfter: row.qty, note, actor,
      });
      return { ref, balanceAfter: row.qty, total: await totalQty(db, productId) };
    }
  }
  throw new AppError('ปรับยอดไม่สำเร็จ มีการแก้ไขสต๊อกพร้อมกัน กรุณาลองใหม่');
}

/** ย้ายระหว่างคลัง */
export async function transfer(
  db: D1Database,
  productId: number,
  fromId: number,
  toId: number,
  qty: number,
  note: string | null,
  actor: Actor,
): Promise<MovementResult> {
  if (qty <= 0) throw new AppError('จำนวนต้องมากกว่า 0');
  if (fromId === toId) throw new AppError('คลังต้นทางและปลายทางต้องต่างกัน');
  const ref = makeRef('TRF');
  const fromBalance = await addStock(db, productId, fromId, -qty);
  let toBalance: number;
  try {
    toBalance = await addStock(db, productId, toId, qty);
  } catch (err) {
    await addStock(db, productId, fromId, qty); // คืนค่าเมื่อขาปลายทางล้มเหลว
    throw err;
  }
  await logMovement(db, {
    ref, type: 'transfer_out', productId, locationId: fromId, qty, delta: -qty, balanceAfter: fromBalance, note, actor,
  });
  await logMovement(db, {
    ref, type: 'transfer_in', productId, locationId: toId, qty, delta: qty, balanceAfter: toBalance, note, actor,
  });
  return { ref, balanceAfter: fromBalance, balanceAfterTo: toBalance, total: await totalQty(db, productId) };
}

/* ------------------------------------------------------------- movements */

export interface MovementRow {
  id: number;
  ref: string;
  type: MovementType;
  qty: number;
  delta: number;
  balance_after: number;
  note: string | null;
  actor_name: string | null;
  source: string;
  created_at: string;
  product_name: string;
  sku: string;
  unit: string;
  location_name: string;
  location_code: string;
}

export async function listMovements(
  db: D1Database,
  opts: { productId?: number; locationId?: number; limit?: number } = {},
): Promise<MovementRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.productId) { where.push('m.product_id = ?'); binds.push(opts.productId); }
  if (opts.locationId) { where.push('m.location_id = ?'); binds.push(opts.locationId); }
  const sql = `
    SELECT m.id, m.ref, m.type, m.qty, m.delta, m.balance_after, m.note, m.actor_name, m.source, m.created_at,
           p.name AS product_name, p.sku, p.unit, l.name AS location_name, l.code AS location_code
    FROM movements m
    JOIN products p ON p.id = m.product_id
    JOIN locations l ON l.id = m.location_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, opts.limit ?? 50).all<MovementRow>();
  return results ?? [];
}

/* --------------------------------------------------------------- reports */

export async function lowStockProducts(db: D1Database, limit = 50): Promise<ProductWithStock[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) AS total_qty,
              (SELECT COUNT(*) FROM stock_levels s WHERE s.product_id = p.id AND s.qty > 0) AS location_count
       FROM products p
       WHERE p.active = 1 AND p.min_qty > 0
         AND COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) <= p.min_qty
       ORDER BY (COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) - p.min_qty), p.name
       LIMIT ?`,
    )
    .bind(limit)
    .all<ProductWithStock>();
  return results ?? [];
}

export interface Summary {
  productCount: number;
  locationCount: number;
  totalUnits: number;
  lowCount: number;
  outCount: number;
  todayIssue: number;
  todayReceive: number;
  todayMovements: number;
}

export async function getSummary(db: D1Database): Promise<Summary> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE active = 1) AS productCount,
        (SELECT COUNT(*) FROM locations WHERE active = 1) AS locationCount,
        (SELECT COALESCE(SUM(s.qty), 0) FROM stock_levels s JOIN products p ON p.id = s.product_id WHERE p.active = 1) AS totalUnits,
        (SELECT COUNT(*) FROM products p WHERE p.active = 1 AND p.min_qty > 0
           AND COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) <= p.min_qty
           AND COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) > 0) AS lowCount,
        (SELECT COUNT(*) FROM products p WHERE p.active = 1
           AND COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.product_id = p.id), 0) <= 0) AS outCount,
        (SELECT COALESCE(SUM(qty), 0) FROM movements WHERE type = 'issue' AND date(created_at, '+7 hours') = date('now', '+7 hours')) AS todayIssue,
        (SELECT COALESCE(SUM(qty), 0) FROM movements WHERE type = 'receive' AND date(created_at, '+7 hours') = date('now', '+7 hours')) AS todayReceive,
        (SELECT COUNT(*) FROM movements WHERE date(created_at, '+7 hours') = date('now', '+7 hours')) AS todayMovements`,
    )
    .first<Summary>();
  return (
    row ?? {
      productCount: 0, locationCount: 0, totalUnits: 0, lowCount: 0,
      outCount: 0, todayIssue: 0, todayReceive: 0, todayMovements: 0,
    }
  );
}

/* ---------------------------------------------------------------- drafts */

const DRAFT_TTL_MS = 10 * 60 * 1000;

export async function saveDraft(db: D1Database, draft: Draft): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drafts (line_user_id, token, step, payload, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         token = excluded.token, step = excluded.step,
         payload = excluded.payload, expires_at = excluded.expires_at`,
    )
    .bind(draft.lineUserId, draft.token, draft.step, JSON.stringify(draft.payload), Date.now() + DRAFT_TTL_MS)
    .run();
}

export async function getDraft(db: D1Database, lineUserId: string, token?: string): Promise<Draft | null> {
  const row = await db
    .prepare('SELECT * FROM drafts WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ line_user_id: string; token: string; step: string; payload: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await clearDraft(db, lineUserId);
    return null;
  }
  if (token && row.token !== token) return null;
  return {
    lineUserId: row.line_user_id,
    token: row.token,
    step: row.step as DraftStep,
    payload: JSON.parse(row.payload) as DraftPayload,
  };
}

export async function clearDraft(db: D1Database, lineUserId: string): Promise<void> {
  await db.prepare('DELETE FROM drafts WHERE line_user_id = ?').bind(lineUserId).run();
}

/** กัน webhook ซ้ำ — คืน true ถ้าเคยประมวลผลแล้ว */
export async function isDuplicateEvent(db: D1Database, eventId: string): Promise<boolean> {
  try {
    await db
      .prepare('INSERT INTO processed_events (event_id, created_at) VALUES (?, ?)')
      .bind(eventId, Date.now())
      .run();
    return false;
  } catch {
    return true;
  }
}

export async function purgeOldEvents(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM processed_events WHERE created_at < ?').bind(Date.now() - 86_400_000).run();
}
