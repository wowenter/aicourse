import { now } from './db.js';
import { createKaspiInvoice } from './kaspi.js';
import { checkoutHtml } from './checkout-page.js';

const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
});

export function normalizePhone(input) {
  if (typeof input !== 'string' || input.length > 32 || /[^\d+\s()-]/.test(input)) return null;
  let phone = input.replace(/\D/g, '');
  if (phone.length === 11 && /^[78]/.test(phone)) phone = phone.slice(1);
  return /^7\d{9}$/.test(phone) ? phone : null;
}

export function safeKaspiUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ['pay.kaspi.kz', 'qr.kaspi.kz'].includes(u.hostname)
      && !u.username && !u.password && !u.port ? u.href : null;
  } catch { return null; }
}

export async function checkoutLink(env, paymentId) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const t = now();
  await env.DB.prepare('INSERT OR IGNORE INTO checkouts(token,payment_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(token, paymentId, t, t + 1800).run();
  const row = await env.DB.prepare('SELECT token FROM checkouts WHERE payment_id=?').bind(paymentId).first();
  return `${String(env.CHECKOUT_BASE_URL || env.KASPI_GATEWAY_URL).replace(/\/+$/, '')}/pay/${row.token}`;
}

async function readCheckout(db, token) {
  return db.prepare(`SELECT c.*, p.tg_id, p.amount, p.status, p.payment_url, p.created_at AS qr_created_at,
      i.status AS invoice_status, i.invoice_id AS invoice_operation_id,
      d.state AS qr_delivery, di.state AS invoice_delivery
    FROM checkouts c JOIN payments p ON p.id=c.payment_id
    LEFT JOIN payments i ON i.id=c.invoice_payment_id
    LEFT JOIN payment_delivery d ON d.payment_id=p.id
    LEFT JOIN payment_delivery di ON di.payment_id=i.id WHERE c.token=?`).bind(token).first();
}

const isPaid = row => row.status === 'paid' || row.invoice_status === 'paid';
const statusOf = row => ({
  paid: isPaid(row), delivered: row.qr_delivery === 'done' || row.invoice_delivery === 'done',
  invoice: row.invoice_state,
  invoiceFailed: ['failed', 'expired'].includes(row.invoice_status),
  expired: row.expires_at < now(),
});

export async function handleCheckout(req, env) {
  const url = new URL(req.url);
  if (url.pathname === '/pay/health' && req.method === 'GET') return json({ status: 'ok', checkout: 1 });
  const match = url.pathname.match(/^\/pay\/([a-f0-9]{64})(?:\/(status|invoice))?$/);
  if (!match) return json({ error: 'Ссылка не найдена. Откройте оплату заново в боте.' }, 404);
  const [, token, action] = match;
  const row = await readCheckout(env.DB, token);
  if (!row) return json({ error: 'Ссылка не найдена. Откройте оплату заново в боте.' }, 404);
  if (req.method === 'GET' && action === 'status') return json(statusOf(row));
  if (req.method === 'GET' && !action) {
    const nonce = crypto.randomUUID();
    const model = {
      title: env.PRODUCT_NAME || 'ИИ курсы', amount: row.amount,
      kaspiUrl: row.status === 'pending' && row.qr_created_at > now() - 150 ? safeKaspiUrl(row.payment_url) : null,
      botUrl: `https://t.me/${/^[A-Za-z0-9_]+$/.test(env.SALES_BOT_USERNAME || '') ? env.SALES_BOT_USERNAME : 'ii_video_foto_bot'}`,
      ...statusOf(row),
    };
    return new Response(checkoutHtml(model, nonce), { headers: {
      ...headers, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    } });
  }
  if (req.method !== 'POST' || action !== 'invoice') return json({ error: 'Method not allowed' }, 405);
  const allowed = new URL(env.CHECKOUT_BASE_URL || env.KASPI_GATEWAY_URL).origin;
  if (req.headers.get('Origin') !== allowed || !req.headers.get('Content-Type')?.startsWith('application/json')) {
    return json({ error: 'Откройте страницу оплаты из бота.' }, 403);
  }
  if (isPaid(row)) return json(statusOf(row));
  if (row.expires_at < now()) return json({ error: 'Ссылка устарела. Нажмите «Оплатить» в боте ещё раз.' }, 410);
  if (row.invoice_state === 'sent') return json({ invoice: 'sent' });
  if (row.invoice_state !== 'none') return json({ error: 'Счёт уже запрошен. Проверьте Kaspi; если счёта нет — напишите в бот.', invoice: row.invoice_state }, 409);
  const raw = await req.text();
  if (raw.length > 512) return json({ error: 'Слишком длинный запрос.' }, 413);
  let body; try { body = JSON.parse(raw); } catch { return json({ error: 'Некорректный запрос.' }, 400); }
  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: 'Введите номер Казахстана: +7 7XX XXX XX XX.' }, 400);
  // An atomic claim prevents two clicks / concurrent requests from sending two invoices.
  const claim = await env.DB.prepare("UPDATE checkouts SET invoice_state='creating' WHERE token=? AND invoice_state='none'")
    .bind(token).run();
  if (!claim.meta.changes) return json({ error: 'Счёт уже запрошен. Проверьте Kaspi.' }, 409);
  const t = now();
  const invoice = await env.DB.prepare(`INSERT INTO payments(tg_id,order_id,status,amount,created_at,is_test)
    SELECT ?,?,'creating',?,?,0 WHERE (SELECT COUNT(*) FROM payments WHERE tg_id=? AND order_id LIKE 'ki%' AND created_at>?)<3
    RETURNING id`).bind(row.tg_id, `ki_${token}`, row.amount, t, row.tg_id, t - 3600).first();
  if (!invoice) {
    await env.DB.prepare("UPDATE checkouts SET invoice_state='limited' WHERE token=?").bind(token).run();
    return json({ error: 'Лимит счетов: 3 в час. Используйте кнопку оплаты через Kaspi или напишите в бот.' }, 429);
  }
  await env.DB.prepare('UPDATE checkouts SET invoice_payment_id=? WHERE token=?').bind(invoice.id, token).run();
  try {
    // Price and recipient Telegram ID come only from the stored order, never from the browser.
    const result = await createKaspiInvoice(env, phone, row.amount);
    await env.DB.batch([
      env.DB.prepare("UPDATE payments SET invoice_id=?,status='pending' WHERE id=?").bind(result.operationId, invoice.id),
      env.DB.prepare("UPDATE checkouts SET invoice_state='sent' WHERE token=?").bind(token),
    ]);
    return json({ invoice: 'sent' });
  } catch {
    // A timeout may happen after Kaspi created the invoice. Never automatically resend.
    await env.DB.batch([
      env.DB.prepare("UPDATE payments SET status='unknown' WHERE id=?").bind(invoice.id),
      env.DB.prepare("UPDATE checkouts SET invoice_state='unknown' WHERE token=?").bind(token),
    ]);
    return json({ error: 'Не удалось подтвердить выставление счёта. Проверьте Kaspi. Если счёта нет — напишите в бот; повторно сейчас не отправляйте.' }, 502);
  }
}
