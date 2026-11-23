// Бот продаж: /start, оплата, выдача доступа, напоминания
import { now, getUserWithClick, getSetting, setSetting } from './db.js';
import { tg, esc, userLabel } from './telegram.js';
import { sendTikTokEvent } from './tiktok.js';
import { createPaymentLink } from './apipay.js';
import * as T from './texts.js';

const price = (env) => Number(env.PRICE || 4990);

const payKeyboard = (env) => ({
  inline_keyboard: [[{ text: T.PAY_BUTTON(price(env)), callback_data: 'pay' }]],
});

export function adminIds(env) {
  return String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function notifyAdmins(env, text, extra = {}) {
  if (!env.ADMIN_BOT_TOKEN) return;
  for (const id of adminIds(env)) {
    await tg(env.ADMIN_BOT_TOKEN, 'sendMessage', {
      chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
    });
  }
}

function adLabel(u) {
  if (!u.click_code) return 'без рекламы (напрямую в бота)';
  const parts = [u.utm_campaign, u.utm_adgroup, u.utm_ad].filter(Boolean);
  return parts.length ? esc(parts.join(' / ')) : 'TikTok (без названия кампании)';
}

// ------------------------------------------------------------------ входящие апдейты
export async function handleSalesUpdate(env, update) {
  const db = env.DB;
  const token = env.SALES_BOT_TOKEN;

  if (update.message) {
    const m = update.message;
    if (m.chat.type !== 'private') return;
    const from = m.from;
    const text = m.text || '';

    if (text.startsWith('/start')) {
      await onStart(env, from, text.split(/\s+/)[1] || '');
      return;
    }

    // Любое другое сообщение — пересылаем вам в админ-бот (можно ответить через «Ответить»)
    const u = (await getUserWithClick(db, from.id)) || { tg_id: from.id, first_name: from.first_name, username: from.username };
    const body = text || m.caption || '[не текстовое сообщение]';
    await notifyAdmins(env,
      `✉️ Сообщение от ${userLabel(u)}\n\n${esc(body)}\n\n<i>Ответьте на это сообщение (свайп → «Ответить»), и бот перешлёт ответ клиенту.</i>\n#id${from.id}`);
    return;
  }

  if (update.callback_query) {
    const q = update.callback_query;
    await tg(token, 'answerCallbackQuery', { callback_query_id: q.id });
    if (q.data === 'pay') await onPay(env, q.from);
  }
}

// Приветствие: видео + описание курса в подписи + кнопка оплаты.
// После первой отправки Telegram даёт file_id — дальше видео отправляется мгновенно.
async function sendWelcome(env, chatId) {
  const caption = T.COURSE_TEXT(price(env));
  const markup = payKeyboard(env);
  const videoUrl = env.PROMO_VIDEO_URL;
  if (videoUrl) {
    const cached = await getSetting(env.DB, 'promo_file_id');
    const r = await tg(env.SALES_BOT_TOKEN, 'sendVideo', {
      chat_id: chatId, video: cached || videoUrl, caption, parse_mode: 'HTML',
      reply_markup: markup, supports_streaming: true, width: 1920, height: 1080,
    });
    if (r.ok) {
      const fid = r.result?.video?.file_id;
      if (!cached && fid) await setSetting(env.DB, 'promo_file_id', fid);
      return;
    }
    if (cached) await setSetting(env.DB, 'promo_file_id', ''); // file_id устарел — в следующий раз по ссылке
  }
  await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: markup });
}

