import { now, getUserWithClick } from './db.js';
import { tg, userLabel } from './telegram.js';
import { sendTikTokEvent } from './tiktok.js';
import { notifyAdmins } from './sales.js';
import * as T from './texts.js';

export async function deliverPayment(env, paymentId) {
  const db = env.DB;
  const t = now();
  const job = await db.prepare(`UPDATE payment_delivery SET lock_until=?,attempts=attempts+1
    WHERE payment_id=? AND state!='done' AND lock_until<=? RETURNING *`).bind(t + 120, paymentId, t).first();
  if (!job) return false;
  try {
    const p = await db.prepare("SELECT * FROM payments WHERE id=? AND status='paid'").bind(paymentId).first();
    if (!p) throw new Error('Payment not confirmed');
    let link = job.access_link;
    if (!link) {
      const user = await db.prepare('SELECT access_link,paid_at FROM users WHERE tg_id=?').bind(p.tg_id).first();
      if (user?.paid_at && /^https:\/\//.test(user.access_link || '')) link = user.access_link;
      if (!link && env.CHANNEL_ID) {
        const response = await tg(env.SALES_BOT_TOKEN, 'createChatInviteLink', {
          chat_id: env.CHANNEL_ID, member_limit: 1, name: `tg ${p.tg_id}`.slice(0, 32),
        });
        if (response.ok) link = response.result.invite_link;
      }
      if (!link && /^https:\/\//.test(env.COURSE_LINK || '')) link = env.COURSE_LINK;
      if (!link) throw new Error('Could not create access link');
      await db.prepare('UPDATE payment_delivery SET access_link=? WHERE payment_id=?').bind(link, paymentId).run();
    }
    // Credit exactly once, even if delivery fails after this transaction.
    await db.batch([
      db.prepare(`UPDATE users SET paid_at=COALESCE(paid_at,?), amount=COALESCE(amount,0)+?,
        access_link=?,next_reminder_at=NULL WHERE tg_id=? AND EXISTS
        (SELECT 1 FROM payment_delivery WHERE payment_id=? AND credited_at IS NULL)`)
        .bind(p.paid_at, p.is_test ? 0 : p.amount, link, p.tg_id, paymentId),
      db.prepare('UPDATE payment_delivery SET credited_at=COALESCE(credited_at,?) WHERE payment_id=?').bind(t, paymentId),
    ]);
    const sent = await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: p.tg_id, text: T.PAID_TEXT(link) });
    if (!sent.ok) throw new Error('Telegram delivery failed');
    await db.prepare("UPDATE payment_delivery SET state='done',delivered_at=?,lock_until=0 WHERE payment_id=?")
      .bind(now(), paymentId).run();
    // A failure of analytics or admin notification must not resend course access.
    try {
      const u = await getUserWithClick(db, p.tg_id);
      if (!p.is_test || env.TIKTOK_TEST_EVENT_CODE) {
        await sendTikTokEvent(env, 'Purchase', u, {eventId: `pur_${p.id}`, value: p.amount});
      }
      await notifyAdmins(env, `💰 <b>Оплата подтверждена${p.is_test ? ' (ТЕСТ)' : ''}</b>\n👤 ${userLabel(u)}\n💵 ${p.amount} ₸\n✅ Доступ отправлен.`);
    } catch { console.error('Post-delivery notification failed', paymentId); }
    return true;
  } catch (e) {
    await db.prepare('UPDATE payment_delivery SET lock_until=? WHERE payment_id=?')
      .bind(now() + Math.min(3600, 60 * job.attempts), paymentId).run();
    if (job.attempts === 1 || job.attempts % 10 === 0) {
      await notifyAdmins(env, `⚠️ Оплата ${paymentId} подтверждена, но доступ пока не отправлен. Повторим автоматически. Проверьте права бота в канале.`);
    }
    throw e;
  }
}

export async function retryDeliveries(env) {
  const {results} = await env.DB.prepare("SELECT payment_id FROM payment_delivery WHERE state!='done' AND lock_until<=? LIMIT 10")
    .bind(now()).all();
  for (const job of results) {
    try { await deliverPayment(env, job.payment_id); }
    catch { console.error('Delivery retry pending', job.payment_id); }
  }
}
