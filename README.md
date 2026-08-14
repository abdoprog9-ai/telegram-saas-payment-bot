# Telegram SaaS Payment & Bot Platform 🚀

منصة SaaS لإدارة متاجر ومدفوعات Telegram، متوافقة مع Telegram Stars والفواتير والأكواد الرقمية، مصممة لمعمارية الـ Multi-Tenant لتعمل بكفاءة عالية على سيرفر VPS (1 vCPU / 2GB RAM).

---

## 🛠️ متطلبات الخادم (VPS Requirements)
- Node.js >= 20
- PM2 (`npm i -g pm2`)
- Git

---

## ⚙️ التثبيت الأول على الـ VPS (Initial Setup)

```bash
# 1. الاستنساخ من GitHub
git clone <YOUR_GITHUB_REPO_URL> /var/www/telegram-saas
cd /var/www/telegram-saas

# 2. إنشاء ملف البيئة وضبط المتغيرات
cp .env.example .env
nano .env

# 3. تثبيت الاعتماديات وبناء المشروع
npm install
npm run build

# 4. إعطاء صلاحيات التشغيل لسكربت النشر
chmod +x deploy.sh

# 5. تشغيل التطبيق عبر PM2 وحفظه
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## 🔄 إعداد التحديث التلقائي (GitHub Auto-Deploy Webhook)

1. في إعدادات مستودعك على GitHub:
   - اذهب إلى **Settings** > **Webhooks** > **Add webhook**.
2. في حقل **Payload URL**:
   `https://api.yourdomain.com/api/v1/system/deploy-webhook`
3. في حقل **Content type**:
   اختر `application/json`
4. في حقل **Secret**:
   ضع نفس القيمة الموجودة في `DEPLOY_WEBHOOK_SECRET` بملف `.env`.
5. اختر حدث **Just the push event**.
6. اضغط **Add webhook**.

الآن بمجرد عمل `git push origin main`، سيقوم GitHub بإرسال إشارة للسيرفر ليقوم بتنفيذ `deploy.sh` وتحديث الكود وإعادة تشغيل التطبيق في ثوانٍ معدودة!
