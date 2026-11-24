const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function checkoutHtml(model, nonce) {
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Оплата курса · AI Pay</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#192335;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100svh;display:grid;place-items:center;padding:28px 16px}.wrap{width:100%;max-width:430px}.brand{text-align:center;font-size:14px;font-weight:750;letter-spacing:3px;margin-bottom:22px;color:#394861}.card{background:white;border:1px solid #e7eaf0;border-radius:26px;padding:30px 26px;box-shadow:0 16px 50px #25355009}.badge{display:inline-block;background:#f0f4ff;color:#4e65a0;border-radius:20px;padding:7px 12px;font-size:12px;font-weight:600}.title{font-size:23px;line-height:1.35;margin:18px 0 20px;font-weight:700;overflow-wrap:anywhere}.amount{font-size:42px;letter-spacing:-1.5px;font-weight:750;margin:0}.currency{font-size:27px;color:#6c7789}.caption{font-size:13px;color:#7c8593;margin:5px 0 25px}.primary,.submit,.back{display:block;text-align:center;text-decoration:none;border:0;border-radius:13px;padding:17px 12px;font:inherit;font-weight:650;width:100%;cursor:pointer}.primary{background:#ed343c;color:white;box-shadow:0 5px 12px #ed343c1a}.primary:focus-visible,.phone-toggle:focus-visible,.submit:focus-visible{outline:3px solid #aec5ff;outline-offset:3px}.primary.disabled{pointer-events:none;opacity:.45}.hint{font-size:13px;line-height:1.6;text-align:center;color:#7c8593;margin:13px 0 0}.divider{height:1px;background:#edf0f4;margin:23px 0 13px}.phone-toggle{display:block;border:0;background:none;color:#246bdd;font:inherit;font-size:14px;padding:12px 4px;margin:0 auto;cursor:pointer}.phone-form{margin-top:15px}label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}input{width:100%;font:inherit;font-size:18px;border:1px solid #d5dce7;border-radius:12px;padding:14px;background:#fafbfe;color:#192335}input:focus{outline:2px solid #c3d7ff;border-color:#3975df}.submit{background:#2367d8;color:#fff;margin-top:12px;font-size:15px}.submit:disabled{opacity:.55;cursor:wait}.note{font-size:12px;color:#7c8593;line-height:1.6;margin:10px 0 0}.status{border-radius:13px;background:#f2f6fc;color:#3c526f;padding:14px;font-size:14px;line-height:1.6;margin-top:17px}.status.error{background:#fff3f2;color:#a83c36}.status.success{background:#ebf9f1;color:#237448}.back{font-size:14px;background:#edf2f9;color:#35577a;margin-top:12px}.footer{text-align:center;color:#8d95a2;font-size:12px;line-height:1.7;margin:20px 16px 0}[hidden]{display:none!important}@media(max-width:360px){.card{padding:24px 20px}.title{font-size:21px}.amount{font-size:36px}}
</style></head><body><main class="wrap"><div class="brand">AI PAY</div><section class="card">
<span class="badge">Онлайн-курс</span><h1 class="title">${escapeHtml(model.title)}</h1>
<p class="amount">${escapeHtml(Number(model.amount).toLocaleString('ru-RU'))} <span class="currency">₸</span></p>
<p class="caption">Разовая оплата · доступ в Telegram</p>
<a id="kaspi" class="primary" href="${escapeHtml(model.kaspiUrl || '#')}">Оплатить через Kaspi</a>
<p id="hint" class="hint">Открываем Kaspi автоматически…<br>Если не открылось — нажмите кнопку выше.</p>
<div class="divider"></div><button id="phone-toggle" class="phone-toggle" type="button" aria-expanded="false" aria-controls="phone-form">Оплатить по номеру телефона</button>
<form id="phone-form" class="phone-form" hidden><label for="phone">Ваш номер в Kaspi</label>
<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 7XX XXX XX XX" maxlength="24" required>
<button id="submit" class="submit" type="submit">Выставить счёт</button>
<p class="note">Счёт придёт в приложение Kaspi.kz. Оплатите его там — после подтверждения бот отправит доступ к курсу.</p></form>
<div id="status" class="status" role="status" aria-live="polite" hidden></div>
<a id="back" class="back" href="${escapeHtml(model.botUrl)}" hidden>Вернуться в Telegram</a>
</section><p class="footer">Оплата проходит в Kaspi.</p></main>
<script nonce="${nonce}">
const model=${data};
const el=id=>document.getElementById(id);
const endpoint=location.pathname;
let autoTimer, pollTimer, paid=false, stopped=false;
const message=(text,type='')=>{el('status').hidden=false;el('status').className='status '+type;el('status').textContent=text;};
const stopAuto=()=>{clearTimeout(autoTimer);try{sessionStorage.setItem(endpoint,'opened');}catch{}};
const disableKaspi=()=>{el('kaspi').classList.add('disabled');el('kaspi').setAttribute('aria-disabled','true');};
function showState(state){
  if(state.paid){paid=true;stopAuto();disableKaspi();el('phone-toggle').hidden=true;el('phone-form').hidden=true;el('hint').hidden=true;el('back').hidden=false;message(state.delivered?'Оплата подтверждена! Бот отправил доступ к курсу в Telegram.':'Оплата подтверждена. Отправляем доступ в Telegram…','success');if(state.delivered)stopped=true;return;}
  if(state.invoice==='sent'){stopAuto();disableKaspi();el('phone-form').hidden=true;el('phone-toggle').hidden=true;el('hint').textContent='Счёт выставлен — оплатите его в приложении Kaspi.kz.';message(state.invoiceFailed?'Этот счёт отменён или истёк. Вернитесь в бот для новой оплаты.':'Счёт отправлен в Kaspi.kz. Ожидаем оплату…');el('back').hidden=false;return;}
  if(state.invoice&&state.invoice!=='none'){stopAuto();disableKaspi();el('phone-toggle').hidden=true;el('phone-form').hidden=true;el('hint').textContent='Проверьте счета в приложении Kaspi.kz.';message('Запрос на счёт уже отправлен. Если счёт не появился, напишите в бот.');el('back').hidden=false;}
  if(state.expired){stopAuto();disableKaspi();el('phone-toggle').hidden=true;el('phone-form').hidden=true;el('back').hidden=false;message('Ссылка устарела. Нажмите «Оплатить» в Telegram ещё раз.');stopped=true;}
}
el('phone-toggle').onclick=()=>{stopAuto();el('hint').textContent='Укажите номер — счёт придёт в приложение Kaspi.kz.';el('phone-form').hidden=false;el('phone-toggle').setAttribute('aria-expanded','true');el('phone').focus();};
el('kaspi').onclick=()=>{stopAuto();};
el('phone-form').onsubmit=async event=>{
  event.preventDefault();stopAuto();if(paid)return;el('submit').disabled=true;disableKaspi();message('Выставляем счёт…');
  try{const response=await fetch(endpoint+'/invoice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:el('phone').value}),signal:AbortSignal.timeout(35000)});const body=await response.json();
    if(!response.ok){message(body.error||'Не удалось выставить счёт. Напишите в бот.','error');if(response.status===400){el('submit').disabled=false;if(model.kaspiUrl){el('kaspi').classList.remove('disabled');el('kaspi').removeAttribute('aria-disabled');}}else{el('back').hidden=false;}return;}
    el('phone').value='';showState(body);
  }catch{message('Ответ задерживается. Проверьте Kaspi перед повторной попыткой. При необходимости напишите в бот.','error');el('back').hidden=false;}
};
async function poll(){if(stopped)return;if(!document.hidden){try{const r=await fetch(endpoint+'/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(r.ok)showState(await r.json());}catch{}}pollTimer=setTimeout(poll,5000);}
showState(model);
if(!model.kaspiUrl&&!model.paid&&model.invoice==='none'&&!model.expired){disableKaspi();el('hint').textContent='Ссылка Kaspi истекла. Можно выставить счёт по номеру телефона или получить новую ссылку в боте.';el('back').hidden=false;}
let opened=false;try{opened=sessionStorage.getItem(endpoint)==='opened';}catch{}
if(model.kaspiUrl&&!model.paid&&!model.expired&&model.invoice==='none'&&!opened){autoTimer=setTimeout(()=>{stopAuto();location.href=model.kaspiUrl;},2500);}
window.addEventListener('pagehide',()=>{stopAuto();clearTimeout(pollTimer);});
window.addEventListener('pageshow',event=>{if(event.persisted){clearTimeout(pollTimer);poll();}});
poll();
</script></body></html>`;
}
