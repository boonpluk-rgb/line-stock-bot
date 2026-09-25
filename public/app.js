/* ============================================================
   LINE Stock — LIFF dashboard
   ============================================================ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: null,
  idToken: null,
  me: null,
  tab: 'overview',
  products: [],
  locations: [],
  filters: { q: '', status: 'all', locationId: '' },
  historyType: 'all',
  summary: null,
  importFile: null,
  importPreview: null,
  importRunId: 0,
  importBusy: false,
};

const ACTIONS = {
  issue:    { label: 'เบิกออก', icon: '📤', cls: 'issue',    verb: 'เบิก' },
  receive:  { label: 'รับเข้า', icon: '📥', cls: 'receive',  verb: 'รับเข้า' },
  adjust:   { label: 'ปรับยอด', icon: '⚖️', cls: 'adjust',   verb: 'ปรับเป็น' },
  transfer: { label: 'ย้ายคลัง', icon: '🔁', cls: 'transfer', verb: 'ย้าย' },
};

const MOVE_META = {
  issue:        { label: 'เบิกออก', icon: '📤', cls: 'issue' },
  receive:      { label: 'รับเข้า', icon: '📥', cls: 'receive' },
  adjust:       { label: 'ปรับยอด', icon: '⚖️', cls: 'adjust' },
  transfer_out: { label: 'ย้ายออก', icon: '🔁', cls: 'transfer' },
  transfer_in:  { label: 'ย้ายเข้า', icon: '🔁', cls: 'transfer' },
};

/* ------------------------------------------------------------ helpers */

const fmt = (n) => {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return v.toLocaleString('th-TH', { maximumFractionDigits: 3 });
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function stockClass(qty, min) {
  if (qty <= 0) return 'out';
  if (min > 0 && qty <= min) return 'low';
  return 'ok';
}

function relTime(sqlUtc) {
  const d = new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'เมื่อครู่';
  if (diff < 3600) return `${Math.floor(diff / 60)} นาทีที่แล้ว`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ชั่วโมงที่แล้ว`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} วันที่แล้ว`;
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' });
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind ? 'toast--' + kind : ''}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (state.idToken) headers.authorization = `Bearer ${state.idToken}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/* --------------------------------------------------------- bootstrap */

async function boot() {
  try {
    state.config = await fetch('/api/config').then((r) => r.json());
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const useLiff = state.config.liffId && !(local && state.config.dev);

    if (useLiff) {
      await liff.init({ liffId: state.config.liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
      state.idToken = liff.getIDToken();
      if (!state.idToken) throw new Error('ไม่ได้รับ ID token — ตรวจสอบว่าเปิด scope "openid" ใน LINE Login แล้ว');
    }

    state.me = await api('/me');
    paintUser();
    await refreshAll();

    $('#boot').hidden = true;
    $('#app').hidden = false;
    applyDeepLink();
  } catch (err) {
    $('#boot').innerHTML = `
      <div class="boot__logo">⚠️</div>
      <div class="boot__text" style="max-width:280px;text-align:center">${esc(err.message)}</div>
      <button class="btn btn--ghost" onclick="location.reload()">ลองใหม่</button>`;
  }
}

function applyDeepLink() {
  const p = new URLSearchParams(location.search);
  if (p.get('status')) {
    state.filters.status = p.get('status');
    $$('#statusChips .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.status === state.filters.status));
  }
  if (p.get('tab')) switchTab(p.get('tab'));
  if (p.get('p')) openProduct(Number(p.get('p')));
}

function paintUser() {
  const name = state.me?.name || 'ผู้ใช้';
  $('#userInitial').textContent = name.trim().charAt(0).toUpperCase();
  if (state.me?.picture) {
    const img = $('#userAvatar');
    img.src = state.me.picture;
    img.hidden = false;
    $('#userInitial').hidden = true;
  }
  $('#meName').textContent = name;
  $('#meId').textContent = state.me?.lineUserId ?? '-';
}

async function refreshAll() {
  const [data, products] = await Promise.all([api('/summary'), loadProducts()]);
  state.summary = data.summary;
  state.locations = data.locations;
  renderOverview(data);
  renderLocationFilter();
  renderProducts(products);
  renderSettingsLocations(data.byLocation);
}

async function loadProducts() {
  const p = new URLSearchParams();
  if (state.filters.q) p.set('q', state.filters.q);
  if (state.filters.status !== 'all') p.set('status', state.filters.status);
  if (state.filters.locationId) p.set('locationId', state.filters.locationId);
  state.products = await api(`/products?${p}`);
  return state.products;
}

/* ------------------------------------------------------------ ภาพรวม */

function renderOverview(data) {
  const s = data.summary;
  $('#statGrid').innerHTML = `
    ${statTile('รายการสินค้า', fmt(s.productCount), `${s.locationCount} คลัง`, '')}
    ${statTile('หน่วยคงเหลือรวม', fmt(s.totalUnits), 'ทุกคลังรวมกัน', '')}
    ${statTile('ใกล้หมด', fmt(s.lowCount), 'ต่ำกว่าจุดสั่งซื้อ', 'warn')}
    ${statTile('หมดสต๊อก', fmt(s.outCount), 'ต้องสั่งซื้อด่วน', 'danger')}
    <div class="stat" style="grid-column:1/-1">
      <div class="stat__label">ความเคลื่อนไหววันนี้</div>
      <div style="display:flex;gap:22px;margin-top:8px">
        <div><div class="stat__value" style="color:var(--issue);font-size:22px">${fmt(s.todayIssue)}</div><div class="stat__hint">เบิกออก</div></div>
        <div><div class="stat__value" style="color:var(--receive);font-size:22px">${fmt(s.todayReceive)}</div><div class="stat__hint">รับเข้า</div></div>
        <div><div class="stat__value" style="font-size:22px">${fmt(s.todayMovements)}</div><div class="stat__hint">รายการ</div></div>
      </div>
    </div>`;

  const max = Math.max(1, ...data.byLocation.map((l) => Number(l.units) || 0));
  $('#locationBars').innerHTML = data.byLocation.length
    ? data.byLocation
        .map(
          (l) => `
      <div class="loc-bar">
        <div class="loc-bar__top">
          <span class="loc-bar__name">${esc(l.name)}</span>
          <span class="loc-bar__value">${fmt(l.units)} หน่วย · ${l.items} รายการ</span>
        </div>
        <div class="loc-bar__track"><div class="loc-bar__fill" style="width:${((Number(l.units) || 0) / max) * 100}%"></div></div>
      </div>`,
        )
        .join('')
    : '<div class="empty">ยังไม่มีคลังสินค้า</div>';

  $('#lowList').innerHTML = data.low.length
    ? data.low.map((p) => productRow(p, true)).join('')
    : '<div class="empty">ไม่มีสินค้าต่ำกว่าจุดสั่งซื้อ 🎉</div>';

  $('#recentList').innerHTML = data.recent.length
    ? data.recent.slice(0, 6).map(movementRow).join('')
    : '<div class="empty">ยังไม่มีความเคลื่อนไหว</div>';
}

function statTile(label, value, hint, kind) {
  return `<div class="stat ${kind ? 'stat--' + kind : ''}">
    <div class="stat__label">${kind ? `<span class="dot"></span>` : ''}${esc(label)}</div>
    <div class="stat__value">${value}</div>
    <div class="stat__hint">${esc(hint)}</div>
  </div>`;
}

function productRow(p, plain = false) {
  const cls = stockClass(Number(p.total_qty), Number(p.min_qty));
  const badge = cls === 'out' ? 'หมด' : cls === 'low' ? 'ใกล้หมด' : '';
  return `<button class="item ${plain ? 'item--plain' : ''}" data-product="${p.id}">
    <div class="item__main">
      <div class="item__name">${esc(p.name)}</div>
      <div class="item__meta">
        <span>${esc(p.sku)}</span>
        ${p.category ? `<span>· ${esc(p.category)}</span>` : ''}
        ${badge ? `<span class="badge badge--${cls}">${badge}</span>` : ''}
      </div>
    </div>
    <div class="item__qty">
      <b class="qty-${cls}">${fmt(p.total_qty)}</b>
      <span>${esc(p.unit)}</span>
    </div>
  </button>`;
}

function movementRow(m) {
  const meta = MOVE_META[m.type] ?? { label: m.type, icon: '•', cls: '' };
  const positive = Number(m.delta) > 0;
  return `<div class="tl">
    <div class="tl__icon badge--${meta.cls}">${meta.icon}</div>
    <div>
      <div class="tl__name">${esc(m.product_name)}</div>
      <div class="tl__meta">${meta.label} · ${esc(m.location_name)} · ${relTime(m.created_at)}${m.actor_name ? ' · ' + esc(m.actor_name) : ''}${m.note ? ' · ' + esc(m.note) : ''}</div>
    </div>
    <div>
      <div class="tl__delta" style="color:var(--${positive ? 'receive' : 'issue'})">${positive ? '+' : ''}${fmt(m.delta)}</div>
      <div class="tl__balance">เหลือ ${fmt(m.balance_after)}</div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------- สินค้า */

function renderLocationFilter() {
  const sel = $('#locationFilter');
  sel.innerHTML =
    '<option value="">ทุกคลัง</option>' +
    state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = state.filters.locationId;
}

function renderProducts(products) {
  $('#productList').innerHTML = products.length
    ? products.map((p) => productRow(p)).join('')
    : `<div class="empty">ไม่พบสินค้าที่ตรงกับเงื่อนไข</div>`;
}

function renderSettingsLocations(byLocation = []) {
  const stats = Object.fromEntries(byLocation.map((l) => [l.id, l]));
  $('#locationList').innerHTML = state.locations
    .map((l) => {
      const s = stats[l.id] ?? { units: 0, items: 0 };
      return `<button class="item item--plain" data-location="${l.id}">
        <div class="item__main">
          <div class="item__name">${esc(l.name)} ${l.is_default ? '<span class="badge badge--ok">ค่าเริ่มต้น</span>' : ''}</div>
          <div class="item__meta"><span>${esc(l.code)}</span><span>· ${s.items} รายการ</span></div>
        </div>
        <div class="item__qty"><b>${fmt(s.units)}</b><span>หน่วย</span></div>
      </button>`;
    })
    .join('');
}

/* ------------------------------------------------------------ ประวัติ */

async function renderHistory() {
  const list = $('#historyList');
  list.innerHTML = '<div class="skeleton"></div>';
  const rows = await api('/movements?limit=100');
  const filtered =
    state.historyType === 'all'
      ? rows
      : rows.filter((r) => (state.historyType === 'transfer' ? r.type.startsWith('transfer') : r.type === state.historyType));
  list.innerHTML = filtered.length ? filtered.map(movementRow).join('') : '<div class="empty">ไม่มีรายการ</div>';
}

/* -------------------------------------------------------- bottom sheet */

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  document.body.style.overflow = '';
}

