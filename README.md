# Telegram File Stream Bot (Cloudflare Worker + MTProto) — بدون سرور و بدون R2

این پروژه یک ربات تلگرام می‌سازد که:
- کاربر هر نوع فایلی بفرستد → ربات لینک دانلود می‌دهد
- لینک دانلود **استریم** است (فایل روی Worker ذخیره نمی‌شود)
- `Range/Resume` و دانلود با Download Manager پشتیبانی می‌شود (parallel-range با چند کانکشن)
- برای فایل‌های بزرگ (تا حدود 2GB) مناسب است چون دانلود از طریق **MTProto (upload.getFile)** انجام می‌شود و محدودیت دانلود 20MB Bot API را ندارد.

> نکته: طبق مستندات Bot API، `getFile` در حالت عمومی «فعلاً» دانلود را تا 20MB محدود می‌کند؛ به همین خاطر این پروژه دانلود را با MTProto انجام می‌دهد.  
> Bot API docs: بخش `getFile` و `File`  citeturn15view3

## چرا CDN Redirect “واقعی” با Bot ممکن نیست؟
در MTProto وقتی `cdn_supported=true` باشد ممکن است پاسخ `upload.fileCdnRedirect` برگردد.
اما متد `upload.getCdnFile` طبق مستندات Telegram **فقط برای user** است (نه bot). citeturn4search0

پس این پروژه:
- ابتدا `cdn_supported=true` می‌زند
- اگر `upload.fileCdnRedirect` آمد، برای bot به صورت خودکار **fallback** می‌کند و دوباره بدون CDN درخواست می‌زند (تا لینک خراب نشود)

اگر روزی خواستی CDN واقعی را هم اضافه کنی:
- باید با حساب user لاگین کنی و مسیر decrypt/hash را طبق الگوریتم رسمی پیاده‌سازی کنی (AES-256-CTR و تغییر IV بر اساس offset/16) citeturn2view0

---

## فایل‌های پروژه
- `src/index.ts` : هندلر Worker + وبهوک + شاردینگ درخواست‌های Range
- `src/streamer-do.ts` : Durable Object برای دانلود MTProto و استریم پاسخ
- `wrangler.toml` : تنظیمات Worker و Durable Object
- `package.json` : وابستگی‌ها

---

## راه‌اندازی 100% بدون نصب روی سیستم (فقط GitHub + Cloudflare)

### 1) ساخت Bot
1. داخل تلگرام به `@BotFather` پیام بده و bot بساز.
2. توکن ربات (`BOT_TOKEN`) را نگه دار.

### 2) گرفتن API ID / API HASH (برای MTProto)
1. برو به `https://my.telegram.org/apps` و یک اپ بساز.
2. `API_ID` و `API_HASH` را بردار. citeturn16view1

### 3) ساخت ریپو GitHub (بدون نصب)
1. در GitHub یک repository جدید بساز
2. محتویات این پروژه را از همین ZIP داخل repo آپلود کن (Add file → Upload files)

### 4) اتصال ریپو به Cloudflare Workers (Git integration)
1. وارد Cloudflare Dashboard شو
2. Workers & Pages → Create application → Workers → **Import from Git**
3. ریپو را انتخاب کن و Deploy

> Cloudflare خودش build و deploy را انجام می‌دهد؛ لازم نیست روی سیستم خودت چیزی نصب کنی.

### 5) ست کردن Secrets/Vars
داخل Cloudflare → Worker → Settings → Variables:
- `BOT_TOKEN` (Secret)
- `TG_WEBHOOK_SECRET` (Secret) یک رشته رندوم (مثلاً 32 کاراکتر)
- `HMAC_SECRET` (Secret) یک رشته رندوم (مثلاً 32 کاراکتر)
- `API_ID` (Secret یا Variable)
- `API_HASH` (Secret)
- (اختیاری) `SHARDS` مثل `16` یا `32` برای performance بهتر parallel-range

### 6) ست کردن Webhook
برای امن کردن webhook، Telegram هدر `X-Telegram-Bot-Api-Secret-Token` را می‌فرستد (اگر در setWebhook مقدار `secret_token` بدهی). citeturn5search0

**روش ساده (بدون ابزار):**  
در مرورگر باز کن:

`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_DOMAIN>/tg/webhook&secret_token=<YOUR_TG_WEBHOOK_SECRET>`

- `<YOUR_WORKER_DOMAIN>` مثلاً `xxx.workers.dev` یا دامنه خودت
- `<YOUR_TG_WEBHOOK_SECRET>` همان مقداری که در Cloudflare گذاشتی

### 7) تست
1. به رباتت یک فایل بفرست (ویدیو، pdf، zip…)
2. ربات لینک می‌دهد
3. لینک را با IDM / aria2 /… دانلود کن (Resume و چند کانکشن فعال می‌شود)

---

## نکات Performance
- `Range` فعال است → Download Manager می‌تواند چند کانکشن همزمان بزند
- برای اینکه parallel-range بهتر پخش شود، درخواست‌ها روی چند Durable Object shard تقسیم می‌شوند (`SHARDS`)

---

## محدودیت‌ها و واقعیت‌ها
- این Worker **فایل را ذخیره نمی‌کند**، فقط واسط است.
- اگر پیام حذف شود یا bot دسترسی‌اش را از دست بدهد، لینک کار نمی‌کند.
- CDN واقعی (download from CDN DC) در حالت bot محدودیت دارد (بالا توضیح داده شد). citeturn4search0

---

## امنیت
- لینک دانلود دارای امضای HMAC است و بعد از 6 ساعت منقضی می‌شود.
- Secretها را حتماً به عنوان **Secret** در Cloudflare ست کن.

