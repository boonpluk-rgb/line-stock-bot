-- ระบบสิทธิ์ 2 ระดับ
--   owner = ผู้ดูแล  (ทำได้ทุกอย่าง: เพิ่ม/แก้/ลบสินค้า, นำเข้า Excel, ปรับยอด, ตั้งสิทธิ์)
--   staff = พนักงาน (ดูสต๊อก, ค้นหา, สั่งเบิก)
-- ค่าเริ่มต้นของทุกคนคือ staff — ปลอดภัยที่สุด

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ตั้งผู้ดูแลเริ่มต้น: บัญชีของ "พี่ปลูก" ที่ใช้จริงอยู่ 4 บัญชี (มือถือ + แท็บเล็ต)
-- แก้/เพิ่มผู้ดูแลคนอื่นได้จากหน้า ตั้งค่า > บัญชีผู้ใช้ ในแดชบอร์ด
UPDATE users SET role = 'owner' WHERE line_user_id IN (
  'Ueb91902047af217f92b03d0696618c30',
  'Uc5175bb5ed11849f81374fb241839b06',
  'U7028dd88396a5efb67816578bf33bf39',
  'U7c661350aaf661809cd04ba331b99599'
);
