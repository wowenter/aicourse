// Отправка событий в TikTok Events API (серверная сторона пикселя)
const TT_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * event: 'CompleteRegistration' | 'InitiateCheckout' | 'Purchase'
 * u: строка пользователя вместе с данными клика (getUserWithClick)
 */
export async function sendTikTokEvent(env, event, u, { eventId, value } = {}) {
  if (!env.TIKTOK_ACCESS_TOKEN || !env.TIKTOK_PIXEL_ID || env.TIKTOK_PIXEL_ID.startsWith('ВСТАВЬТЕ')) {
    console.log('tiktok: not configured, skip', event);
    return null;
  }
  const user = {};
  if (u.tg_id) user.external_id = await sha256(String(u.tg_id));
  if (u.ttclid) user.ttclid = u.ttclid;
  if (u.ttp) user.ttp = u.ttp;
  if (u.ip) user.ip = u.ip;
  if (u.ua) user.user_agent = u.ua;

  const data = {
    event,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    user,
    page: { url: u.page_url || env.LANDING_URL },
  };
  if (value) {
    data.properties = {
      value: Number(value),
      currency: 'KZT',
      content_type: 'product',
      contents: [{ content_id: 'course', content_name: env.PRODUCT_NAME, price: Number(value), quantity: 1 }],
    };
  }
  const body = { event_source: 'web', event_source_id: env.TIKTOK_PIXEL_ID, data: [data] };
  if (env.TIKTOK_TEST_EVENT_CODE) body.test_event_code = env.TIKTOK_TEST_EVENT_CODE;

  try {
    const r = await fetch(TT_URL, {
      method: 'POST',
      headers: { 'Access-Token': env.TIKTOK_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    console.log('tiktok', event, u.tg_id || u.code || '', JSON.stringify(j));
    return j;
  } catch (e) {
    console.log('tiktok failed', event, String(e));
    return null;
  }
}
