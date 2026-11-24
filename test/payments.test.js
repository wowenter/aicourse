import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { Script, runInNewContext } from 'node:vm';
import { ensureSchema, now } from '../src/db.js';
import { checkoutLink, handleCheckout, normalizePhone, safeKaspiUrl } from '../src/checkout.js';
import { checkoutHtml } from '../src/checkout-page.js';
import { grantAccess, handleSalesUpdate } from '../src/sales.js';
import { runPaymentExpiryNotices } from '../src/payment-expiry.js';
import { retryDeliveries } from '../src/delivery.js';
import { kaspiWebhook } from '../src/index.js';

const sqlite = new DatabaseSync(':memory:');
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return {results: sqlite.prepare(this.sql).all(...this.args)}; }
  async run() { return {meta: sqlite.prepare(this.sql).run(...this.args)}; }
}
const db = {
  prepare: sql => new Statement(sql),
  async batch(statements) {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const env = { DB: db, KASPI_GATEWAY_URL: 'https://aipay.duckdns.org', KASPI_GATEWAY_KEY: 'test-only-key',
  KASPI_WEBHOOK_SECRET: 'test-only-webhook', SALES_BOT_TOKEN: 'test-only-bot', SALES_BOT_USERNAME: 'test_bot', CHANNEL_ID: '-1001' };
const ctx = {waitUntil: promise => promise.catch(() => {})};
const originalFetch = globalThis.fetch;
let invoices, deliveries, failSend, invoiceMode;
before(async () => { await ensureSchema(db); });
beforeEach(async () => {
  for (const table of ['payment_expiry_notices', 'checkouts', 'payment_delivery', 'payments', 'users', 'settings', 'clicks']) sqlite.exec(`DELETE FROM ${table}`);
  invoices = []; deliveries = []; failSend = false; invoiceMode = 'success';
  await db.prepare('INSERT INTO users(tg_id,first_name) VALUES(?,?)').bind(123, 'Test').run();
  await db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind('kaspi_session', JSON.stringify({tokenSN:'test',vtokenSecret:'test',profileId:1})).run();
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/answerCallbackQuery')) return Response.json({ok:true});
    if (String(url).endsWith('/api/qr/create')) return Response.json({Data:{QrOperationId:10001,QrToken:'https://pay.kaspi.kz/pay/new'}});
    if (String(url).endsWith('/api/invoice/create')) {
      invoices.push(body);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (invoiceMode === 'timeout') throw new Error('timeout');
      return Response.json({Data:{QrOperationId: 900 + invoices.length}});
    }
    if (String(url).endsWith('/createChatInviteLink')) return Response.json({ok:true,result:{invite_link:'https://t.me/+test-invite'}});
    if (String(url).endsWith('/sendMessage')) {
      deliveries.push(body);
      return Response.json(failSend ? {ok:false,description:'Temporary failure'} : {ok:true,result:{message_id:1}});
    }
    throw new Error('Unexpected network request');
  };
});
after(() => { globalThis.fetch = originalFetch; sqlite.close(); });

async function seed(order = 'kq_test', operation = '100') {
  const p = await db.prepare("INSERT INTO payments(tg_id,order_id,invoice_id,payment_url,status,amount,created_at,is_test) VALUES(123,?,?,?,'pending',4990,?,0) RETURNING id")
    .bind(order,operation,'https://pay.kaspi.kz/pay/test',now()).first();
  return {id:p.id,url:await checkoutLink(env,p.id)};
}
const invoiceReq = (url, phone = '+7 (707) 123-45-67', origin = env.KASPI_GATEWAY_URL) => new Request(url+'/invoice', {
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({phone,amount:1,tg_id:999}),
});
function webhook(body, valid = true) {
  const raw = JSON.stringify(body);
  return new Request('https://worker.test/kaspi/webhook',{method:'POST',body:raw,headers:{'X-Webhook-Signature':
    'sha256='+createHmac('sha256',valid?env.KASPI_WEBHOOK_SECRET:'wrong').update(raw).digest('hex')}});
}

test('KZ phone normalization and redirect allowlist', () => {
  for (const phone of ['+7 (707) 123-45-67','87071234567','7071234567']) assert.equal(normalizePhone(phone),'7071234567');
  for (const phone of ['+1 202 555 0100','abc7071234567','+7 495 1234567','123',null]) assert.equal(normalizePhone(phone),null);
  for (const url of ['javascript:alert(1)','https://pay.kaspi.kz.evil.test/','https://evil.test/','http://pay.kaspi.kz/']) assert.equal(safeKaspiUrl(url),null);
  assert.ok(safeKaspiUrl('https://pay.kaspi.kz/pay/test'));
});
test('private checkout page has no secrets, escapes content and has valid inline JS', async () => {
  const p = await seed(); const response = await handleCheckout(new Request(p.url),env); const html=await response.text();
  assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.match(html,/Оплатить по номеру телефона/); assert.match(html,/2500/); assert.ok(!html.includes(env.KASPI_GATEWAY_KEY));
  const script=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]; new Script(script);
  const hostile=checkoutHtml({title:'</script><img onerror="alert(1)">',amount:4990},'test');
  assert.ok(!hostile.includes('<img')); assert.match(hostile,/\\u003c/);
  const stable=await checkoutLink(env,p.id);assert.equal(stable,p.url);
});
test('invoice uses stored price, rejects cross-site/invalid phone, deduplicates parallel requests', async () => {
  const p=await seed();
  assert.equal((await handleCheckout(invoiceReq(p.url,'123'),env)).status,400);
  assert.equal((await handleCheckout(invoiceReq(p.url,'7071234567','https://evil.test'),env)).status,403);
  const results=await Promise.all([handleCheckout(invoiceReq(p.url),env),handleCheckout(invoiceReq(p.url),env)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]); assert.equal(invoices.length,1);
  assert.equal(invoices[0].amount,4990);assert.equal(invoices[0].phoneNumber,'7071234567');
  assert.equal((await handleCheckout(invoiceReq(p.url),env)).status,200);assert.equal(invoices.length,1);
  const invoice=await db.prepare("SELECT * FROM payments WHERE order_id LIKE 'ki%'").first();assert.equal(invoice.tg_id,123);
});
test('expiry and rate limit prevent extra invoices', async () => {
  const p=await seed();await db.prepare('UPDATE checkouts SET expires_at=?').bind(now()-1).run();
  assert.equal((await handleCheckout(invoiceReq(p.url),env)).status,410);
  for(let i=0;i<4;i++){
    const row=await seed('kq_'+i,String(101+i));
    assert.equal((await handleCheckout(invoiceReq(row.url),env)).status,i<3?200:429);
  }
  assert.equal(invoices.length,3);
});
test('uncertain upstream outcome does not resend invoice', async () => {
  const p=await seed();invoiceMode='timeout';
  assert.equal((await handleCheckout(invoiceReq(p.url),env)).status,502);
  assert.equal((await handleCheckout(invoiceReq(p.url),env)).status,409);assert.equal(invoices.length,1);
});
test('only signed Processed payment with sufficient amount can grant access', async () => {
  const p=await seed();const success={event:'payment.success',type:'qr',paymentId:'100',status:'Processed',amount:4990};
  assert.equal((await kaspiWebhook(webhook(success,false),env,ctx)).status,401);
  for(const bad of [{...success,amount:1},{...success,amount:null},{...success,status:'Wait'}]){
    assert.equal((await kaspiWebhook(webhook(bad),env,ctx)).status,422);
  }
  assert.equal(deliveries.length,0);
  assert.equal((await kaspiWebhook(webhook(success),env,ctx)).status,200);
  assert.equal((await kaspiWebhook(webhook(success),env,ctx)).status,200);assert.equal(deliveries.length,1);
  const u=await db.prepare('SELECT * FROM users WHERE tg_id=123').first();assert.equal(u.amount,4990);
  const status=await (await handleCheckout(new Request(p.url+'/status'),env)).json();assert.equal(status.paid,true);assert.equal(status.delivered,true);
});
test('phone invoice webhook is tied to the same checkout and Telegram recipient', async () => {
  const p=await seed();await handleCheckout(invoiceReq(p.url),env);
  const r=await kaspiWebhook(webhook({event:'payment.success',type:'invoice',paymentId:'901',status:'Processed',amount:4990}),env,ctx);
  assert.equal(r.status,200);assert.equal(deliveries[0].chat_id,123);
  const status=await (await handleCheckout(new Request(p.url+'/status'),env)).json();assert.equal(status.paid,true);
  await handleCheckout(invoiceReq(p.url),env);assert.equal(invoices.length,1);
});
test('unmatched early webhook requests retry instead of acknowledging lost payment', async () => {
  assert.equal((await kaspiWebhook(webhook({event:'payment.success',type:'qr',paymentId:'9000',status:'Processed',amount:4990}),env,ctx)).status,503);
});
test('Telegram failure remains queued, cron retries without double credit', async () => {
  const p=await seed();failSend=true;await assert.rejects(grantAccess(env,p.id));
  let row=await db.prepare('SELECT * FROM payment_delivery WHERE payment_id=?').bind(p.id).first();assert.equal(row.state,'pending');
  failSend=false;await db.prepare('UPDATE payment_delivery SET lock_until=0').run();await retryDeliveries(env);
  row=await db.prepare('SELECT * FROM payment_delivery WHERE payment_id=?').bind(p.id).first();assert.equal(row.state,'done');
  assert.equal((await db.prepare('SELECT amount FROM users WHERE tg_id=123').first()).amount,4990);assert.equal(deliveries.length,2);
  await grantAccess(env,p.id);assert.equal(deliveries.length,2);
});

