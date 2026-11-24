// ApiPay (Kaspi Pay): создание ссылки на оплату и проверка вебхуков
const BASE = 'https://api.apipay.kz/api/v1';

export async function createPaymentLink(env, { orderId, amount, description }) {
  const r = await fetch(`${BASE}/invoices/qr`, {
    method: 'POST',
    headers: {
      'X-API-Key': env.APIPAY_API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': orderId,
    },
    body: JSON.stringify({
      amount: Number(amount),
      description: description.slice(0, 100),
      static: true, // ссылка на оплату в Kaspi
      external_order_id: orderId,
      success_url: `https://t.me/${env.SALES_BOT_USERNAME}`,
    }),
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok || !j.payment_url) {
    throw new Error(`ApiPay ${r.status}: ${text.slice(0, 500)}`);
  }
  return {
    url: j.payment_url,
    staticQrId: j.static_qr_id != null ? String(j.static_qr_id) : null,
    invoiceId: j.id != null ? String(j.id) : null,
  };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, body, enc) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  if (enc === 'b64') return btoa(String.fromCharCode(...sig));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Возвращает { ok, reason } — reason объясняет, почему подпись не прошла (без раскрытия секрета) */
export async function verifyWebhook(env, rawBody, signatureHeader) {
  const secret = (env.APIPAY_WEBHOOK_SECRET || '').trim();
  if (!secret) return { ok: false, reason: 'в Cloudflare нет секрета APIPAY_WEBHOOK_SECRET (или деплой ещё не прошёл)' };
  if (!signatureHeader) return { ok: false, reason: 'ApiPay прислал уведомление без подписи — в кабинете ApiPay не создан секретный ключ защиты уведомлений' };
  const got = signatureHeader.trim().replace(/^sha256=/i, '');
  const hex = await hmac(secret, rawBody, 'hex');
  if (timingSafeEqual(hex, got.toLowerCase())) return { ok: true };
  const b64 = await hmac(secret, rawBody, 'b64');
  if (timingSafeEqual(b64, got)) return { ok: true };
  return { ok: false, reason: `подпись не совпала — секрет в Cloudflare (${secret.length} симв.) не тот, что в ApiPay. Скопируйте секрет заново` };
}

/** Проверка подписи sha256=<hex> любым секретом (используется и для шлюза Kaspi) */
export async function verifyHmac(secret, rawBody, signatureHeader) {
  secret = (secret || '').trim();
  if (!secret || !signatureHeader) return false;
  const got = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
  return timingSafeEqual(await hmac(secret, rawBody, 'hex'), got);
}

/** Достаёт из вебхука то, что нужно: статус и как найти наш платёж */
export function parseWebhook(body) {
  const inv = body.invoice || {};
  return {
    event: body.event,
    isSandbox: !!body.is_sandbox,
    status: inv.status,
    invoiceId: inv.id != null ? String(inv.id) : null,
    externalOrderId: inv.external_order_id || body.external_order_id || null,
    staticQrId: inv.static_qr_id != null ? String(inv.static_qr_id)
      : body.static_qr_id != null ? String(body.static_qr_id) : null,
    amount: inv.amount ?? inv.total_amount ?? null,
  };
}
