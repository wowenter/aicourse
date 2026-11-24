// Своя касса: обращение к шлюзу Kaspi (папка gateway/, работает на Railway)
import { getSetting, setSetting } from './db.js';

export async function paymentProvider(env) {
  const p = await getSetting(env.DB, 'payment_provider', env.PAYMENT_PROVIDER || 'apipay');
  return p === 'kaspi' ? 'kaspi' : 'apipay';
}

function gw(env) {
  const base = (env.KASPI_GATEWAY_URL || '').replace(/\/+$/, '');
  if (!base || !env.KASPI_GATEWAY_KEY) throw new Error('Шлюз Kaspi не настроен (нет KASPI_GATEWAY_URL или KASPI_GATEWAY_KEY)');
  return base;
}

async function call(env, method, path, { body, session } = {}) {
  const headers = { 'X-Gateway-Key': env.KASPI_GATEWAY_KEY, 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Token-SN'] = session.tokenSN;
    headers['X-Vtoken-Secret'] = session.vtokenSecret;
    headers['X-Profile-Id'] = String(session.profileId ?? '');
  }
  const r = await fetch(gw(env) + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, data: j };
}

// ---------------------------------------------------------------- сессия кассира
export async function getKaspiSession(env) {
  const raw = await getSetting(env.DB, 'kaspi_session');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function loginStart(env, phone) {
  const init = await call(env, 'POST', '/api/auth/init');
  if (!init.data?.processId) throw new Error('init: ' + JSON.stringify(init.data).slice(0, 300));
  const sp = await call(env, 'POST', '/api/auth/send-phone', { body: { processId: init.data.processId, phoneNumber: phone } });
  if (!sp.data?.success) {
    const why = sp.data?.errorMessage || sp.data?.errorCode || sp.data?.desc || sp.data?.error || JSON.stringify(sp.data).slice(0, 200);
    throw new Error(why);
  }
  return init.data.processId;
}

export async function loginFinish(env, processId, otp) {
  const v = await call(env, 'POST', '/api/auth/verify-otp', { body: { processId, otp } });
  const d = v.data || {};
  if (!d.success || !d.tokenSN || !d.vtokenSecret) {
    throw new Error(d.error || 'Код не подошёл или устарел');
  }
  const session = { tokenSN: d.tokenSN, vtokenSecret: d.vtokenSecret, profileId: d.profileId, orgName: d.orgName || '', phone: d.phone || '' };
  await setSetting(env.DB, 'kaspi_session', JSON.stringify(session));
  return session;
}

export async function checkSession(env) {
  const s = await getKaspiSession(env);
  if (!s) return { active: false, reason: 'вход не выполнен' };
  const r = await call(env, 'GET', '/api/session/check', { session: s });
  return { active: !!r.data?.active, reason: r.data?.error || r.data?.message || '', orgName: s.orgName };
}

// ---------------------------------------------------------------- оплата
export async function createKaspiPayment(env, amount) {
  const s = await getKaspiSession(env);
  if (!s) throw new Error('Kaspi: вход кассира не выполнен');
  const r = await call(env, 'POST', '/api/qr/create', { body: { amount: Number(amount) }, session: s });
  const d = r.data?.Data;
  if (!d?.QrOperationId || !d?.QrToken) {
    throw new Error('Kaspi qr/create: ' + JSON.stringify(r.data).slice(0, 300));
  }
  return { url: d.QrToken, operationId: String(d.QrOperationId), expireDate: d.ExpireDate || null };
}

export async function createKaspiInvoice(env, phoneNumber, amount) {
  const s = await getKaspiSession(env);
  if (!s) throw new Error('Cashier session missing');
  const r = await call(env, 'POST', '/api/invoice/create', {
    body: { phoneNumber, amount: Number(amount), comment: String(env.PRODUCT_NAME || 'Курс').slice(0, 100) },
    session: s,
  });
  const id = r.data?.Data?.QrOperationId;
  if (!r.ok || id == null || !/^\d+$/.test(String(id))) throw new Error('Invoice creation not confirmed');
  return { operationId: String(id) };
}

