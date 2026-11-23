// Точка входа Cloudflare Worker
import { ensureSchema, now } from './db.js';
import { tg } from './telegram.js';
import { handleSalesUpdate, runReminders, grantAccess, notifyAdmins } from './sales.js';
import { handleAdminUpdate } from './admin.js';
import { verifyWebhook, parseWebhook } from './apipay.js';

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
async function saveClick(req, env) {
  const b = await req.json().catch(() => ({}));
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO clicks (code, ttclid, ttp, ip, ua, page_url, utm_source, utm_campaign, utm_adgroup, utm_ad, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    code, clip(b.ttclid, 500), clip(b.ttp, 200),
    req.headers.get('CF-Connecting-IP') || '', clip(req.headers.get('User-Agent'), 500),
    clip(b.url, 1000), clip(b.utm_source, 100), clip(b.utm_campaign, 200),
    clip(b.utm_adgroup, 200), clip(b.utm_ad, 200), now()
  ).run();
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
  if (!(await verifyWebhook(env, raw, req.headers.get('X-Webhook-Signature')))) {
    return json({ error: 'bad signature' }, 401);
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

    if (req.method === 'POST' && path === '/api/click') return saveClick(req, env);
    if (req.method === 'POST' && path === '/api/open') return markOpened(req, env);

    if (req.method === 'POST' && (path === '/tg/sales' || path === '/tg/admin')) {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
      const update = await req.json();
      const handler = path === '/tg/sales' ? handleSalesUpdate : handleAdminUpdate;
      ctx.waitUntil(handler(env, update).catch((e) => console.log('handler error', path, e?.stack || String(e))));
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === '/apipay/webhook') return apipayWebhook(req, env, ctx);
    if (path === '/setup') return setup(req, env);

    return new Response('course-bot is running ✅', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    ctx.waitUntil(runReminders(env));
  },
};