function sheetHead(title, subtitle) {
  return `<div class="sheet__head">
    <div><div class="sheet__title">${esc(title)}</div>${subtitle ? `<div class="sheet__sub">${esc(subtitle)}</div>` : ''}</div>
    <button class="sheet__close" data-close>✕</button>
  </div>`;
}

/* -------------------------------------------------- รายละเอียดสินค้า */

async function openProduct(id) {
  openSheet(`${sheetHead('กำลังโหลด…', '')}<div class="skeleton" style="height:120px"></div>`);
  try {
    const { product, levels, movements, total } = await api(`/products/${id}`);
    const cls = stockClass(total, product.min_qty);
    openSheet(`
      ${sheetHead(product.name, `${product.sku}${product.barcode ? ' · ' + product.barcode : ''}`)}
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:10px">
        <div class="confirm__big qty-${cls}" style="font-size:34px">${fmt(total)}</div>
        <div style="color:var(--muted);font-size:13px">${esc(product.unit)} รวมทุกคลัง</div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">
        ${product.min_qty > 0 ? `จุดสั่งซื้อขั้นต่ำ ${fmt(product.min_qty)} ${esc(product.unit)}` : 'ยังไม่ตั้งจุดสั่งซื้อ'}
        ${product.category ? ' · ' + esc(product.category) : ''}
      </div>

      <div class="btn-grid" style="margin-top:16px">
        <button class="btn btn--issue" data-move="issue" data-id="${product.id}">📤 เบิกออก</button>
        <button class="btn btn--receive" data-move="receive" data-id="${product.id}">📥 รับเข้า</button>
        <button class="btn btn--ghost" data-move="adjust" data-id="${product.id}">⚖️ ปรับยอด</button>
        <button class="btn btn--ghost" data-move="transfer" data-id="${product.id}">🔁 ย้ายคลัง</button>
      </div>

      <section>
        <h3>คงเหลือแยกตามคลัง</h3>
        <div class="list">
          ${levels
            .map(
              (l) => `<div class="row"><span class="row__label">${esc(l.name)} · ${esc(l.code)}</span>
              <span class="row__value">${fmt(l.qty)} ${esc(product.unit)}</span></div>`,
            )
            .join('')}
        </div>
      </section>

      <section>
        <h3>ความเคลื่อนไหวล่าสุด</h3>
        <div class="timeline">${movements.length ? movements.slice(0, 12).map(movementRow).join('') : '<div class="empty">ยังไม่มีรายการ</div>'}</div>
      </section>

      <section>
        <button class="btn btn--ghost btn--block" data-edit-product="${product.id}">แก้ไขข้อมูลสินค้า</button>
      </section>
    `);
  } catch (err) {
    toast(err.message, 'error');
    closeSheet();
  }
}