function browser(model, opened = false) {
  const elements = new Map(); const timers = new Map(); let serial = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {hidden:false, value:'', classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){},focus(){}});
    return elements.get(id);
  };
  const sandbox = {
    document:{hidden:false,getElementById:element},location:{pathname:'/pay/test',href:''},
    sessionStorage:{getItem:()=>opened?'opened':null,setItem(){opened=true;}},
    window:{addEventListener(){}},AbortSignal,
    fetch:async()=>Response.json({paid:false,invoice:'none'}),
    setTimeout:(fn,delay)=>{timers.set(++serial,{fn,delay});return serial;},
    clearTimeout:id=>timers.delete(id),
  };
  const html=checkoutHtml({title:'Курс',amount:4990,kaspiUrl:'https://pay.kaspi.kz/pay/test',botUrl:'https://t.me/test_bot',paid:false,invoice:'none',expired:false,...model},'test');
  runInNewContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1],sandbox);
  return {sandbox,element,timers};
}
test('auto redirect is preserved and phone form cancels it', () => {
  let b=browser({});let auto=[...b.timers.values()].find(t=>t.delay===2500);assert.ok(auto);auto.fn();
  assert.equal(b.sandbox.location.href,'https://pay.kaspi.kz/pay/test');
  b=browser({});b.element('phone-toggle').onclick();assert.equal(b.element('phone-form').hidden,false);
  assert.ok(![...b.timers.values()].some(t=>t.delay===2500));
});
test('no redirect loop on return, or after payment/invoice/expiry', () => {
  for(const [state,opened] of [[{},true],[{paid:true},false],[{invoice:'sent'},false],[{expired:true},false]]){
    const b=browser(state,opened);assert.ok(![...b.timers.values()].some(t=>t.delay===2500));
  }
});

