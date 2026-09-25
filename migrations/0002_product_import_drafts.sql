-- ร่างนำเข้าสินค้า: เก็บผลตรวจไว้ฝั่ง server เพื่อให้ commit ใช้ข้อมูลเดียวกับ preview
-- และป้องกันการกดยืนยันซ้ำหรือแก้ payload ระหว่างอยู่ระหว่าง preview กับ commit
CREATE TABLE product_import_drafts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL UNIQUE,
  actor_line_id  TEXT NOT NULL,
  location_id    INTEGER NOT NULL REFERENCES locations(id),
  duplicate_policy TEXT NOT NULL CHECK (duplicate_policy IN ('suffix', 'skip', 'error')),
  filename       TEXT,
  payload        TEXT NOT NULL,
  plan_json      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'committing', 'committed', 'cancelled')),
  ref            TEXT,
  result_json    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     INTEGER NOT NULL,
  committed_at   TEXT
);
CREATE INDEX idx_product_import_drafts_actor_status
  ON product_import_drafts(actor_line_id, status);
CREATE INDEX idx_product_import_drafts_expiry
  ON product_import_drafts(status, expires_at);