/* ------------------------------------------------------- ทำรายการสต๊อก */

async function openMovement(productId, action = 'issue') {
  const { product, levels } = await api(`/products/${productId}`);
  const meta = ACTIONS[action];
  const defaultLoc = levels.find((l) => l.qty > 0) ?? levels[0];

  openSheet(`
    ${sheetHead(meta.label, product.name)}
    <div class="seg" style="margin-top:6px">
      ${Object.entries(ACTIONS)
        .map(([key, a]) => `<button data-action="${key}" class="${key === action ? 'is-active' : ''}">${a.icon} ${a.label}</button>`)
        .join('')}
    </div>

    <form id="moveForm" style="margin-top:18px">
      <div class="field">
        <label>${action === 'transfer' ? 'คลังต้นทาง' : 'คลัง'}</label>
        <select name="locationId">
          ${levels.map((l) => `<option value="${l.location_id}" ${l.location_id === defaultLoc?.location_id ? 'selected' : ''}>${esc(l.name)} — คงเหลือ ${fmt(l.qty)} ${esc(product.unit)}</option>`).join('')}
        </select>
      </div>

      ${
        action === 'transfer'
          ? `<div class="field"><label>คลังปลายทาง</label>
              <select name="toLocationId">
                ${levels.map((l) => `<option value="${l.location_id}">${esc(l.name)} — คงเหลือ ${fmt(l.qty)} ${esc(product.unit)}</option>`).join('')}
              </select></div>`
          : ''
      }

      <div class="field">
        <label>${action === 'adjust' ? `จำนวนที่นับได้จริง (${esc(product.unit)})` : `จำนวน (${esc(product.unit)})`}</label>
        <div class="stepper">
          <button type="button" data-step="-1">−</button>
          <input name="qty" type="number" inputmode="decimal" min="0" step="any" value="${action === 'adjust' ? fmt(defaultLoc?.qty ?? 0).replace(/,/g, '') : 1}" />
          <button type="button" data-step="1">+</button>
        </div>
      </div>

      <div class="field">
        <label>หมายเหตุ (ไม่บังคับ)</label>
        <input name="note" placeholder="เช่น ใช้ในงานอีเวนต์ / ผู้รับของ" />
      </div>

      <div class="confirm" id="preview"></div>

      <button class="btn btn--${meta.cls} btn--block" style="margin-top:14px" type="submit" id="submitBtn">ยืนยัน</button>
    </form>
  `);

  const form = $('#moveForm');
  const unit = product.unit;

  const updatePreview = () => {
    const locId = Number(form.locationId.value);
    const level = levels.find((l) => l.location_id === locId);
    const current = level?.qty ?? 0;
    const qty = Number(form.qty.value || 0);
    const after = action === 'receive' ? current + qty : action === 'adjust' ? qty : current - qty;
    const cls = stockClass(after, product.min_qty);
    const invalid = (action !== 'adjust' && qty <= 0) || (action !== 'receive' && action !== 'adjust' && after < 0);

    $('#preview').innerHTML = `
      <div class="row"><span class="row__label">คงเหลือปัจจุบัน</span><span class="row__value">${fmt(current)} ${esc(unit)}</span></div>
      <div class="row"><span class="row__label">${ACTIONS[action].verb}</span><span class="row__value" style="color:var(--${meta.cls})">${fmt(qty)} ${esc(unit)}</span></div>
      <div class="row"><span class="row__label">คงเหลือหลังทำรายการ</span><span class="confirm__big qty-${cls}">${fmt(after)} ${esc(unit)}</span></div>
      ${after < 0 ? '<div style="color:var(--danger);font-size:12px">สต๊อกไม่พอสำหรับจำนวนนี้</div>' : ''}
      ${after >= 0 && product.min_qty > 0 && after <= product.min_qty ? `<div style="color:var(--warn);font-size:12px">⚠️ จะต่ำกว่าจุดสั่งซื้อ (ขั้นต่ำ ${fmt(product.min_qty)})</div>` : ''}`;

    const btn = $('#submitBtn');
    btn.disabled = invalid;
    btn.textContent = `ยืนยัน${ACTIONS[action].label} ${fmt(qty)} ${unit}`;
  };

  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);
  $$('[data-step]', form).forEach((b) =>
    b.addEventListener('click', () => {
      const input = form.qty;
      input.value = Math.max(0, (Number(input.value) || 0) + Number(b.dataset.step));
      updatePreview();
    }),
  );
  $$('[data-action]').forEach((b) => b.addEventListener('click', () => openMovement(productId, b.dataset.action)));
  updatePreview();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก…';
    try {
      const payload = {
        action,
        productId,
        locationId: Number(form.locationId.value),
        qty: Number(form.qty.value),
        note: form.note.value.trim() || undefined,
      };
      if (action === 'transfer') payload.toLocationId = Number(form.toLocationId.value);
      const result = await api('/movements', { method: 'POST', body: JSON.stringify(payload) });
      closeSheet();
      toast(`${meta.label}สำเร็จ · เลขที่ ${result.ref}`, 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      updatePreview();
    }
  });
}

/* -------------------------------------------------- นำเข้า Excel / CSV */