async function enableExpiry() {
  for(const [key,value] of [['checkout_enabled','1'],['payment_provider','kaspi'],['payment_expiry_notices_since',String(now()-1000)]]){
    await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,value).run();
  }
}
async function age(id, seconds=181) {
  await db.prepare('UPDATE payments SET created_at=? WHERE id=?').bind(now()-seconds,id).run();
}
test('expiry notice starts at 180 seconds, sends once, and button produces a fresh payment message', async()=>{
  await enableExpiry();const p=await seed();await age(p.id,179);await runPaymentExpiryNotices(env);assert.equal(deliveries.length,0);
  await age(p.id,181);await runPaymentExpiryNotices(env);await runPaymentExpiryNotices(env);
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].reply_markup.inline_keyboard[0][0].callback_data,'pay:refresh');
  await handleSalesUpdate(env,{callback_query:{id:'test',data:'pay:refresh',from:{id:123,first_name:'Test'}}});
  assert.equal(deliveries.length,2);assert.match(deliveries[1].reply_markup.inline_keyboard[0][0].url,/^https:\/\/aipay.duckdns.org\/pay\/[a-f0-9]{64}$/);
  const last=await db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 1').first();assert.notEqual(last.id,p.id);assert.equal(last.invoice_id,'10001');
});
test('paid orders and active phone invoices suppress expired QR notices', async()=>{
  await enableExpiry();const p=await seed();await age(p.id);await handleCheckout(invoiceReq(p.url),env);
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,0);
  await db.prepare("UPDATE payments SET status='expired' WHERE order_id LIKE 'ki%'").run();
  await db.prepare("UPDATE payments SET status='paid' WHERE id=?").bind(p.id).run();
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,0);
});
test('a newer QR suppresses old link notices; bank-expired phone invoice gets a renewal button', async()=>{
  await enableExpiry();const old=await seed();await age(old.id);const latest=await seed('kq_latest','200');
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,0);
  await handleCheckout(invoiceReq(latest.url),env);await db.prepare("UPDATE payments SET status='expired' WHERE order_id LIKE 'ki%'").run();
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,1);
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,1);
});
test('failed expiry message is retried and historic orders are not messaged on first activation', async()=>{
  const p=await seed();await age(p.id);await db.prepare("INSERT INTO settings(key,value) VALUES('checkout_enabled','1')").run();
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,0);await runPaymentExpiryNotices(env);assert.equal(deliveries.length,0);
  await enableExpiry();failSend=true;await runPaymentExpiryNotices(env);assert.equal(deliveries.length,1);
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,1);
  failSend=false;await db.prepare('UPDATE payment_expiry_notices SET lock_until=0').run();await runPaymentExpiryNotices(env);assert.equal(deliveries.length,2);
  await runPaymentExpiryNotices(env);assert.equal(deliveries.length,2);
});
