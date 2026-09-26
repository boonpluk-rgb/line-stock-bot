-- คำขอเบิกจากพนักงาน
--   พนักงานสั่งเบิก → เข้า "รายการรอจัด" (ยังไม่ตัดสต๊อก)
--   ผู้ดูแลกด "จัดแล้ว" → ค่อยตัดสต๊อกจริง + ลง movements
--   ถ้าคำขอถูกจัดไปแล้ว/ยกเลิก จะเก็บไว้เป็นประวัติ (ไม่ลบ)

CREATE TABLE requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT NOT NULL,
  line_user_id   TEXT,
  user_name      TEXT,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id    INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  qty            REAL NOT NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','fulfilling','fulfilled','cancelled')),
  -- ตั้งไว้ตอนส่งคำขอ ถ้าของในคลังไม่พอ (เช่น "ของหมด เหลือ 0 จาก 5")
  short_note     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  done_at        TEXT,
  done_by        TEXT,
  done_note      TEXT
);
CREATE INDEX idx_requests_status ON requests(status, id DESC);
CREATE INDEX idx_requests_user ON requests(line_user_id, id DESC);
