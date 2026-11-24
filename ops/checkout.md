# Checkout deployment

The Worker renders `/pay/<random-token>` and handles status/invoice requests. Caddy forwards only `/pay/*` to the Worker, retaining the rest of the gateway routes. Gateway keys and cashier sessions are never sent to the browser. Checkout links are tied to a stored Telegram payment and expire after 30 minutes; Kaspi QR links have a much shorter lifetime and are not reused on the page after 150 seconds. The main button redirects automatically after 2.5 seconds, once per browser session; opening the phone form cancels that redirect.

1. Deploy the updated Worker with `KASPI_GATEWAY_URL` and `CHECKOUT_BASE_URL` set to `https://aipay.duckdns.org`. Existing Cloudflare secrets must remain configured. Tables are created automatically, without deleting existing data.
2. On the VPS, run `cd /opt/aicourse && git pull --ff-only && bash ops/install-checkout.sh`. This preserves local `gateway/server.js`, dependency fixes and `/var/lib/aicourse` sessions. If git reports overlapping local edits, stop and inspect them; do not reset the checkout.
3. In the admin bot send `/checkout_on`. It verifies the public page route before enabling checkout links. `/checkout_off` restores direct Kaspi links. The switch is in D1 and survives future code deploys.
4. Obtain a NEW payment button in the sales bot. Test automatic redirection, returning to the page, cancelling redirection by opening the phone form, and issuing an invoice. A page creates at most one phone invoice; each Telegram recipient is limited to three invoice attempts per hour. Unknown outcomes are not automatically retried, to avoid double invoices.
5. Complete separate real payment tests for QR and phone invoice using users who have not already received the course. Check Kaspi Pay, the customer bot message, channel access and admin notification. Do not use `/testpay` as evidence that bank polling/webhooks work.

Payment confirmation requires a valid gateway HMAC, `Processed` status and sufficient amount. QR and phone invoice payment records can both be associated with the checkout. Failed Telegram delivery remains queued for the minute cron; account credit is idempotent. A crash immediately after Telegram accepts a message can still cause a duplicate message on retry (Telegram has no idempotency key). The course invite is reused. Older already-paid records are not replayed automatically.

Gateway webhook delivery is persisted before sending and retried with bounded backoff until acknowledged. Unknown bank statuses remain pending. Data and secrets are in `/var/lib/aicourse` and `/etc/aicourse/gateway.env`, not in git.

Local verification: Node 24+ `node --test test/*.test.js` (SQLite built-in; no real bank/Telegram requests). A successful local test does not establish compatibility with the current live Kaspi API; the real payment tests above are still required.