async function onStart(env, from, payload) {
  const db = env.DB;
  const t = now();
  const existing = await db.prepare('SELECT * FROM users WHERE tg_id=?').bind(from.id).first();

  let clickCode = null;
  if (payload && /^[A-Za-z0-9_-]{4,64}$/.test(payload)) {
    const c = await db.prepare('SELECT code FROM clicks WHERE code=?').bind(payload).first();
    if (c) clickCode = c.code;
  }

  if (!existing) {
    await db.prepare(
      `INSERT INTO users (tg_id, username, first_name, click_code, started_at, reminders_sent, next_reminder_at)
       VALUES (?,?,?,?,?,0,?)`
    ).bind(from.id, from.username || null, from.first_name || null, clickCode, t, t + T.REMINDER_DELAYS[0]).run();
    if (clickCode) {
      await db.prepare('UPDATE clicks SET opened_at=COALESCE(opened_at, ?) WHERE code=?').bind(t, clickCode).run();
    }
  } else {
    await db.prepare('UPDATE users SET username=?, first_name=?, blocked=0 WHERE tg_id=?')
      .bind(from.username || null, from.first_name || null, from.id).run();
  }

  const u = await getUserWithClick(db, from.id);

  if (u.paid_at && u.access_link) {
    await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: from.id, text: T.ALREADY_PAID_TEXT(u.access_link) });
    return;
  }

  await sendWelcome(env, from.id);

  if (!existing) {
    await sendTikTokEvent(env, 'CompleteRegistration', u, { eventId: `reg_${from.id}` });
    if ((await getSetting(db, 'notify_leads', '1')) === '1') {
      await notifyAdmins(env, `🆕 Новый лид: ${userLabel(u)}\n📍 Источник: ${adLabel(u)}`);
    }
  }
}

async function onPay(env, from) {
  const db = env.DB;
  const t = now();
  let u = await getUserWithClick(db, from.id);
  if (!u) {
    await db.prepare('INSERT INTO users (tg_id, username, first_name, started_at, reminders_sent) VALUES (?,?,?,?,0)')
      .bind(from.id, from.username || null, from.first_name || null, t).run();
    u = await getUserWithClick(db, from.id);
  }

  if (u.paid_at && u.access_link) {
    await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: from.id, text: T.ALREADY_PAID_TEXT(u.access_link) });
    return;
  }

  // Первое нажатие «Оплатить» → событие в TikTok и уведомление
  if (!u.checkout_at) {
    await db.prepare('UPDATE users SET checkout_at=? WHERE tg_id=?').bind(t, from.id).run();
    await sendTikTokEvent(env, 'InitiateCheckout', u, { eventId: `chk_${from.id}`, value: price(env) });
    if ((await getSetting(db, 'notify_leads', '1')) === '1') {
      await notifyAdmins(env, `💳 Нажал «Оплатить»: ${userLabel(u)}\n📍 Источник: ${adLabel(u)}`);
    }
  }

  // Используем уже созданную ссылку, если ей меньше 23 часов
  let pay = await db.prepare(
    `SELECT * FROM payments WHERE tg_id=? AND status='pending' AND is_test=0 AND payment_url IS NOT NULL
     AND created_at > ? ORDER BY id DESC LIMIT 1`
  ).bind(from.id, t - 23 * 3600).first();

  if (!pay) {
    if (!env.APIPAY_API_KEY) {
      console.log('APIPAY_API_KEY not set');
      await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: from.id, text: T.PAY_ERROR_TEXT });
      await notifyAdmins(env, `⚠️ ${userLabel(u)} хотел оплатить, но ApiPay ещё не подключён (нет APIPAY_API_KEY).`);
      return;
    }
    const orderId = `tg${from.id}_${t}`;
    try {
      const link = await createPaymentLink(env, {
        orderId, amount: price(env), description: env.PRODUCT_NAME || 'Курс',
      });
      await db.prepare(
        `INSERT INTO payments (tg_id, order_id, static_qr_id, invoice_id, payment_url, status, amount, created_at, is_test)
         VALUES (?,?,?,?,?,'pending',?,?,0)`
      ).bind(from.id, orderId, link.staticQrId, link.invoiceId, link.url, price(env), t).run();
      pay = { payment_url: link.url };
    } catch (e) {
      console.log('createPaymentLink failed', String(e));
      await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: from.id, text: T.PAY_ERROR_TEXT });
      await notifyAdmins(env, `⚠️ Ошибка ApiPay при создании ссылки для ${userLabel(u)}:\n<code>${esc(String(e).slice(0, 300))}</code>`);
      return;
    }
  }

  await tg(env.SALES_BOT_TOKEN, 'sendMessage', {
    chat_id: from.id,
    text: T.PAY_LINK_TEXT(price(env)),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: T.PAY_LINK_BUTTON, url: pay.payment_url }]] },
  });
}

