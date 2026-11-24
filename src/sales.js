// Бот продаж: /start, оплата, выдача доступа, напоминания
import { now, getUserWithClick, getSetting, setSetting } from './db.js';
import { tg, esc, userLabel } from './telegram.js';
import { sendTikTokEvent } from './tiktok.js';
import { createPaymentLink } from './apipay.js';
import { paymentProvider, createKaspiPayment } from './kaspi.js';
import * as T from './texts.js';
import { checkoutLink } from './checkout.js';
import { deliverPayment } from './delivery.js';

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
    // Старт бота дублируем как AddToCart — его можно выбрать для оптимизации в цели «Продажи»
    await sendTikTokEvent(env, 'AddToCart', u, { eventId: `atc_${from.id}`, value: price(env) });
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

  if ((await paymentProvider(env)) === 'kaspi') {
    await payViaKaspi(env, from, u);
    return;
  }

  // Используем уже созданную ссылку, если ей меньше 23 часов
  let pay = await db.prepare(
    `SELECT * FROM payments WHERE tg_id=? AND status='pending' AND is_test=0 AND payment_url IS NOT NULL
     AND order_id NOT LIKE 'kq%' AND order_id NOT LIKE 'ki%' AND amount=? AND created_at > ? ORDER BY id DESC LIMIT 1`
  ).bind(from.id, price(env), t - 23 * 3600).first();

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

// Оплата через свою кассу (шлюз Kaspi). Ссылка живёт ~3 минуты, поэтому переиспользуем только свежую.
async function payViaKaspi(env, from, u) {
  const db = env.DB;
  const t = now();
  let pay = await db.prepare(
    `SELECT * FROM payments WHERE tg_id=? AND status='pending' AND order_id LIKE 'kq%' AND amount=?
     AND created_at > ? ORDER BY id DESC LIMIT 1`
  ).bind(from.id, price(env), t - 180).first();

  if (!pay) {
    try {
      const k = await createKaspiPayment(env, price(env));
      const orderId = `kq${from.id}_${crypto.randomUUID()}`;
      await db.prepare(
        `INSERT INTO payments (tg_id, order_id, invoice_id, payment_url, status, amount, created_at, is_test)
         VALUES (?,?,?,?,'pending',?,?,0) RETURNING *`
      ).bind(from.id, orderId, k.operationId, k.url, price(env), t).first();
      pay = await db.prepare('SELECT * FROM payments WHERE order_id=?').bind(orderId).first();
    } catch (e) {
      console.log('kaspi create failed', String(e));
      await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: from.id, text: T.PAY_ERROR_TEXT });
      await notifyAdmins(env, `⚠️ Своя касса Kaspi: не удалось создать ссылку для ${userLabel(u)}:\n<code>${esc(String(e).slice(0, 300))}</code>\n\nЕсли сессия слетела — 🏦 Kaspi → Войти. Или переключите оплату на ApiPay.`);
      return;
    }
  }

  await tg(env.SALES_BOT_TOKEN, 'sendMessage', {
    chat_id: from.id,
    text: T.PAY_LINK_TEXT(price(env)),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: T.PAY_LINK_BUTTON,
      url: (await getSetting(db, 'checkout_enabled', '0')) === '1' ? await checkoutLink(env, pay.id) : pay.payment_url,
    }]] },
  });
}

// ------------------------------------------------------------------ оплата прошла
/** Payment recording and delivery queue are committed together. Retries never credit twice. */
export async function grantAccess(env, paymentId) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO payment_delivery(payment_id)
      SELECT id FROM payments WHERE id=? AND status!='paid'`).bind(paymentId),
    env.DB.prepare("UPDATE payments SET status='paid',paid_at=COALESCE(paid_at,?) WHERE id=?").bind(t, paymentId),
  ]);
  return deliverPayment(env, paymentId);
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

