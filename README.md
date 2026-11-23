# Курс-бот: TikTok → лендинг → Telegram → Kaspi

## Что внутри
| Папка | Что это | Где работает |
|---|---|---|
| `docs/index.html` | Лендинг с пикселем TikTok | GitHub Pages |
| `src/` | Бот продаж, админ-бот, TikTok Events API, ApiPay, напоминания | Cloudflare Workers |
| `src/texts.js` | **Все тексты бота** — правьте здесь | |

События в TikTok: **CompleteRegistration** (старт в боте) → **InitiateCheckout** (нажал «Оплатить») → **Purchase** (оплатил, 4990 KZT).

---

## Шаг 1. Залить в GitHub
Загрузите все файлы в репозиторий (кроме `node_modules`).

## Шаг 2. Лендинг (GitHub Pages)
1. Репозиторий → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, папка **`/docs`** → Save.
2. Адрес лендинга: `https://wowenter.github.io/aicourse/` (уже прописан в `wrangler.toml`).

## Шаг 3. Воркер (Cloudflare)
1. Cloudflare → **Workers & Pages → Create → Import a repository** → выберите репозиторий → Deploy.
   Каждое изменение в GitHub будет обновлять бота автоматически.
2. После деплоя скопируйте адрес воркера (`https://course-bot.xxxx.workers.dev`) и впишите его в `docs/index.html` → `API`.
3. Воркер → **Settings → Variables and Secrets** → добавьте (тип **Secret**):

| Имя | Что вписать |
|---|---|
| `SALES_BOT_TOKEN` | токен @ii_video_foto_bot из @BotFather |
| `ADMIN_BOT_TOKEN` | токен @traffic_aicheckbot |
| `ADMIN_IDS` | ваш Telegram ID (узнать: напишите /start админ-боту — он покажет) |
| `WEBHOOK_SECRET` | любая длинная строка из латинских букв и цифр |
| `TIKTOK_ACCESS_TOKEN` | TikTok Events Manager → пиксель → Settings → Generate Access Token |
| `APIPAY_API_KEY` | кабинет ApiPay → API-ключ |
| `APIPAY_WEBHOOK_SECRET` | кабинет ApiPay → ключ → «Ещё» → «Создать секретный ключ подписи» |
| `CHANNEL_ID` | ID закрытого канала (вида `-100…`). Бот продаж должен быть **админом канала** с правом приглашать |
| `TIKTOK_TEST_EVENT_CODE` | *(на время проверки)* код из вкладки Test Events |

4. В `wrangler.toml` и `docs/index.html` впишите **ID пикселя** вместо `ВСТАВЬТЕ_ID_ПИКСЕЛЯ`.
5. Откройте в браузере один раз:
   `https://course-bot.xxxx.workers.dev/setup?key=ВАШ_WEBHOOK_SECRET`
   Должно быть `"ok": true` у sales и admin — боты подключены.

## Шаг 4. ApiPay
Кабинет ApiPay → **Настройки → Подключение** → `webhook_url`:
`https://course-bot.xxxx.workers.dev/apipay/webhook`
Нажмите «Проверить уведомления» — должен вернуться ответ 200.

## Шаг 5. Проверка
1. Откройте лендинг с `?ttclid=test` → «Получить курс» → «Старт» в боте.
2. В админ-боте: 📊 Сегодня — должен быть 1 визит и 1 старт.
3. В TikTok Events Manager → Test Events — появится CompleteRegistration.
4. Нажмите «Оплатить» → откроется Kaspi (в песочнице ApiPay — тестовая оплата).
5. Без ApiPay выдачу доступа можно проверить командой в админ-боте: `/testpay` (выдаст доступ вам) или `/testpay 123456789`.

**Перед запуском рекламы:** удалите `TIKTOK_TEST_EVENT_CODE`, а в `wrangler.toml` поставьте `APIPAY_SANDBOX = "0"`.

## Ссылка для объявления в TikTok
```
https://wowenter.github.io/aicourse/?utm_source=tiktok&utm_campaign=__CAMPAIGN_NAME__&utm_adgroup=__AID_NAME__&utm_ad=__CID_NAME__
```
TikTok сам подставит названия кампании, группы и объявления — в админ-боте будет видно, какое объявление приносит продажи.
Оптимизация кампании: цель **Website conversions** → событие **Complete Registration** (потом, когда наберётся ~50 покупок в неделю, — **Complete Payment**).

## Админ-бот
📊 Сегодня / 📅 Вчера / 🗓 7 дней / 📈 Всё время — воронка и выручка
🎯 По рекламе — старты и оплаты по кампаниям и объявлениям
⏳ Не оплатили — кто дошёл до бота и не купил
📥 Выгрузка — все лиды в файл для Excel
🔔 Уведомления — вкл/выкл сообщения о каждом лиде (о продажах — всегда)
Вопросы клиентов приходят сюда — ответьте на сообщение, и бот перешлёт ответ клиенту.