const IMPORT_FIELDS = [
  { key: 'sku', label: 'รหัสสินค้า (SKU) *', required: true, aliases: ['sku', 'รหัสสินค้า', 'รหัส', 'id', 'code', 'รหัสอุปกรณ์'] },
  { key: 'name', label: 'ชื่อสินค้า *', required: true, aliases: ['name', 'ชื่อสินค้า', 'รายการอุปกรณ์', 'รายการ', 'สินค้า', 'product'] },
  { key: 'category', label: 'หมวดหมู่', aliases: ['category', 'หมวดหมู่', 'หมวดหมู่อุปกรณ์', 'กลุ่มสินค้า'] },
  { key: 'stock', label: 'จำนวนคงเหลือในคลัง *', required: true, aliases: ['stock', 'qty', 'quantity', 'จำนวนคงเหลือในคลัง', 'จำนวนคงเหลือ', 'ยอดคงเหลือ', 'คงเหลือ'] },
  { key: 'min_qty', label: 'จุดสั่งซื้อขั้นต่ำ', aliases: ['minqty', 'reorder', 'จุดสั่งซื้อ', 'สั่งซื้อขั้นต่ำ', 'สั่งซื้อขั้นต่ำ20', 'ขั้นต่ำ'] },
  { key: 'unit', label: 'หน่วยนับ', aliases: ['unit', 'หน่วย', 'หน่วยนับ'] },
  { key: 'barcode', label: 'บาร์โค้ด (ถ้ามี)', aliases: ['barcode', 'บาร์โค้ด', 'qr', 'qrcode'] },
  { key: 'note', label: 'หมายเหตุ (ถ้ามี)', aliases: ['note', 'remark', 'หมายเหตุ'] },
];

let xlsxLoaderPromise = null;
let qrLibraryPromise = null;

function importHeaderKey(value) {
  return String(value ?? '')
    .replace(/\uFEFF/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0e00-\u0e7f]+/g, '');
}

function guessImportMapping(headers) {
  const keys = headers.map(importHeaderKey);
  const mapping = {};
  for (const field of IMPORT_FIELDS) {
    const aliases = field.aliases.map(importHeaderKey).filter(Boolean);
    let index = keys.findIndex((key) => aliases.includes(key));
    if (index < 0 && field.key !== 'unit') {
      index = keys.findIndex((key) => key && aliases.some((alias) => key.includes(alias) || alias.includes(key)));
    }
    // “ราคา/หน่วย” หรือ “ราคาต่อหน่วย” เป็นราคา ไม่ใช่หน่วยสินค้า
    // จึงไม่ควรถูกเลือกเป็นคอลัมน์หน่วยนับโดยอัตโนมัติ
    if (field.key === 'unit' && index >= 0 && /(?:ราคา|price|cost|มูลค่า)/i.test(keys[index])) index = -1;
    mapping[field.key] = index >= 0 ? String(index) : '';
  }
  return mapping;
}

function parseCsv(text, delimiter = ',') {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((v) => String(v).trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  }
  return rows;
}

function detectCsvDelimiter(text) {
  const line = String(text ?? '').split(/\r?\n/).find((v) => v.trim()) ?? '';
  const candidates = [',', ';', '\t'];
  return candidates.reduce((best, delimiter) => {
    const count = line.split(delimiter).length;
    return count > best.count ? { delimiter, count } : best;
  }, { delimiter: ',', count: 0 }).delimiter;
}

function loadXlsxLibrary() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLoaderPromise) return xlsxLoaderPromise;
  xlsxLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.async = true;
    script.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('โหลดตัวอ่าน Excel ไม่สำเร็จ')));
    script.onerror = () => reject(new Error('โหลดตัวอ่าน Excel ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'));
    document.head.appendChild(script);
  }).catch((error) => {
    xlsxLoaderPromise = null;
    throw error;
  });
  return xlsxLoaderPromise;
}

async function readImportFile(file) {
  if (!file) throw new Error('กรุณาเลือกไฟล์ก่อน');
  if (file.size > 10 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 10 MB กรุณาแบ่งไฟล์เป็นส่วน ๆ');
  const extension = file.name.split('.').pop()?.toLowerCase();
  let matrix;
  let textMatrix = null;
  if (extension === 'csv') {
    const text = await file.text();
    matrix = parseCsv(text, detectCsvDelimiter(text));
  } else if (extension === 'xlsx' || extension === 'xls') {
    const XLSX = await loadXlsxLibrary();
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new Error('ไม่พบชีตข้อมูลในไฟล์ Excel');
    matrix = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: true });
    // อ่านซ้ำแบบ "ตามที่ Excel แสดง" ไว้ใช้กับคอลัมน์ข้อความ เช่น รหัสสินค้า
    // เพราะแบบ raw จะทำให้ 000123 กลายเป็น 123 และตัวเลขยาว ๆ ถูกปัดเศษ
    textMatrix = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: false });
  } else {
    throw new Error('รองรับเฉพาะไฟล์ .xlsx, .xls และ .csv');
  }

  matrix = matrix.map((row) => (Array.isArray(row) ? row : [row]));
  if (textMatrix) textMatrix = textMatrix.map((row) => (Array.isArray(row) ? row : [row]));
  let headerIndex = matrix.findIndex((row) =>
    row.some((cell) => {
      const key = importHeaderKey(cell);
      return IMPORT_FIELDS.some((field) => field.aliases.map(importHeaderKey).includes(key));
    }),
  );
  if (headerIndex < 0) headerIndex = matrix.findIndex((row) => row.filter((cell) => String(cell ?? '').trim() !== '').length >= 2);
  if (headerIndex < 0) throw new Error('ไม่พบหัวตารางในไฟล์');

  const width = Math.max(...matrix.slice(headerIndex).map((row) => row.length), 0);
  const headers = Array.from({ length: width }, (_, index) => String(matrix[headerIndex][index] ?? '').trim() || `คอลัมน์ ${index + 1}`);
  const dataRows = matrix
    .slice(headerIndex + 1)
    .map((cells, index) => ({
      cells,
      textCells: textMatrix?.[headerIndex + 1 + index] ?? cells,
      rowNumber: headerIndex + index + 2,
    }))
    .filter(({ cells }) => cells.some((cell) => String(cell ?? '').trim() !== ''));
  if (!dataRows.length) throw new Error('ไม่พบรายการสินค้าในไฟล์');
  return { fileName: file.name, headers, dataRows, mapping: guessImportMapping(headers) };
}

