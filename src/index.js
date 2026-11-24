// Точка входа Cloudflare Worker
import { ensureSchema, now } from './db.js';
import { tg } from './telegram.js';
import { handleSalesUpdate, runReminders, grantAccess, notifyAdmins } from './sales.js';
import { handleAdminUpdate } from './admin.js';
import { verifyWebhook, parseWebhook, verifyHmac } from './apipay.js';
import { paymentProvider, checkSession } from './kaspi.js';
import { getSetting, setSetting } from './db.js';
import { esc, userLabel } from './telegram.js';
import { sendTikTokEvent } from './tiktok.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

function randomCode(len = 10) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

// Лендинг сообщает: человек зашёл (сохраняем ttclid, cookie пикселя, IP, браузер, метки)
// Код может прийти от лендинга (он создаёт его сам, чтобы ссылка на бота была готова мгновенно).
// Повторный запрос с тем же кодом дополняет данные (cookie пикселя, отметка «перешёл в Telegram»).
async function saveClick(req, env, ctx) {
  const b = await req.json().catch(() => ({}));
  const code = /^[A-Za-z0-9]{8,32}$/.test(b.code || '') ? b.code : randomCode();
  const t = now();
  const nz = (v, n) => (v ? clip(v, n) : null);
  // Атомарно: вставка удаётся только у первого запроса с этим кодом → только он шлёт ViewContent
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO clicks (code, ttclid, ttp, ip, ua, page_url, utm_source, utm_campaign, utm_adgroup, utm_ad, created_at, opened_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    code, nz(b.ttclid, 500), nz(b.ttp, 200),
    req.headers.get('CF-Connecting-IP') || '', clip(req.headers.get('User-Agent'), 500),
    nz(b.url, 1000), nz(b.utm_source, 100), nz(b.utm_campaign, 200),
    nz(b.utm_adgroup, 200), nz(b.utm_ad, 200), t, b.opened ? t : null
  ).run();
  const isNew = ins.meta.changes > 0;
  if (!isNew) {
    await env.DB.prepare(
      `UPDATE clicks SET ttclid=COALESCE(ttclid, ?), ttp=COALESCE(ttp, ?), opened_at=COALESCE(opened_at, ?) WHERE code=?`
    ).bind(nz(b.ttclid, 500), nz(b.ttp, 200), b.opened ? t : null, code).run();
  }
  // Посещение лендинга → ViewContent в TikTok с сервера (тот же event_id, что у пикселя — TikTok склеит дубли)
  if (isNew && ctx) {
    ctx.waitUntil(sendTikTokEvent(env, 'ViewContent', {
      code, ttclid: b.ttclid, ttp: b.ttp, ip: req.headers.get('CF-Connecting-IP') || '',
      ua: req.headers.get('User-Agent') || '', page_url: b.url,
    }, { eventId: `vc_${code}`, value: Number(env.PRICE || 4990) }));
  }
  return json({ code }, 200, CORS);
}

// Лендинг сообщает: человек нажал «Открыть Telegram»
async function markOpened(req, env) {
  const b = await req.json().catch(() => ({}));
  if (b.code) {
    await env.DB.prepare('UPDATE clicks SET opened_at=COALESCE(opened_at, ?) WHERE code=?').bind(now(), String(b.code)).run();
  }
  return json({ ok: true }, 200, CORS);
}

async function apipayWebhook(req, env, ctx) {
  const raw = await req.text();
  const v = await verifyWebhook(env, raw, req.headers.get('X-Webhook-Signature'));
  if (!v.ok) {
    console.log('apipay webhook rejected:', v.reason);
    ctx.waitUntil(notifyAdmins(env, `⚠️ ApiPay: уведомление отклонено (401)\nПричина: ${v.reason}`));
    return json({ error: 'bad signature', reason: v.reason }, 401);
  }
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: true }); }
  const w = parseWebhook(body);
  console.log('apipay webhook', JSON.stringify(w));

  if (w.event !== 'invoice.status_changed' || w.status !== 'paid') return json({ ok: true });
  if (w.isSandbox && env.APIPAY_SANDBOX !== '1') return json({ ok: true, ignored: 'sandbox' });

  ctx.waitUntil((async () => {
    const db = env.DB;
    let p = null;
    if (w.externalOrderId) p = await db.prepare('SELECT * FROM payments WHERE order_id=?').bind(w.externalOrderId).first();
    if (!p && w.staticQrId) p = await db.prepare('SELECT * FROM payments WHERE static_qr_id=? ORDER BY id DESC').bind(w.staticQrId).first();
    if (!p && w.invoiceId) p = await db.prepare('SELECT * FROM payments WHERE invoice_id=?').bind(w.invoiceId).first();
    if (!p) {
      await notifyAdmins(env, `⚠️ Пришла оплата ApiPay, но не нашёл, чей это платёж.\n<code>${JSON.stringify(w)}</code>`);
      return;
    }
    await db.prepare('UPDATE payments SET invoice_id=COALESCE(invoice_id, ?), is_test=? WHERE id=?')
      .bind(w.invoiceId, w.isSandbox ? 1 : 0, p.id).run();
    await grantAccess(env, p.id);
  })());
  return json({ ok: true });
}

