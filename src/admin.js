// Админ-бот: статистика, источники, неоплатившие, выгрузка, уведомления
import { now, dayStart, fmtTime, getSetting, setSetting } from './db.js';
import { tg, tgSendDocument, esc } from './telegram.js';
import { adminIds, grantAccess } from './sales.js';
import { paymentProvider, loginStart, loginFinish, checkSession, getKaspiSession } from './kaspi.js';

const KB = {
  keyboard: [
    [{ text: '📊 Сегодня' }, { text: '📅 Вчера' }],
    [{ text: '🗓 7 дней' }, { text: '📈 Всё время' }],
    [{ text: '🎯 По рекламе' }, { text: '⏳ Не оплатили' }],
    [{ text: '📥 Выгрузка' }, { text: '🔔 Уведомления' }],
    [{ text: '🏦 Kaspi' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function range(kind) {
  const t = now();
  const d0 = dayStart(t);
  switch (kind) {
    case 'today': return { from: d0, to: t + 1, title: 'Сегодня' };
    case 'yesterday': return { from: d0 - 86400, to: d0, title: 'Вчера' };
    case '7': return { from: d0 - 6 * 86400, to: t + 1, title: 'За 7 дней' };
    case '30': return { from: d0 - 29 * 86400, to: t + 1, title: 'За 30 дней' };
    default: return { from: 0, to: t + 1, title: 'За всё время' };
  }
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');

async function statsText(db, kind) {
  const { from, to, title } = range(kind);
  const q = (sql) => db.prepare(sql).bind(from, to).first();
  const visits = (await q('SELECT COUNT(*) n FROM clicks WHERE created_at>=? AND created_at<?')).n;
  const opened = (await q('SELECT COUNT(*) n FROM clicks WHERE opened_at>=? AND opened_at<?')).n;
  const starts = (await q('SELECT COUNT(*) n FROM users WHERE started_at>=? AND started_at<?')).n;
  const startsAd = (await q('SELECT COUNT(*) n FROM users WHERE click_code IS NOT NULL AND started_at>=? AND started_at<?')).n;
  const checkouts = (await q('SELECT COUNT(*) n FROM users WHERE checkout_at>=? AND checkout_at<?')).n;
  const paid = await q(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments
                        WHERE status='paid' AND is_test=0 AND paid_at>=? AND paid_at<?`);

  return `📊 <b>${title}</b>

👀 Зашли на лендинг: <b>${visits}</b>
📲 Перешли в Telegram: <b>${opened}</b>
▶️ Активировали бота (старт): <b>${starts}</b>  <i>(из рекламы: ${startsAd})</i>
💳 Нажали «Оплатить»: <b>${checkouts}</b>
✅ Оплатили: <b>${paid.n}</b>
💰 Выручка: <b>${paid.s.toLocaleString('ru-RU')} ₸</b>

<b>Конверсии</b>
Лендинг → старт: ${pct(startsAd, visits)}
Старт → «Оплатить»: ${pct(checkouts, starts)}
Старт → оплата: ${pct(paid.n, starts)}`;
}

async function adsText(db, kind) {
  const { from, to, title } = range(kind);
  const { results } = await db.prepare(
    `SELECT u.click_code IS NULL AS organic,
            COALESCE(NULLIF(c.utm_campaign,''),'—') AS camp,
            COALESCE(NULLIF(c.utm_ad,''),'—') AS ad,
            COUNT(*) AS starts,
            SUM(u.checkout_at IS NOT NULL) AS chk,
            SUM(u.amount > 0) AS paid,
            COALESCE(SUM(u.amount),0) AS rev
     FROM users u LEFT JOIN clicks c ON c.code=u.click_code
     WHERE u.started_at>=? AND u.started_at<?
     GROUP BY organic, camp, ad
     ORDER BY paid DESC, starts DESC LIMIT 25`
  ).bind(from, to).all();

  if (!results.length) return `🎯 <b>По рекламе — ${title}</b>\n\nПока нет данных.`;
  const lines = results.map((r) => {
    const name = r.organic ? '🔹 Без рекламы (напрямую)' : `🔸 ${esc(r.camp)}${r.ad !== '—' ? ` / ${esc(r.ad)}` : ''}`;
    return `${name}\n   старт ${r.starts} → оплатить ${r.chk} → <b>оплат ${r.paid}</b> (${pct(r.paid, r.starts)}) · ${r.rev.toLocaleString('ru-RU')} ₸`;
  });
  return `🎯 <b>По рекламе — ${title}</b>\n\n${lines.join('\n\n')}`;
}

const adsPeriodKb = {
  inline_keyboard: [[
    { text: 'Сегодня', callback_data: 'ads:today' },
    { text: '7 дн', callback_data: 'ads:7' },
    { text: '30 дн', callback_data: 'ads:30' },
    { text: 'Всё', callback_data: 'ads:all' },
  ]],
};

async function unpaidText(db) {
  const { results } = await db.prepare(
    `SELECT * FROM users WHERE paid_at IS NULL ORDER BY started_at DESC LIMIT 25`
  ).all();
  if (!results.length) return '⏳ Неоплативших нет 🎉';
  const lines = results.map((u) => {
    const who = u.username ? `@${esc(u.username)}` : `${esc(u.first_name || '')} (id ${u.tg_id})`;
    const st = u.checkout_at ? '💳 нажал «Оплатить»' : '▶️ только старт';
    const bl = u.blocked ? ' · 🚫 заблокировал бота' : '';
    return `${who} — ${st} · ${fmtTime(u.started_at)} · напомн. ${u.reminders_sent}/3${bl}`;
  });
  return `⏳ <b>Не оплатили (последние 25)</b>\n\n${lines.join('\n')}`;
}

async function exportCsv(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT u.*, c.utm_source, c.utm_campaign, c.utm_adgroup, c.utm_ad, c.ttclid
     FROM users u LEFT JOIN clicks c ON c.code=u.click_code ORDER BY u.started_at DESC`
  ).all();
  const head = ['Telegram ID', 'Username', 'Имя', 'Старт', 'Нажал оплатить', 'Оплатил', 'Сумма',
    'Кампания', 'Группа', 'Объявление', 'Из TikTok', 'Напоминаний', 'Заблокировал'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = results.map((u) => [
    u.tg_id, u.username, u.first_name, fmtTime(u.started_at), fmtTime(u.checkout_at), fmtTime(u.paid_at),
    u.amount || '', u.utm_campaign, u.utm_adgroup, u.utm_ad, u.ttclid ? 'да' : 'нет', u.reminders_sent, u.blocked ? 'да' : '',
  ].map(cell).join(';'));
  const csv = '﻿' + [head.map(cell).join(';'), ...rows].join('\r\n');
  const name = `leads_${fmtTime(now()).slice(0, 10)}.csv`;
  await tgSendDocument(env.ADMIN_BOT_TOKEN, chatId, name, csv, `📥 Все лиды: ${results.length}`);
}

// ------------------------------------------------------------------ своя касса Kaspi
async function kaspiPanel(env) {
  const prov = await paymentProvider(env);
  const s = await getKaspiSession(env);
  const gwOk = !!(env.KASPI_GATEWAY_URL && env.KASPI_GATEWAY_KEY);
  const text = `🏦 <b>Приём оплаты</b>

Сейчас оплата идёт через: <b>${prov === 'kaspi' ? 'Свою кассу Kaspi' : 'ApiPay'}</b>
Шлюз Kaspi: ${gwOk ? '✅ настроен' : '❌ не настроен (нет KASPI_GATEWAY_URL / KASPI_GATEWAY_KEY)'}
Кассир: ${s ? `✅ вход выполнен${s.orgName ? ` (${esc(s.orgName)})` : ''}` : '— вход не выполнен'}`;
  const kb = { inline_keyboard: [
    [{ text: '🔑 Войти в Kaspi', callback_data: 'kaspi:login' }, { text: '🔄 Проверить', callback_data: 'kaspi:check' }],
    [prov === 'kaspi'
      ? { text: '↩️ Переключить на ApiPay', callback_data: 'kaspi:use:apipay' }
      : { text: '🏦 Переключить на свою кассу', callback_data: 'kaspi:use:kaspi' }],
  ] };
  return { text, kb };
}

async function setState(db, state) {
  await setSetting(db, 'admin_state', JSON.stringify({ ...state, at: now() }));
}
async function getState(db) {
  try {
    const st = JSON.parse(await getSetting(db, 'admin_state', '{}'));
    return st.at && now() - st.at < 600 ? st : {};
  } catch { return {}; }
}

export async function handleAdminUpdate(env, update) {
  const db = env.DB;
  const token = env.ADMIN_BOT_TOKEN;
  const admins = adminIds(env);
  const from = update.message?.from || update.callback_query?.from;
  if (!from) return;

  if (!admins.includes(String(from.id))) {
    if (update.message) {
      await tg(token, 'sendMessage', {
        chat_id: from.id,
        text: `⛔ Нет доступа.\n\nВаш Telegram ID: <code>${from.id}</code>\nДобавьте его в ADMIN_IDS в настройках Cloudflare.`,
        parse_mode: 'HTML',
      });
    }
    return;
  }

  const send = (text, extra = {}) => tg(token, 'sendMessage', {
    chat_id: from.id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: KB, ...extra,
  });

  if (update.callback_query) {
    const q = update.callback_query;
    await tg(token, 'answerCallbackQuery', { callback_query_id: q.id });
    if (q.data === 'kaspi:login') {
      const saved = await getSetting(db, 'kaspi_phone', '');
      await setState(db, { step: 'kaspi_phone' });
      await send(`Отправьте номер <b>кассира</b> Kaspi Pay — 10 цифр без +7, например <code>7071234567</code>.${saved ? `\nПрошлый номер: <code>${saved}</code>` : ''}\n\n⚠️ Это должен быть отдельный кассир, не ваш личный вход в Kaspi Pay.`);
      return;
    }
    if (q.data === 'kaspi:check') {
      try {
        const st = await checkSession(env);
        await send(st.active ? `✅ Сессия Kaspi активна${st.orgName ? ` (${esc(st.orgName)})` : ''}` : `❌ Сессия неактивна: ${esc(st.reason || '')}\nНажмите 🔑 Войти в Kaspi.`);
      } catch (e) { await send(`❌ Шлюз не отвечает: ${esc(String(e).slice(0, 200))}`); }
      return;
    }
    if (q.data?.startsWith('kaspi:use:')) {
      const to = q.data.slice(10);
      if (to === 'kaspi') {
        let st; try { st = await checkSession(env); } catch (e) { st = { active: false, reason: String(e) }; }
        if (!st.active) { await send(`Сначала войдите в Kaspi — сессия неактивна (${esc(st.reason || '')}).`); return; }
      }
      await setSetting(db, 'payment_provider', to);
      const p = await kaspiPanel(env);
      await tg(token, 'editMessageText', { chat_id: from.id, message_id: q.message.message_id, text: p.text, parse_mode: 'HTML', reply_markup: p.kb });
      return;
    }
    if (q.data?.startsWith('ads:')) {
      await tg(token, 'editMessageText', {
        chat_id: from.id, message_id: q.message.message_id,
        text: await adsText(db, q.data.slice(4)), parse_mode: 'HTML', reply_markup: adsPeriodKb,
      });
    }
    return;
  }

  const m = update.message;
  const text = (m.text || '').trim();

  // Пошаговый вход в Kaspi: номер кассира → код из SMS
  const st = await getState(db);
  if (st.step === 'kaspi_phone' && /^\+?[\d\s()-]{10,16}$/.test(text)) {
    const phone = text.replace(/\D/g, '').slice(-10);
    try {
      const pid = await loginStart(env, phone);
      await setSetting(db, 'kaspi_phone', phone);
      await setState(db, { step: 'kaspi_otp', pid });
      await send('📩 SMS с кодом отправлено на номер кассира. Пришлите код сюда (только цифры).');
    } catch (e) {
      await setState(db, {});
      await send(`❌ Kaspi не принял номер: ${esc(String(e.message || e).slice(0, 300))}`);
    }
    return;
  }
  if (st.step === 'kaspi_otp' && /^\d{4,6}$/.test(text)) {
    try {
      const s2 = await loginFinish(env, st.pid, text);
      await setState(db, {});
      await setSetting(db, 'kaspi_alert_at', '0');
      const p = await kaspiPanel(env);
      await send(`✅ Вход в Kaspi выполнен${s2.orgName ? `: ${esc(s2.orgName)}` : ''}.\n\n` + p.text, { reply_markup: p.kb });
    } catch (e) {
      await send(`❌ ${esc(String(e.message || e).slice(0, 300))}\nПопробуйте ещё раз: 🏦 Kaspi → Войти.`);
      await setState(db, {});
    }
    return;
  }

  // Ответ клиенту: «Ответить» на пересланное сообщение с #id
  const replied = m.reply_to_message?.text || '';
  const idMatch = replied.match(/#id(\d+)/);
  if (idMatch && text) {
    const r = await tg(env.SALES_BOT_TOKEN, 'sendMessage', { chat_id: Number(idMatch[1]), text });
    await send(r.ok ? '✅ Ответ отправлен клиенту' : `❌ Не удалось отправить: ${esc(r.description || '')}`);
    return;
  }

  if (text === '/start' || text === '/menu') {
    await send('👋 Админ-панель курса. Выберите, что показать:');
  } else if (text === '📊 Сегодня' || text === '/today') {
    await send(await statsText(db, 'today'));
  } else if (text === '📅 Вчера') {
    await send(await statsText(db, 'yesterday'));
  } else if (text === '🗓 7 дней') {
    await send(await statsText(db, '7'));
  } else if (text === '📈 Всё время') {
    await send(await statsText(db, 'all'));
  } else if (text === '🎯 По рекламе') {
    await send(await adsText(db, '7'), { reply_markup: adsPeriodKb });
  } else if (text === '⏳ Не оплатили') {
    await send(await unpaidText(db));
  } else if (text === '📥 Выгрузка') {
    await exportCsv(env, from.id);
  } else if (text === '🔔 Уведомления') {
    const cur = await getSetting(db, 'notify_leads', '1');
    const next = cur === '1' ? '0' : '1';
    await setSetting(db, 'notify_leads', next);
    await send(next === '1'
      ? '🔔 Уведомления о каждом лиде и нажатии «Оплатить» <b>включены</b>.\nО продажах уведомляю всегда.'
      : '🔕 Уведомления о лидах <b>выключены</b>.\nО продажах всё равно буду сообщать.');
  } else if (text === '🏦 Kaspi' || text === '/kaspi') {
    const p = await kaspiPanel(env);
    await send(p.text, { reply_markup: p.kb });
  } else if (text.startsWith('/grant')) {
    // Выдать доступ вручную (оплата проверена в Kaspi Pay): /grant <telegram_id>
    const id = Number(text.split(/\s+/)[1]);
    const u = id && await db.prepare('SELECT tg_id FROM users WHERE tg_id=?').bind(id).first();
    if (!u) { await send('Укажите ID: /grant 123456789 (пользователь должен был нажать /start).'); return; }
    const already = await db.prepare('SELECT paid_at FROM users WHERE tg_id=?').bind(id).first();
    if (already?.paid_at && !/\bforce\b/.test(text)) { await send(`У пользователя ${id} уже есть доступ. Если это повторная покупка: /grant ${id} force`); return; }
    const r = await db.prepare(
      `INSERT INTO payments (tg_id, order_id, status, amount, created_at, is_test) VALUES (?,?, 'pending', ?, ?, 0) RETURNING id`
    ).bind(id, `manual_${id}_${now()}`, Number(env.PRICE || 4990), now()).first();
    await grantAccess(env, r.id);
    await send('✅ Доступ выдан, продажа засчитана.');
  } else if (text.startsWith('/reset')) {
    // Для тестов: забыть пользователя, чтобы его /start снова считался новым лидом. /reset или /reset <telegram_id>
    const id = Number(text.split(/\s+/)[1] || from.id);
    const r = await db.prepare('DELETE FROM users WHERE tg_id=?').bind(id).run();
    await send(r.meta.changes ? `🧹 Пользователь ${id} сброшен — его следующий /start будет как новый лид.` : `Пользователь ${id} не найден.`);
  } else if (text.startsWith('/testpay')) {
    // Тест выдачи доступа без реальной оплаты: /testpay <telegram_id>
    const id = Number(text.split(/\s+/)[1] || from.id);
    const u = await db.prepare('SELECT tg_id FROM users WHERE tg_id=?').bind(id).first();
    if (!u) { await send('Этот пользователь ещё не нажимал /start в боте продаж.'); return; }
    const r = await db.prepare(
      `INSERT INTO payments (tg_id, order_id, status, amount, created_at, is_test) VALUES (?,?, 'pending', ?, ?, 1) RETURNING id`
    ).bind(id, `test_${id}_${now()}`, Number(env.PRICE || 4990), now()).first();
    await grantAccess(env, r.id);
    await send('🧪 Тестовая оплата проведена (в статистику продаж не входит).');
  } else {
    await send('Выберите пункт в меню 👇');
  }
}