function invalidateImportPreview() {
  state.importRunId += 1;
  state.importPreview = null;
  const result = $('#importResult');
  if (result) result.innerHTML = '';
  const commit = $('#importCommitBtn');
  if (commit) {
    commit.hidden = true;
    commit.disabled = true;
  }
}

function renderImportMapping(file) {
  const box = $('#importMapping');
  if (!box) return;
  box.innerHTML = `
    <h3>จับคู่คอลัมน์จากไฟล์</h3>
    <p style="margin:0 0 10px;color:var(--body);font-size:12px">ตรวจชื่อคอลัมน์ให้ตรงกับข้อมูลด้านล่าง ถ้าชื่อไม่ตรงให้เลือกเองได้</p>
    ${IMPORT_FIELDS.map((field) => {
      const selected = file.mapping[field.key] ?? '';
      return `<div class="field"><label>${field.label}</label>
        <select data-import-map="${field.key}">
          <option value="">— ไม่ใช้คอลัมน์นี้ —</option>
          ${file.headers.map((header, index) => `<option value="${index}" ${String(selected) === String(index) ? 'selected' : ''}>${esc(header)}</option>`).join('')}
        </select>
      </div>`;
    }).join('')}`;
  $$('[data-import-map]', box).forEach((select) => select.addEventListener('change', (event) => {
    file.mapping[event.target.dataset.importMap] = event.target.value;
    invalidateImportPreview();
  }));
}

function buildImportRows() {
  const file = state.importFile;
  if (!file) throw new Error('กรุณาเลือกไฟล์ก่อน');
  for (const field of IMPORT_FIELDS.filter((item) => item.required)) {
    if (file.mapping[field.key] === '') throw new Error(`กรุณาเลือกคอลัมน์${field.label.replace(' *', '')}`);
  }
  const cell = (row, key) => {
    const index = file.mapping[key];
    if (index === '' || index === undefined) return '';
    const at = Number(index);
    return row[at] ?? '';
  };
  // คอลัมน์ข้อความใช้ค่าแบบที่ Excel แสดง (กันเลข 0 นำหน้าหาย)
  // คอลัมน์จำนวนใช้ค่าตัวเลขดิบ เพื่อไม่ให้เศษทศนิยมคลาดเคลื่อน
  return file.dataRows.map(({ cells, textCells, rowNumber }) => ({
    rowNumber,
    sku: String(cell(textCells, 'sku')).trim(),
    name: String(cell(textCells, 'name')).trim(),
    category: String(cell(textCells, 'category')).trim(),
    stock_qty: cell(cells, 'stock'),
    min_qty: cell(cells, 'min_qty'),
    unit: String(cell(textCells, 'unit')).trim(),
    barcode: String(cell(textCells, 'barcode')).trim(),
    note: String(cell(textCells, 'note')).trim(),
  }));
}

function importActionMeta(action) {
  return {
    create: { label: 'เพิ่มใหม่', cls: 'ok' },
    update: { label: 'อัปเดต', cls: 'warn' },
    unchanged: { label: 'ไม่เปลี่ยน', cls: 'muted' },
    skip: { label: 'ข้าม', cls: 'muted' },
    error: { label: 'ผิดพลาด', cls: 'danger' },
  }[action] ?? { label: action, cls: 'muted' };
}

