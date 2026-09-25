#!/usr/bin/env bash
# สร้าง/อัปเดตริชเมนูของบอท
#   1) เรนเดอร์ menu.html -> richmenu.png ด้วย headless Chrome (ตัวอักษรไทยถูกต้อง)
#   2) สร้าง rich menu จาก richmenu.json แล้วอัปโหลดรูป
#   3) ตั้งเป็นเมนูเริ่มต้นของผู้ใช้ทุกคน และลบเมนูเก่าทิ้ง
#
# ใช้งาน:  LIFF_ID=xxxx-yyyy LINE_CHANNEL_ACCESS_TOKEN=xxxxx ./richmenu/deploy-richmenu.sh
#          (ถ้าไม่ใส่ LIFF_ID จะอ่านจาก wrangler.jsonc ให้อัตโนมัติ)
set -euo pipefail
cd "$(dirname "$0")"

: "${LINE_CHANNEL_ACCESS_TOKEN:?ต้องกำหนดตัวแปร LINE_CHANNEL_ACCESS_TOKEN ก่อน}"

# หา LIFF ID: จาก env ก่อน ถ้าไม่มีก็อ่านจาก wrangler.jsonc
if [ -z "${LIFF_ID:-}" ]; then
  LIFF_ID=$(grep -o '"LIFF_ID"[[:space:]]*:[[:space:]]*"[^"]*"' ../wrangler.jsonc | sed 's/.*"\([^"]*\)"$/\1/')
fi
[ -n "$LIFF_ID" ] || { echo "หา LIFF_ID ไม่เจอ — ใส่ใน wrangler.jsonc หรือส่งมาทาง LIFF_ID=..."; exit 1; }
echo "▶ ใช้ LIFF ID: $LIFF_ID"
AUTH="authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

echo "▶ เรนเดอร์รูปเมนู…"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=2500,1686 --screenshot=richmenu.png "file://$PWD/menu.html" 2>/dev/null
echo "  รูปขนาด $(du -h richmenu.png | cut -f1)"

PAYLOAD=$(sed "s/__LIFF_ID__/$LIFF_ID/g" richmenu.json)

# ตรวจข้อความไทยและความยาวก่อนส่ง เพื่อไม่ให้ LINE ตอบ 400 แล้วเดาเองว่าสาเหตุคืออะไร
python3 - "$PAYLOAD" <<'PY'
import json, re, sys
data = json.loads(sys.argv[1])
# อักขระยุโรปที่เหลือคือสัญญาณว่าไฟล์ถูกอ่านผิด encoding (เช่น à¹€à¸Šà¸‡à¸)
if re.search(r'[\u00c0-\u00ff]', json.dumps(data, ensure_ascii=False)):
    sys.exit('หยุด: ข้อความใน richmenu.json เพี้ยน ต้องอ่านไฟล์เป็น UTF-8')
bar = data['chatBarText']
if len(bar) > 14:
    sys.exit(f'หยุด: chatBarText "{bar}" ยาว {len(bar)} ตัวอักษร (LINE อนุญาต 14)')
for area in data['areas']:
    label = area['action'].get('label')
    if label and len(label) > 20:
        sys.exit(f'หยุด: ป้าย "{label}" ยาว {len(label)} ตัวอักษร (LINE อนุญาต 20)')
print(f'  ✓ ข้อความถูกต้อง: "{bar}" ({len(bar)} ตัวอักษร)')
PY

echo "▶ ตรวจสอบกับ LINE ก่อน…"
VALIDATE=$(curl -s -w '\n%{http_code}' -X POST https://api.line.me/v2/bot/richmenu/validate \
  -H "$AUTH" -H 'content-type: application/json' \
  --data-binary "$PAYLOAD")
if [ "$(printf '%s' "$VALIDATE" | tail -n1)" != "200" ]; then
  echo "หยุด: LINE ไม่รับเมนูนี้ —"
  printf '%s\n' "$VALIDATE" | head -n -1
  exit 1
fi
echo "  ✓ LINE ผ่านการตรวจสอบ"

echo "▶ สร้างริชเมนูใหม่…"
CREATE=$(curl -s -w '\n%{http_code}' -X POST https://api.line.me/v2/bot/richmenu \
  -H "$AUTH" -H 'content-type: application/json' \
  --data-binary "$PAYLOAD")
if [ "$(printf '%s' "$CREATE" | tail -n1)" != "200" ]; then
  echo "หยุด: สร้างริชเมนูไม่สำเร็จ —"
  printf '%s\n' "$CREATE" | head -n -1
  exit 1
fi
NEW_ID=$(printf '%s' "$CREATE" | head -n -1 |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["richMenuId"])')
echo "  $NEW_ID"

echo "▶ อัปโหลดรูป…"
curl -s -X POST "https://api-data.line.me/v2/bot/richmenu/$NEW_ID/content" \
  -H "$AUTH" -H 'content-type: image/png' --data-binary @richmenu.png > /dev/null

echo "▶ ตั้งเป็นเมนูเริ่มต้น…"
curl -s -X POST "https://api.line.me/v2/bot/user/all/richmenu/$NEW_ID" \
  -H "$AUTH" -H 'content-length: 0' > /dev/null

echo "▶ ลบริชเมนูเก่า…"
for OLD in $(curl -s https://api.line.me/v2/bot/richmenu/list -H "$AUTH" |
  python3 -c 'import sys,json; print(" ".join(m["richMenuId"] for m in json.load(sys.stdin)["richmenus"]))'); do
  if [ "$OLD" != "$NEW_ID" ]; then
    curl -s -X DELETE "https://api.line.me/v2/bot/richmenu/$OLD" -H "$AUTH" > /dev/null
    echo "  ลบ $OLD"
  fi
done

# ยืนยันว่าข้อความที่ LINE เก็บตรงกับไฟล์จริง (กันปัญหาอักขระเพี้ยน)
SAVED=$(curl -s "https://api.line.me/v2/bot/richmenu/$NEW_ID" -H "$AUTH")
python3 - "$SAVED" "$PAYLOAD" <<'PY'
import json, re, sys
saved, sent = json.loads(sys.argv[1]), json.loads(sys.argv[2])
if re.search(r'[\u00c0-\u00ff]', json.dumps(saved, ensure_ascii=False)):
    sys.exit('หยุด: LINE เก็บข้อความเพี้ยน อย่าใช้เมนูนี้')
if saved['chatBarText'] != sent['chatBarText']:
    sys.exit('หยุด: ข้อความบน LINE ไม่ตรงกับไฟล์')
print(f'  ✓ ยืนยันบน LINE แล้ว: "{saved["chatBarText"]}"')
PY

echo "✅ เสร็จแล้ว — ปิดแล้วเปิดห้องแชทใหม่เพื่อดูเมนูล่าสุด"