// Уведомления от своего шлюза Kaspi (gateway/)
async function kaspiWebhook(req, env, ctx) {
  const raw = await req.text();
  if (!(await verifyHmac(env.KASPI_WEBHOOK_SECRET, raw, req.headers.get('X-Webhook-Signature')))) {
    console.log('kaspi webhook: bad signature');
    return json({ error: 'bad signature' }, 401);
  }
  let b; try { b = JSON.parse(raw); } catch { return json({ ok: true }); }
  console.log('kaspi webhook', b.event, b.paymentId, b.status);

  ctx.waitUntil((async () => {
    const db = env.DB;
    const p = await db.prepare(`SELECT * FROM payments WHERE invoice_id=? AND order_id LIKE 'kq%' ORDER BY id DESC`)
      .bind(String(b.paymentId)).first();
    if (b.event === 'payment.success') {
      if (!p) {
        await notifyAdmins(env, `⚠️ Kaspi: пришла оплата, но не нашёл, чей это платёж.\n<code>${esc(JSON.stringify({ id: b.paymentId, amount: b.amount }))}</code>`);
        return;
      }
      if (b.amount != null && Number(b.amount) + 0.001 < Number(p.amount)) {
        await notifyAdmins(env, `⚠️ Kaspi: сумма оплаты ${b.amount} меньше цены ${p.amount} (платёж ${p.id}). Доступ не выдан — проверьте вручную.`);
        return;
      }
      await grantAccess(env, p.id);
    } else if (b.event === 'payment.lost' || b.status === 'SessionExpired') {
      const u = p ? await db.prepare('SELECT * FROM users WHERE tg_id=?').bind(p.tg_id).first() : null;
      await notifyAdmins(env,
        `⚠️ <b>Kaspi: сессия кассира слетела</b>, статус оплаты неизвестен${u ? ` (${userLabel(u)})` : ''}.\n` +
        `Проверьте оплату в Kaspi Pay. Если человек оплатил — выдайте доступ командой <code>/grant ${p ? p.tg_id : 'ID'}</code>.\n` +
        `И войдите заново: 🏦 Kaspi → Войти.`);
    }
  })());
  return json({ ok: true });
}

// Каждые 15 минут: жива ли сессия кассира. Если нет — предупредить и переключиться на ApiPay (если он настроен).
async function kaspiHealth(env) {
  if ((await paymentProvider(env)) !== 'kaspi') return;
  let st;
  try { st = await checkSession(env); } catch (e) { st = { active: false, reason: String(e) }; }
  if (st.active) return;
  const last = Number(await getSetting(env.DB, 'kaspi_alert_at', '0'));
  if (Date.now() / 1000 - last < 3600) return;
  await setSetting(env.DB, 'kaspi_alert_at', Math.floor(Date.now() / 1000));
  let extra = '';
  if (env.APIPAY_API_KEY) {
    await setSetting(env.DB, 'payment_provider', 'apipay');
    extra = '\n\n🔁 Оплата автоматически переключена на <b>ApiPay</b>, продажи не стоят.';
  }
  await notifyAdmins(env, `⚠️ <b>Своя касса Kaspi не отвечает</b>: ${esc(st.reason || 'сессия неактивна')}.\nВойдите заново: 🏦 Kaspi → Войти.${extra}`);
}

// Разовая настройка: подключает вебхуки обоих ботов. Открыть в браузере: /setup?key=WEBHOOK_SECRET
async function setup(req, env) {
  const url = new URL(req.url);
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
  const base = `${url.protocol}//${url.host}`;
  const out = {};
  out.sales = await tg(env.SALES_BOT_TOKEN, 'setWebhook', {
    url: `${base}/tg/sales`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'],
  });
  out.admin = await tg(env.ADMIN_BOT_TOKEN, 'setWebhook', {
    url: `${base}/tg/admin`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'],
  });
  out.admin_cmds = await tg(env.ADMIN_BOT_TOKEN, 'setMyCommands', {
    commands: [{ command: 'menu', description: 'Меню' }, { command: 'today', description: 'Статистика за сегодня' }],
  });
  out.apipay_webhook_url = `${base}/apipay/webhook`;
  return json(out);
}

export default {
  async fetch(req, env, ctx) {
    await ensureSchema(env.DB);
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'POST' && path === '/api/click') return saveClick(req, env, ctx);
    if (req.method === 'POST' && path === '/api/open') return markOpened(req, env);

    if (req.method === 'POST' && (path === '/tg/sales' || path === '/tg/admin')) {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
      const update = await req.json();
      const handler = path === '/tg/sales' ? handleSalesUpdate : handleAdminUpdate;
      ctx.waitUntil(handler(env, update).catch((e) => console.log('handler error', path, e?.stack || String(e))));
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === '/apipay/webhook') return apipayWebhook(req, env, ctx);
    if (req.method === 'POST' && path === '/kaspi/webhook') return kaspiWebhook(req, env, ctx);
    if (path === '/setup') return setup(req, env);

    return new Response('course-bot is running ✅', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    ctx.waitUntil(runReminders(env));
    const minute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    if (minute % 15 === 0) ctx.waitUntil(kaspiHealth(env).catch((e) => console.log('kaspiHealth', String(e))));
  },
};
