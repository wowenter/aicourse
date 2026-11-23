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

export async function verifyWebhook(env, rawBody, signatureHeader) {
  if (!env.APIPAY_WEBHOOK_SECRET) {
    console.log('apipay: APIPAY_WEBHOOK_SECRET not set — webhook rejected');
    return false;
  }
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.APIPAY_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = signatureHeader.replace(/^sha256=/, '').trim().toLowerCase();
  return timingSafeEqual(hex, got);
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
