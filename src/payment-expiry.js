import { now, getSetting, setSetting } from './db.js';
import { tg } from './telegram.js';
import { PAY_EXPIRED_TEXT, PAY_REFRESH_BUTTON } from './texts.js';

// QR expiry is 180 seconds from creation. Phone invoices expire only when Kaspi says so.
// Only the latest payment attempt may trigger a message; successful or active newer
// attempts suppress old QR notifications, including a phone invoice from that page.
const eligible = `p.is_test=0 AND u.paid_at IS NULL AND COALESCE(u.blocked,0)=0
  AND p.created_at>=?
  AND ((p.order_id LIKE 'kq%' AND p.created_at<=? AND p.status IN ('pending','expired'))
       OR (p.order_id LIKE 'ki%' AND p.status='expired'))
  AND NOT EXISTS (SELECT 1 FROM payments paid WHERE paid.tg_id=p.tg_id AND paid.status='paid')
  AND NOT EXISTS (SELECT 1 FROM payments newer WHERE newer.tg_id=p.tg_id AND newer.id>p.id
    AND (newer.order_id LIKE 'kq%' OR newer.order_id LIKE 'ki%'))`;

export async function runPaymentExpiryNotices(env) {
  if (await getSetting(env.DB, 'checkout_enabled', '0') !== '1') return;
  const db = env.DB;
  const t = now();
  const since = Number(await getSetting(db, 'payment_expiry_notices_since', '0'));
  if (!since) {
    // Start prospectively: do not message everyone with an old unpaid order at deploy time.
    await setSetting(db, 'payment_expiry_notices_since', t);
    return;
  }
  const {results} = await db.prepare(`SELECT p.id,p.tg_id FROM payments p JOIN users u ON u.tg_id=p.tg_id
    LEFT JOIN payment_expiry_notices n ON n.payment_id=p.id
    WHERE ${eligible} AND n.sent_at IS NULL AND COALESCE(n.lock_until,0)<=?
    ORDER BY p.created_at LIMIT 20`).bind(since, t - 180, t).all();
  for (const p of results) {
    try {
      await db.prepare('INSERT OR IGNORE INTO payment_expiry_notices(payment_id) VALUES(?)').bind(p.id).run();
      const claim = await db.prepare(`UPDATE payment_expiry_notices SET lock_until=?,attempts=attempts+1
        WHERE payment_id=? AND sent_at IS NULL AND lock_until<=? RETURNING *`).bind(t + 120, p.id, t).first();
      if (!claim) continue;
      // Recheck after acquiring the lease: payment or a new link may have arrived meanwhile.
      const current = await db.prepare(`SELECT p.id FROM payments p JOIN users u ON u.tg_id=p.tg_id
        WHERE ${eligible} AND p.id=?`).bind(since, now() - 180, p.id).first();
      if (!current) continue;
      const result = await tg(env.SALES_BOT_TOKEN, 'sendMessage', {
        chat_id: p.tg_id, text: PAY_EXPIRED_TEXT,
        reply_markup: {inline_keyboard: [[{text: PAY_REFRESH_BUTTON, callback_data: 'pay:refresh'}]]},
      });
      if (result.ok) {
        await db.prepare('UPDATE payment_expiry_notices SET sent_at=?,lock_until=0 WHERE payment_id=?').bind(now(), p.id).run();
      } else {
        if (result.error_code === 403) await db.prepare('UPDATE users SET blocked=1 WHERE tg_id=?').bind(p.tg_id).run();
        await db.prepare('UPDATE payment_expiry_notices SET lock_until=? WHERE payment_id=?')
          .bind(now() + Math.min(3600, 60 * claim.attempts), p.id).run();
      }
    } catch { console.error('Expiry notice pending', p.id); }
  }
}
