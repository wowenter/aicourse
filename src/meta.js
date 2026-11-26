// Отправка событий в Meta (Facebook) Conversions API — серверная сторона пикселя
const GRAPH = 'https://graph.facebook.com/v21.0';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text).trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * eventName: 'ViewContent' | 'Lead' | 'InitiateCheckout' | 'Purchase'
 * u: объект с данными пользователя и клика (tg_id, fbclid, fbp, ip, ua, page_url)
 */
export async function sendMetaEvent(env, eventName, u, { eventId, value } = {}) {
  const pixelId = env.META_PIXEL_ID;
  if (!pixelId || pixelId.startsWith('ВСТАВЬТЕ') || !env.META_ACCESS_TOKEN) {
    console.log('meta: not configured, skip', eventName);
    return null;
  }

  const userData = {};
  if (u.tg_id) userData.external_id = await sha256(String(u.tg_id));
  if (u.ip) userData.client_ip_address = u.ip;
  if (u.ua) userData.client_user_agent = u.ua;
  if (u.fbp) userData.fbp = u.fbp;
  // fbc собирается из fbclid по формату Meta: fb.1.<ts_ms>.<fbclid>
  if (u.fbc) userData.fbc = u.fbc;
  else if (u.fbclid) userData.fbc = `fb.1.${Date.now()}.${u.fbclid}`;

  const data = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    event_source_url: u.page_url || env.LANDING_URL,
    user_data: userData,
  };
  if (value) {
    data.custom_data = {
      value: Number(value),
      currency: 'KZT',
      content_ids: ['course'],
      content_type: 'product',
      content_name: env.PRODUCT_NAME || 'Курс',
    };
  }

  const body = { data: [data] };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(`${GRAPH}/${pixelId}/events?access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const ok = r.ok && j.events_received != null;
    console.log('meta', eventName, u.tg_id || u.code || '', JSON.stringify(ok ? { events_received: j.events_received } : j).slice(0, 300));
    return j;
  } catch (e) {
    console.log('meta failed', eventName, String(e));
    return null;
  }
}
