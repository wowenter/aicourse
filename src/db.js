// Таблицы создаются автоматически при первом запросе — ничего запускать вручную не нужно.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clicks (
     code TEXT PRIMARY KEY, ttclid TEXT, ttp TEXT, ip TEXT, ua TEXT, page_url TEXT,
     utm_source TEXT, utm_campaign TEXT, utm_adgroup TEXT, utm_ad TEXT,
     created_at INTEGER, opened_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS users (
     tg_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, click_code TEXT,
     started_at INTEGER, checkout_at INTEGER, paid_at INTEGER, amount INTEGER,
     reminders_sent INTEGER DEFAULT 0, next_reminder_at INTEGER, blocked INTEGER DEFAULT 0,
     access_link TEXT)`,
  `CREATE TABLE IF NOT EXISTS payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER, order_id TEXT UNIQUE,
     static_qr_id TEXT, invoice_id TEXT, payment_url TEXT, status TEXT,
     amount INTEGER, created_at INTEGER, paid_at INTEGER, is_test INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS checkouts (
     token TEXT PRIMARY KEY, payment_id INTEGER UNIQUE NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
     invoice_payment_id INTEGER, invoice_state TEXT DEFAULT 'none')`,
  `CREATE TABLE IF NOT EXISTS payment_delivery (
     payment_id INTEGER PRIMARY KEY, state TEXT DEFAULT 'pending',
     lock_until INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0,
     access_link TEXT, credited_at INTEGER, delivered_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payments(invoice_id)`,
  `CREATE TABLE IF NOT EXISTS payment_expiry_notices (
     payment_id INTEGER PRIMARY KEY, sent_at INTEGER,
     lock_until INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_users_rem ON users(next_reminder_at)`,
  `CREATE INDEX IF NOT EXISTS idx_users_started ON users(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pay_qr ON payments(static_qr_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pay_tg ON payments(tg_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clicks_created ON clicks(created_at)`,
];

let ready = false;
export async function ensureSchema(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  ready = true;
}

export const now = () => Math.floor(Date.now() / 1000);

export async function getSetting(db, key, def = null) {
  const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return r ? r.value : def;
}
export async function setSetting(db, key, value) {
  await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(key, String(value)).run();
}

export async function getUserWithClick(db, tgId) {
  return db.prepare(
    `SELECT u.*, c.ttclid, c.ttp, c.ip, c.ua, c.page_url, c.utm_campaign, c.utm_adgroup, c.utm_ad
     FROM users u LEFT JOIN clicks c ON c.code = u.click_code WHERE u.tg_id=?`
  ).bind(tgId).first();
}

// Время Алматы (UTC+5)
const TZ = 5 * 3600;
export function dayStart(ts = now()) {
  return Math.floor((ts + TZ) / 86400) * 86400 - TZ;
}
export function fmtTime(ts) {
  if (!ts) return '';
  return new Date((ts + TZ) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

