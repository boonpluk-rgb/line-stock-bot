import type { ActionType } from '../types';
import { parseNumber } from '../lib/util';

export type Intent =
  | { kind: 'action'; action: ActionType; query: string; qty?: number; locations: string[]; note?: string }
  | { kind: 'check'; query: string }
  | { kind: 'barcode'; code: string }
  | { kind: 'low' }
  | { kind: 'history'; query?: string }
  | { kind: 'locations' }
  | { kind: 'summary' }
  | { kind: 'myreq' }
  | { kind: 'pendingreq' }
  | { kind: 'help' }
  | { kind: 'cancel' }
  | { kind: 'number'; value: number }
  | { kind: 'unknown'; text: string };

type IntentName =
  | ActionType
  | 'check'
  | 'low'
  | 'history'
  | 'locations'
  | 'summary'
  | 'myreq'
  | 'pendingreq'
  | 'help'
  | 'cancel';

interface KeywordGroup {
  intent: IntentName;
  /**
   * คำที่ต้องเว้นวรรคถึงจะแยกได้ — เก็บคำสั้น ๆ ที่อาจเป็นส่วนหนึ่งของชื่อสินค้าไว้ตรงนี้
   * เช่น "หา" (หางคู่ตัด), "เติม" (เติมพิมพ์), "นับ", "สต๊อก", "in"
   */
  words: string[];
  /**
   * คำที่ยาว/เฉพาะเจาะจงพอ จะเดาว่าเป็นคำสั่งแม้ผู้ใช้พิมพ์ติดกัน
   * เช่น "เบิกปากกา5" ไม่ต้องมีช่องว่างก็ต้องออกมาเป็นคำสั่ง "เบิก"
   */
  loose?: string[];
}

const KEYWORDS: KeywordGroup[] = [
  { intent: 'issue', words: ['จ่าย', 'issue', 'out'], loose: ['เบิก', 'เบิกของ', 'ตัดสต๊อก', 'จ่ายออก'] },
  { intent: 'receive', words: ['เติม', 'receive', 'in'], loose: ['รับเข้า', 'รับของ', 'รับ', 'เพิ่มสต๊อก', 'เติมสต๊อก'] },
  { intent: 'adjust', words: ['adjust'], loose: ['ปรับ', 'ปรับยอด', 'ปรับสต๊อก', 'นับสต๊อก', 'นับจริง', 'นับ'] },
  { intent: 'transfer', words: ['transfer', 'move'], loose: ['ย้าย', 'ย้ายคลัง', 'โอน', 'โอนคลัง'] },
  { intent: 'check', words: ['หา', 'สต๊อก', 'สต็อก', 'คงเหลือ', 'check', 'stock', 'find'], loose: ['เช็ค', 'เช็ก', 'ตรวจสอบ', 'ตรวจ', 'ค้นหา'] },
  { intent: 'low', words: ['เตือน', 'low', 'alert'], loose: ['ใกล้หมด', 'ของใกล้หมด', 'ต่ำกว่า'] },
  { intent: 'history', words: ['history', 'log'], loose: ['ประวัติ', 'รายการล่าสุด', 'รายการ', 'ล่าสุด'] },
  { intent: 'locations', words: ['locations', 'warehouse'], loose: ['คลังสินค้า', 'คลัง', 'สาขา', 'ที่เก็บ'] },
  { intent: 'summary', words: ['dashboard', 'summary'], loose: ['สรุป', 'ภาพรวม', 'รายงาน'] },
  { intent: 'myreq', words: [], loose: ['คำขอของฉัน', 'คำขอฉัน', 'คำขอของหนู', 'คำขอของผม', 'คำขอของเรา'] },
  { intent: 'pendingreq', words: [], loose: ['รายการรอจัด', 'รอจัดส่ง', 'รอจัด', 'คำขอที่รอ', 'คำขอรอจัด', 'คำขอ'] },
  { intent: 'help', words: ['help', 'menu', 'start', '?'], loose: ['ช่วยเหลือ', 'วิธีใช้', 'เมนู', 'คำสั่ง'] },
  { intent: 'cancel', words: ['cancel'], loose: ['ยกเลิก', 'ยุติ', 'ไม่เอา'] },
];

