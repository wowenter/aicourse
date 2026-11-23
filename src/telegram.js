export async function tg(token, method, body = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.log('telegram error', method, JSON.stringify(j));
    return j;
  } catch (e) {
    console.log('telegram fetch failed', method, String(e));
    return { ok: false, description: String(e) };
  }
}

export async function tgSendDocument(token, chatId, filename, content, caption = '') {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob([content], { type: 'text/csv' }), filename);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
  return r.json();
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function userLabel(u) {
  const name = esc(u.first_name || 'Без имени');
  return u.username ? `${name} (@${esc(u.username)})` : `${name} (id ${u.tg_id})`;
}