function renderImportPreview(plan) {
  const box = $('#importResult');
  if (!box) return;
  state.importPreview = plan;
  const s = plan.summary;
  const summaryCard = (label, value, cls = '') => `<div class="import-stat ${cls}"><b>${fmt(value)}</b><span>${label}</span></div>`;
  const rows = plan.rows;
  box.innerHTML = `
    <div class="import-result-head">
      <h3>ผลตรวจแบบยังไม่บันทึก (Dry-run)</h3>
      <p>ตรวจข้อมูลกับคลัง <b>${esc(plan.location.name)}</b> แล้ว ยังไม่มีการเปลี่ยนแปลงข้อมูลจริง</p>
    </div>
    <div class="import-summary">
      ${summaryCard('เพิ่มใหม่', s.createCount, 'is-ok')}
      ${summaryCard('อัปเดต', s.updateCount, 'is-warn')}
      ${summaryCard('ไม่เปลี่ยน', s.unchangedCount)}
      ${summaryCard('ข้าม', s.skippedCount)}
      ${summaryCard('ผิดพลาด', s.errorCount, 'is-danger')}
      ${summaryCard('แก้รหัสซ้ำ', s.renamedCount)}
      ${summaryCard('ยอดรวมที่จะตั้ง', s.totalTargetQty, 'is-total')}
    </div>
    <div class="import-note">ยอดว่างในไฟล์จะถือเป็น 0 · แถวสรุปที่ไม่มีรหัสและชื่อสินค้าจะขึ้นเป็น “ข้าม” · ยอดของสินค้าเดิมจะถูก “ตั้งค่าตามไฟล์” ไม่ใช่บวกซ้ำ · ราคาไม่ได้นำเข้าเพราะระบบยังไม่มีช่องเก็บราคา</div>
    <div class="import-table-wrap">
      <table class="import-table">
        <thead><tr><th>แถว</th><th>SKU ที่จะใช้</th><th>ชื่อสินค้า</th><th>ผลลัพธ์</th><th>ยอด</th><th>เหตุผล</th></tr></thead>
        <tbody>${rows.map((row) => {
          const meta = importActionMeta(row.action);
          const delta = Number(row.delta) || 0;
          const qtyText = row.action === 'create'
            ? `ยกมา ${fmt(row.stockQty)}`
            : row.action === 'update' && Math.abs(delta) > 0.000001
              ? `${delta > 0 ? '+' : ''}${fmt(delta)} → ${fmt(row.stockQty)}`
              : fmt(row.stockQty);
          return `<tr class="import-row--${row.action}">
            <td>${row.rowNumber}</td>
            <td class="mono">${esc(row.sku || '—')}${row.renamed ? `<small>เดิม: ${esc(row.inputSku)}</small>` : ''}</td>
            <td>${esc(row.name || '—')}</td>
            <td><span class="import-status import-status--${meta.cls}">${meta.label}</span></td>
            <td class="mono">${qtyText}</td>
            <td>${esc(row.reason || '—')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="btn-grid" style="margin-top:14px">
      <button class="btn btn--ghost" type="button" data-import-edit>กลับไปแก้ไฟล์</button>
      <button class="btn btn--primary" type="button" id="importCommitBtn" ${plan.canCommit ? '' : 'disabled'}>ยืนยันนำเข้าจริง</button>
    </div>
    ${plan.canCommit ? '' : '<div class="import-error-note">มีรายการผิดพลาด ระบบจะไม่บันทึกทั้งไฟล์ กรุณาแก้ไขและตรวจสอบใหม่</div>'}`;
  $('[data-import-edit]')?.addEventListener('click', () => {
    invalidateImportPreview();
    $('#importPreviewBtn')?.focus();
  });
}

async function openProductImport() {
  if (!state.locations.length) {
    toast('ยังไม่มีคลังสินค้า กรุณาสร้างคลังในหน้าตั้งค่าก่อน', 'error');
    return;
  }
  const defaultLocation = state.locations.find((location) => location.is_default) ?? state.locations[0];
  state.importFile = null;
  state.importPreview = null;
  openSheet(`
    ${sheetHead('นำเข้าสินค้าจากไฟล์', 'รองรับ Excel (.xlsx/.xls) และ CSV • ไม่เกิน 1,000 แถวต่อครั้ง')}
    <div class="import-help">
      <b>ขั้นตอน:</b> เลือกไฟล์ → ตรวจชื่อคอลัมน์ → ดูผลตรวจ → กดยืนยันบันทึกจริง
      <br><span>ระบบจะไม่บันทึกทันทีจนกว่าคุณจะกด “ยืนยันนำเข้าจริง” และถ้ามีข้อผิดพลาดจะไม่บันทึกค้างไว้เพียงบางส่วน</span>
    </div>
    <div class="field"><label>ไฟล์ข้อมูล *</label><input id="importFileInput" type="file" accept=".xlsx,.xls,.csv" /></div>
    <div id="importFileInfo" class="import-file-info">ยังไม่ได้เลือกไฟล์</div>
    <div id="importMapping"></div>
    <div class="field"><label>นำยอดไปเก็บที่คลัง *</label><select id="importLocation">${state.locations.map((location) => `<option value="${location.id}" ${location.id === defaultLocation.id ? 'selected' : ''}>${esc(location.name)} (${esc(location.code)})</option>`).join('')}</select></div>
    <div class="field"><label>ถ้ารหัสสินค้าซ้ำในไฟล์</label><select id="importDuplicatePolicy"><option value="suffix">เติม -2, -3 ต่อท้าย (แนะนำ)</option><option value="skip">ข้ามรายการซ้ำ</option><option value="error">หยุดและให้แก้ไฟล์</option></select></div>
    <button class="btn btn--primary btn--block" id="importPreviewBtn" type="button" disabled>ตรวจสอบก่อนนำเข้า</button>
    <div id="importResult"></div>
  `);

  const fileInput = $('#importFileInput');
  const previewButton = $('#importPreviewBtn');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    previewButton.disabled = true;
    // invalidateImportPreview() ทำเลขรอบใหม่ให้แล้ว จึงเก็บค่านี้ไว้เทียบตอนผลกลับมา
    invalidateImportPreview();
    const runId = state.importRunId;
    $('#importFileInfo').textContent = 'กำลังอ่านไฟล์…';
    try {
      const parsed = await readImportFile(file);
      if (runId !== state.importRunId) return;
      state.importFile = parsed;
      const mapping = parsed.mapping;
      const missing = IMPORT_FIELDS.filter((field) => field.required && mapping[field.key] === '').map((field) => field.label.replace(' *', ''));
      $('#importFileInfo').textContent = `${file.name} · พบ ${fmt(parsed.dataRows.length)} แถว · ${parsed.headers.length} คอลัมน์`;
      renderImportMapping(parsed);
      previewButton.disabled = false;
      if (missing.length) toast(`กรุณาเลือกคอลัมน์เพิ่มเติม: ${missing.join(', ')}`, 'error');
    } catch (error) {
      if (runId !== state.importRunId) return;
      state.importFile = null;
      $('#importFileInfo').textContent = 'อ่านไฟล์ไม่สำเร็จ';
      $('#importMapping').innerHTML = '';
      toast(error.message, 'error');
    }
  });
  $('#importLocation').addEventListener('change', invalidateImportPreview);
  $('#importDuplicatePolicy').addEventListener('change', invalidateImportPreview);
  previewButton.addEventListener('click', async () => {
    state.importRunId += 1;
    const runId = state.importRunId;
    previewButton.disabled = true;
    previewButton.textContent = 'กำลังตรวจสอบ…';
    try {
      const payload = {
        rows: buildImportRows(),
        locationId: Number($('#importLocation').value),
        duplicatePolicy: $('#importDuplicatePolicy').value,
        filename: state.importFile.fileName,
      };
      const plan = await api('/products/import/preview', { method: 'POST', body: JSON.stringify(payload) });
      if (runId !== state.importRunId) return;
      renderImportPreview(plan);
      previewButton.textContent = 'ตรวจสอบใหม่';
    } catch (error) {
      if (runId !== state.importRunId) return;
      toast(error.message, 'error');
    } finally {
      if (runId === state.importRunId) previewButton.disabled = false;
    }
  });
}

async function commitProductImportFromSheet() {
  if (!state.importPreview?.canCommit || !state.importPreview.token) return;
  const button = $('#importCommitBtn');
  if (!button) return;
  const s = state.importPreview.summary;
  if (!confirm(`ยืนยันนำเข้าจริง ${fmt(s.createCount + s.updateCount)} รายการ\nเข้าคลัง ${state.importPreview.location.name}\nยอดรวมที่ตั้ง ${fmt(s.totalTargetQty)} หน่วย\n\nถ้ามีข้อผิดพลาด ระบบจะยกเลิกทั้งไฟล์ ไม่บันทึกค้างไว้บางส่วน`)) return;
  button.disabled = true;
  button.textContent = 'กำลังบันทึกทั้งไฟล์…';
  try {
    const result = await api('/products/import', {
      method: 'POST',
      body: JSON.stringify({ token: state.importPreview.token }),
    });
    closeSheet();
    toast(`นำเข้าสำเร็จ ${fmt(result.created + result.updated)} รายการ · เลขที่ ${result.ref ?? 'ไม่มีการเปลี่ยนแปลง'}`, 'ok');
    await refreshAll();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = 'ยืนยันนำเข้าจริง';
  }
}

/* --------------------------------------------------------- พิมพ์ QR ใหม่ */

function loadQrLibrary() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (qrLibraryPromise) return qrLibraryPromise;
  qrLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
    script.async = true;
    script.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('โหลดไลบรารี QR ไม่สำเร็จ')));
    script.onerror = () => reject(new Error('โหลดไลบรารี QR ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'));
    document.head.appendChild(script);
  }).catch((error) => {
    qrLibraryPromise = null;
    throw error;
  });
  return qrLibraryPromise;
}

async function openQrPrint() {
  openSheet(`${sheetHead('กำลังเตรียม QR…', 'กำลังดึงรายการสินค้า')}<div class="skeleton" style="height:120px"></div>`);
  try {
    const QR_PAGE_LIMIT = 1000;
    const products = await api(`/products?limit=${QR_PAGE_LIMIT}`);
    if (!products.length) {
      toast('ยังไม่มีสินค้าให้สร้าง QR', 'error');
      closeSheet();
      return;
    }
    const qrcode = await loadQrLibrary();
    const truncated = products.length >= QR_PAGE_LIMIT;
    openSheet(`
      ${sheetHead('พิมพ์ QR สินค้า', `สร้างจาก SKU จำนวน ${fmt(products.length)} รายการ`)}
      <div class="qr-toolbar"><button class="btn btn--primary" id="printQrBtn" type="button">พิมพ์ / บันทึกเป็น PDF</button><span>QR จะเก็บเฉพาะรหัสสินค้า และสร้างบนเครื่องนี้</span></div>
      ${truncated ? `<div class="import-error-note">สินค้ามีมากกว่า ${fmt(QR_PAGE_LIMIT)} รายการ หน้านี้แสดงเฉพาะ ${fmt(QR_PAGE_LIMIT)} รายการแรก หากต้องการพิมพ์ทั้งหมดให้พิมพ์ทีละช่วงโดยใช้ช่องค้นหาเพื่อกรองก่อน</div>` : ''}
      <div class="qr-grid" id="qrGrid"></div>
    `);
    const grid = $('#qrGrid');
    for (let i = 0; i < products.length; i += 1) {
      const product = products[i];
      const label = document.createElement('div');
      label.className = 'qr-label';
      label.innerHTML = `<div class="qr-label__name">${esc(product.name)}</div><div class="qr-label__code mono">${esc(product.sku)}</div><div class="qr-label__image"></div>`;
      grid.appendChild(label);
      const qr = qrcode(0, 'M');
      qr.addData(product.sku);
      qr.make();
      label.querySelector('.qr-label__image').innerHTML = qr.createSvgTag(4, 2);
      if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    $('#printQrBtn').addEventListener('click', () => window.print());
  } catch (error) {
    toast(error.message, 'error');
    closeSheet();
  }
}

/* ------------------------------------------------------ ฟอร์มสินค้า */

function openProductForm(product = null) {
  const p = product ?? {};
  openSheet(`
    ${sheetHead(product ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่', product ? p.sku : 'กรอกข้อมูลสินค้าที่ต้องการเก็บสต๊อก')}
    <form id="productForm" style="margin-top:14px">
      <div class="field"><label>ชื่อสินค้า *</label><input name="name" required value="${esc(p.name ?? '')}" placeholder="เช่น ปากกาลูกลื่น น้ำเงิน" /></div>
      <div class="field--row">
        <div class="field"><label>รหัสสินค้า (SKU)</label><input name="sku" value="${esc(p.sku ?? '')}" placeholder="เว้นว่างให้ระบบสร้าง" /></div>
        <div class="field"><label>หน่วยนับ</label><input name="unit" value="${esc(p.unit ?? 'ชิ้น')}" /></div>
      </div>
      <div class="field">
        <label>บาร์โค้ด</label>
        <div style="display:flex;gap:8px">
          <input name="barcode" value="${esc(p.barcode ?? '')}" placeholder="สแกนหรือพิมพ์" style="flex:1" />
          <button type="button" class="btn btn--ghost" id="scanIntoField">สแกน</button>
        </div>
      </div>
      <div class="field--row">
        <div class="field"><label>หมวดหมู่</label><input name="category" value="${esc(p.category ?? '')}" placeholder="เช่น เครื่องเขียน" /></div>
        <div class="field"><label>จุดสั่งซื้อขั้นต่ำ</label><input name="min_qty" type="number" min="0" step="any" value="${p.min_qty ?? 0}" /></div>
      </div>
      ${
        product
          ? ''
          : `<div class="field--row">
              <div class="field"><label>ยอดยกมา</label><input name="initial_qty" type="number" min="0" step="any" value="0" /></div>
              <div class="field"><label>เก็บที่คลัง</label><select name="location_id">${state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
            </div>`
      }
      <div class="field"><label>หมายเหตุ</label><input name="note" value="${esc(p.note ?? '')}" /></div>
      <button class="btn btn--primary btn--block" type="submit">${product ? 'บันทึกการแก้ไข' : 'เพิ่มสินค้า'}</button>
      ${product ? `<button class="btn btn--danger btn--block" style="margin-top:8px" type="button" id="archiveBtn">นำสินค้าออกจากระบบ</button>` : ''}
    </form>
  `);

  const form = $('#productForm');
  $('#scanIntoField')?.addEventListener('click', async () => {
    const code = await scan();
    if (code) form.barcode.value = code;
  });

  $('#archiveBtn')?.addEventListener('click', async () => {
    if (!confirm('ต้องการนำสินค้านี้ออกจากระบบหรือไม่? ประวัติเดิมจะยังอยู่')) return;
    try {
      await api(`/products/${p.id}`, { method: 'DELETE' });
      closeSheet();
      toast('นำสินค้าออกแล้ว', 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    body.min_qty = Number(body.min_qty || 0);
    if (body.initial_qty !== undefined) body.initial_qty = Number(body.initial_qty || 0);
    if (body.location_id !== undefined) body.location_id = Number(body.location_id || 0);
    try {
      if (product) await api(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/products', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      toast(product ? 'บันทึกแล้ว' : 'เพิ่มสินค้าแล้ว', 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* -------------------------------------------------------- ฟอร์มคลัง */

function openLocationForm(location = null) {
  const l = location ?? {};
  openSheet(`
    ${sheetHead(location ? 'แก้ไขคลัง' : 'เพิ่มคลังใหม่', location ? l.code : 'สร้างที่เก็บสินค้าใหม่')}
    <form id="locForm" style="margin-top:14px">
      <div class="field--row">
        <div class="field"><label>รหัสคลัง *</label><input name="code" required value="${esc(l.code ?? '')}" placeholder="MAIN" /></div>
        <div class="field"><label>ชื่อคลัง *</label><input name="name" required value="${esc(l.name ?? '')}" placeholder="คลังกลาง" /></div>
      </div>
      <label style="display:flex;gap:10px;align-items:center;font-size:13px;margin:6px 0 16px">
        <input type="checkbox" name="is_default" ${l.is_default ? 'checked' : ''} style="width:18px;height:18px" />
        ตั้งเป็นคลังเริ่มต้น
      </label>
      <button class="btn btn--primary btn--block" type="submit">${location ? 'บันทึก' : 'เพิ่มคลัง'}</button>
      ${location ? `<button class="btn btn--danger btn--block" style="margin-top:8px" type="button" id="delLoc">ลบคลังนี้</button>` : ''}
    </form>
  `);

  const form = $('#locForm');
  $('#delLoc')?.addEventListener('click', async () => {
    if (!confirm('ลบคลังนี้หรือไม่?')) return;
    try {
      await api(`/locations/${l.id}`, { method: 'DELETE' });
      closeSheet();
      toast('ลบคลังแล้ว', 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      code: form.code.value.trim(),
      name: form.name.value.trim(),
      is_default: form.is_default.checked,
    };
    try {
      if (location) await api(`/locations/${l.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/locations', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      toast('บันทึกแล้ว', 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------- สแกน */

async function scan() {
  try {
    const canScan = window.liff?.isApiAvailable?.('scanCodeV2')
      || (window.liff?.isInClient?.() && window.liff?.scanCodeV2);
    if (canScan && window.liff?.scanCodeV2) {
      const result = await window.liff.scanCodeV2();
      return result?.value ?? null;
    }
  } catch (err) {
    console.warn('scanCodeV2 failed', err);
  }
  const manual = prompt('กรอกรหัสสินค้า หรือข้อความ QR (อุปกรณ์นี้เปิดกล้องสแกนผ่าน LINE ไม่ได้)');
  return manual?.trim() || null;
}

async function scanAndOpen() {
  const code = await scan();
  if (!code) return;
  try {
    const { product } = await api(`/products/lookup/${encodeURIComponent(code)}`);
    openProduct(product.id);
  } catch (error) {
    if (error.status === 409) {
      toast(error.message, 'error');
      return;
    }
    if (error.status !== 404) {
      toast(error.message || 'อ่าน QR ไม่สำเร็จ ลองใหม่อีกครั้ง', 'error');
      return;
    }
    if (confirm(`ไม่พบสินค้าจาก QR หรือรหัส ${code}\nต้องการเพิ่มเป็นสินค้าใหม่หรือไม่?`)) {
      openProductForm();
      setTimeout(() => {
        const el = $('#productForm')?.barcode;
        if (el) el.value = code;
      }, 60);
    }
  }
}

/* ----------------------------------------------------------- routing */

function switchTab(tab) {
  if (!['overview', 'products', 'history', 'settings'].includes(tab)) return;
  state.tab = tab;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== tab));
  $$('.tab[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  $('#topbarSubtitle').textContent = {
    overview: 'ภาพรวมวันนี้',
    products: 'รายการสินค้าทั้งหมด',
    history: 'ประวัติการเคลื่อนไหว',
    settings: 'ตั้งค่าระบบ',
  }[tab];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (tab === 'history') renderHistory();
}

/* ---------------------------------------------------------- listeners */

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab[data-tab]');
  if (tab) return switchTab(tab.dataset.tab);

  if (e.target.closest('#fabScan') || e.target.closest('#scanBtn')) return scanAndOpen();
  if (e.target.closest('[data-close]') || e.target.closest('#backdrop')) return closeSheet();

  const goto = e.target.closest('[data-goto]');
  if (goto) {
    if (goto.dataset.status) {
      state.filters.status = goto.dataset.status;
      $$('#statusChips .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.status === goto.dataset.status));
      loadProducts().then(renderProducts);
    }
    return switchTab(goto.dataset.goto);
  }

  const product = e.target.closest('[data-product]');
  if (product) return openProduct(Number(product.dataset.product));

  const move = e.target.closest('[data-move]');
  if (move) return openMovement(Number(move.dataset.id), move.dataset.move);

  const edit = e.target.closest('[data-edit-product]');
  if (edit) {
    const id = Number(edit.dataset.editProduct);
    return api(`/products/${id}`).then(({ product }) => openProductForm(product));
  }

  const loc = e.target.closest('[data-location]');
  if (loc) return openLocationForm(state.locations.find((l) => l.id === Number(loc.dataset.location)));

  if (e.target.closest('#importProductBtn')) return openProductImport();
  if (e.target.closest('#addProductBtn')) return openProductForm();
  if (e.target.closest('#qrPrintBtn')) return openQrPrint();
  if (e.target.closest('#importCommitBtn')) return commitProductImportFromSheet();
  if (e.target.closest('#addLocationBtn')) return openLocationForm();

  const chip = e.target.closest('#statusChips .chip[data-status]');
  if (chip) {
    state.filters.status = chip.dataset.status;
    $$('#statusChips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    return loadProducts().then(renderProducts);
  }

  const hChip = e.target.closest('#historyChips .chip');
  if (hChip) {
    state.historyType = hChip.dataset.type;
    $$('#historyChips .chip').forEach((c) => c.classList.toggle('is-active', c === hChip));
    return renderHistory();
  }
});

let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = e.target.value.trim();
    loadProducts().then(renderProducts);
  }, 280);
});

$('#locationFilter').addEventListener('change', (e) => {
  state.filters.locationId = e.target.value;
  loadProducts().then(renderProducts);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});

boot();
