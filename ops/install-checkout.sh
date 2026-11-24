#!/usr/bin/env bash
set -euo pipefail
cd /opt/aicourse
test "$(id -u)" -eq 0
test -f /etc/aicourse/gateway.env
test -x /snap/node/current/bin/node

# Do not route customers to a Worker whose new version has not deployed yet.
curl -fsS --max-time 20 https://aicourse.arsennumberone.workers.dev/pay/health \
  | /snap/node/current/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{if(JSON.parse(s).checkout!==1)throw 0}catch{console.error("Cloudflare ещё не обновлён. Дождитесь успешного Deploy и повторите команду.");process.exit(1)}})'

for file in gateway/src/polling.js gateway/src/routes/qr.js gateway/src/routes/invoice.js; do
  /snap/node/current/bin/node --check "$file"
done

# Preserve the existing loopback binding, local dependency fixes and all keys/session files.
if ! /snap/node/current/bin/node --input-type=module -e 'import fs from "node:fs"; if(!/app\.listen\(PORT,\s*["\x27]127\.0\.0\.1["\x27]/.test(fs.readFileSync("gateway/server.js","utf8")))process.exit(1)'; then
  echo 'Остановка: шлюз должен слушать 127.0.0.1. Текущий server.js сохранён.'
  exit 1
fi

caddy validate --config /opt/aicourse/ops/Caddyfile --adapter caddyfile
backup="/etc/caddy/Caddyfile.before-checkout.$(date +%s)"
cp -a /etc/caddy/Caddyfile "$backup"
install -m 644 /opt/aicourse/ops/Caddyfile /etc/caddy/Caddyfile
if ! systemctl reload caddy; then
  cp -a "$backup" /etc/caddy/Caddyfile
  systemctl reload caddy
  exit 1
fi
systemctl restart aicourse-gateway
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 --max-time 10 http://127.0.0.1:3000/health
echo
curl -fsS --max-time 20 https://aipay.duckdns.org/pay/health
echo
echo 'ГОТОВО. В админ-боте отправьте /checkout_on, затем получите новую кнопку оплаты в боте курса.'