/** รวมคำสั่งทั้งหมดเรียงจากยาวไปสั้น เพื่อให้ "รับเข้า" ชนะ "รับ" */
const CANDIDATES = KEYWORDS.flatMap((k) => [
  ...(k.loose ?? []).map((w) => ({ intent: k.intent, word: w, loose: true })),
  ...k.words.map((w) => ({ intent: k.intent, word: w, loose: false })),
]).sort((a, b) => b.word.length - a.word.length);

const ACTIONS: ActionType[] = ['issue', 'receive', 'adjust', 'transfer'];

/** ตีความข้อความจากผู้ใช้เป็นคำสั่ง */
export function parse(raw: string): Intent {
  const input = raw.replace(/\s+/g, ' ').trim();
  if (!input) return { kind: 'unknown', text: raw };

  // ข้อความที่เป็นตัวเลขล้วน: บาร์โค้ด (>=8 หลัก) หรือคำตอบจำนวน
  if (/^[0-9.,]+$/.test(input)) {
    const digits = input.replace(/[.,]/g, '');
    if (digits.length >= 8) return { kind: 'barcode', code: digits };
    const n = parseNumber(input);
    if (n !== null) return { kind: 'number', value: n };
  }

  const lower = input.toLowerCase();
  let matched: IntentName | undefined;
  let rest = '';
  for (const c of CANDIDATES) {
    if (lower === c.word) { matched = c.intent; rest = ''; break; }
    if (lower.startsWith(c.word + ' ')) { matched = c.intent; rest = input.slice(c.word.length).trim(); break; }
    // คำในกลุ่ม loose เดาได้แม้ไม่เว้นวรรค เช่น "เบิกปากกา5"
    if (c.loose && lower.startsWith(c.word) && c.word.length < input.length) {
      matched = c.intent;
      rest = input.slice(c.word.length).trim();
      break;
    }
  }

  if (!matched) {
    // ไม่ตรงคำสั่งใด → ถือเป็นการค้นหาสินค้า
    return { kind: 'check', query: input };
  }

  switch (matched) {
    case 'help': return { kind: 'help' };
    case 'cancel': return { kind: 'cancel' };
    case 'low': return { kind: 'low' };
    case 'locations': return rest ? { kind: 'check', query: rest } : { kind: 'locations' };
    case 'summary': return { kind: 'summary' };
    case 'myreq': return { kind: 'myreq' };
    case 'pendingreq': return { kind: 'pendingreq' };
    case 'history': return { kind: 'history', query: rest || undefined };
    case 'check': return { kind: 'check', query: rest };
    default: break;
  }

  const action = matched as ActionType;
  if (!ACTIONS.includes(action)) return { kind: 'unknown', text: input };

  // แยกหมายเหตุหลัง #
  let body = rest;
  let note: string | undefined;
  const hash = body.indexOf('#');
  if (hash >= 0) {
    note = body.slice(hash + 1).trim() || undefined;
    body = body.slice(0, hash).trim();
  }

  // แยกคลังที่ระบุด้วย @
  const locations: string[] = [];
  body = body
    .replace(/@([^\s@#]+)/g, (_m, g1: string) => {
      locations.push(g1);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  // จำนวน = ตัวเลขตัวสุดท้ายในข้อความ
  const tokens = body.split(' ').filter(Boolean);
  let qty: number | undefined;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const n = parseNumber(tokens[i]);
    if (n !== null) {
      qty = n;
      tokens.splice(i, 1);
      break;
    }
  }

  // คนไทยมักพิมพ์ติดกันไม่เว้นวรรค เช่น "เบิกปากกา5" → ชื่อ "ปากกา" จำนวน 5
  // เงื่อนไข: ต้องเป็นคำเดียวทั้งหมด และตัวเลขต้องต่อหลังตัวอักษรไทย
  // (กันไม่ให้กินรหัสสินค้าที่มีตัวเลขผสม เช่น "เบิกA4" หรือ "เบิกกระดาษ A410")
  if (qty === undefined && tokens.length === 1) {
    const m = tokens[0].match(/^(.*[฀-๿])\s*([0-9๐-๙][0-9๐-๙.,]*)$/);
    if (m) {
      const n = parseNumber(m[2]);
      if (n !== null) {
        qty = n;
        tokens[0] = m[1].trim();
      }
    }
  }

  return { kind: 'action', action, query: tokens.join(' ').trim(), qty, locations, note };
}