// ------------------------------------------------------------------ оплата прошла
/** Выдаёт доступ. Безопасно вызывать повторно — второй раз ничего не сделает. */
export async function grantAccess(env, paymentId) {
  const db = env.DB;
  const t = now();
  const res = await db.prepare(`UPDATE payments SET status='paid', paid_at=? WHERE id=? AND status!='paid'`)
    .bind(t, paymentId).run();
  if (!res.meta.changes) return false; // уже обработан

  const p = await db.prepare('SELECT * FROM payments WHERE id=?').bind(paymentId).first();
  const isTest = p.is_test === 1;

  let link = env.COURSE_LINK || '';
  if (env.CHANNEL_ID) {
    const r = await tg(env.SALES_BOT_TOKEN, 'createChatInviteLink', {
      chat_id: env.CHANNEL_ID, member_limit: 1, name: `tg ${p.tg_id}`.slice(0, 32),
    });
    if (r.ok) link = r.result.invite_link;
  }
  if (!link) link = '(ссылка на курс не настроена — напишите в этот чат)';

  await db.prepare(
    `UPDATE users SET paid_at=COALESCE(paid_at, ?), amount=COALESCE(amount,0)+?, access_link=?, next_reminder_at=NULL WHERE tg_id=?`
  ).bind(t, isTest ? 0 : p.amount, link, p.tg_id).run();

  await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: p.tg_id, text: T.PAID_TEXT(link) });

  const u = await getUserWithClick(db, p.tg_id);
  if (!isTest || env.TIKTOK_TEST_EVENT_CODE) {
    await sendTikTokEvent(env, 'Purchase', u, { eventId: `pur_${p.id}`, value: p.amount });
  }

  const day = await db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND is_test=0 AND paid_at>=?`
  ).bind(t - ((t + 5 * 3600) % 86400)).first();

  await notifyAdmins(env,
    `💰 <b>Новая продажа${isTest ? ' (ТЕСТ)' : ''}!</b>\n` +
    `👤 ${userLabel(u)}\n💵 ${p.amount} ₸\n📍 Источник: ${adLabel(u)}\n\n` +
    `Сегодня: ${day.n} продаж на ${day.s} ₸`);
  return true;
}

// ------------------------------------------------------------------ напоминания (cron)
export async function runReminders(env) {
  const db = env.DB;
  const t = now();
  const { results } = await db.prepare(
    `SELECT * FROM users WHERE paid_at IS NULL AND blocked=0 AND next_reminder_at IS NOT NULL
     AND next_reminder_at<=? LIMIT 100`
  ).bind(t).all();

  for (const u of results) {
    const i = u.reminders_sent || 0;
    if (i >= T.REMINDERS.length) {
      await db.prepare('UPDATE users SET next_reminder_at=NULL WHERE tg_id=?').bind(u.tg_id).run();
      continue;
    }
    const r = await tg(env.SALES_BOT_TOKEN, 'sendMessage', {
      chat_id: u.tg_id, text: T.REMINDERS[i](price(env)), parse_mode: 'HTML', reply_markup: payKeyboard(env),
    });
    const next = i + 1 < T.REMINDER_DELAYS.length ? u.started_at + T.REMINDER_DELAYS[i + 1] : null;
    const blocked = !r.ok && r.error_code === 403 ? 1 : 0;
    await db.prepare('UPDATE users SET reminders_sent=?, next_reminder_at=?, blocked=? WHERE tg_id=?')
      .bind(i + 1, blocked ? null : next, blocked, u.tg_id).run();
  }
}
