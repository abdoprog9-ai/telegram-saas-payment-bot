import { Bot, Context, InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { registerBot, unlinkBot, getBotWebhookInfo, reconnectBotWebhook } from '../services/bot-service.js';
import { invalidateBotCache } from './bot-engine.js';
import {
  addBonusCredits,
  upgradeMerchantPlan,
  sendPlatformSubscriptionStarsInvoice,
  CREDIT_PACKS,
} from '../services/subscription-service.js';

let platformBotInstance: Bot | null = null;
let isInitializing = false;

// SuperAdmin In-Memory Session
interface PlatformAdminSession {
  action: 'custom_credits' | 'select_plan_manual';
  merchantId: string;
  merchantName: string;
}
const platformSessions = new Map<number, PlatformAdminSession>();

/**
 * Initializes or retrieves the Platform Main Bot instance
 */
export async function getPlatformBot(): Promise<Bot | null> {
  const token = process.env.PLATFORM_BOT_TOKEN;
  if (!token || token.includes('placeholder') || token.length < 10) {
    return null;
  }

  if (platformBotInstance) {
    return platformBotInstance;
  }

  if (isInitializing) {
    while (isInitializing) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return platformBotInstance;
  }

  isInitializing = true;
  try {
    const bot = new Bot(token);
    setupPlatformBotHandlers(bot);
    await bot.init();
    platformBotInstance = bot;
  } catch (err: any) {
    console.error('❌ Failed to initialize Platform Bot:', err?.message);
    return null;
  } finally {
    isInitializing = false;
  }

  return platformBotInstance;
}

/**
 * Resolves the Platform Bot Username dynamically
 */
export async function getPlatformBotUsername(): Promise<string> {
  if (process.env.PLATFORM_BOT_USERNAME && process.env.PLATFORM_BOT_USERNAME.trim().length > 0) {
    return process.env.PLATFORM_BOT_USERNAME.replace('@', '').trim();
  }
  const bot = await getPlatformBot();
  if (bot && bot.botInfo?.username) {
    return bot.botInfo.username;
  }
  return 'PlatformPaymentBot';
}

/**
 * Configures commands, menus, SuperAdmin panel, subscriptions & payments for the Platform Main Bot
 */
function setupPlatformBotHandlers(bot: Bot) {
  // Helper to check if a user is SuperAdmin
  const checkIsSuperAdmin = async (telegramUserId: number): Promise<boolean> => {
    const supabase = getSupabase();
    const { data: user } = await supabase
      .from('users')
      .select('role, is_superadmin')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    if (user?.is_superadmin || user?.role === 'superadmin') {
      return true;
    }

    const adminIds = process.env.SUPERADMIN_TELEGRAM_IDS?.split(',').map((id) => id.trim()) || [];
    return adminIds.includes(String(telegramUserId));
  };

  // Helper to resolve merchant for current user
  const resolveMerchantForUser = async (telegramUserId: number, explicitMerchantId?: string) => {
    const supabase = getSupabase();
    if (explicitMerchantId) {
      const { data: m } = await supabase.from('merchants').select('*').eq('id', explicitMerchantId).single();
      if (m) return m;
    }

    const { data: user } = await supabase.from('users').select('id').eq('telegram_user_id', telegramUserId).maybeSingle();
    if (user) {
      const { data: m } = await supabase.from('merchants').select('*').eq('user_id', user.id).maybeSingle();
      return m;
    }
    return null;
  };

  // 1. Start Command Handler (Supports Deep Links, e.g. /start sub_<merchantId>)
  bot.command(['start', 'admin'], async (ctx: Context) => {
    const matchText = typeof ctx.match === 'string' ? ctx.match : (ctx.match?.[0] || '');
    const from = ctx.from;
    if (!from) return;

    const supabase = getSupabase();
    const isSuperAdmin = await checkIsSuperAdmin(from.id);

    // Upsert platform user record
    await supabase.from('users').upsert({
      telegram_user_id: from.id,
      role: isSuperAdmin ? 'superadmin' : 'merchant',
      is_superadmin: isSuperAdmin,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'telegram_user_id' });

    // Handle deep link for subscription / plans selection
    if (matchText.startsWith('sub_')) {
      const targetMerchantId = matchText.replace('sub_', '').trim();
      await renderPlansAndPackagesMenu(ctx, from.id, targetMerchantId);
      return;
    }

    // Fetch live platform-wide KPIs
    let paidCount = 0;
    let totalStars = 0;
    let activeBotsCount = 0;

    try {
      const [paymentsRes, botsRes] = await Promise.all([
        supabase.from('payments').select('amount', { count: 'exact' }).eq('status', 'successful'),
        supabase.from('telegram_bots').select('id', { count: 'exact' }).eq('status', 'active'),
      ]);
      paidCount = paymentsRes.count || 0;
      totalStars = paymentsRes.data?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      activeBotsCount = botsRes.count || 0;
    } catch {}

    const text =
      `<b>ستار باي | StarPay</b>\n\n` +
      `منظومة الفواتير السحابية لإنشاء وإدارة فواتير الدفع واستقبال مدفوعات نجوم تيليجرام (Telegram Stars) بسرعة وأمان.\n\n` +
      `<b>إحصائيات المنصة:</b>\n` +
      `• الفواتير المسددة: <b>${paidCount.toLocaleString('ar-EG')}</b> فاتورة\n` +
      `• الإيرادات المحصلة: <b>${totalStars.toLocaleString('ar-EG')} Stars</b>\n` +
      `• البوتات النشطة: <b>${activeBotsCount.toLocaleString('ar-EG')}</b> بوت\n\n` +
      `اختر من القائمة أدناه:`;

    const keyboard = new InlineKeyboard()
      .text('بوتاتي المربوطة', 'platform:my_bots')
      .text('الاشتراكات وشحن الرصيد', 'platform:plans');

    if (isSuperAdmin) {
      keyboard.row().text('لوحة إدارة المنصة (SuperAdmin)', 'platform:superadmin_main');
    }

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 2. Pre-checkout query handler for Platform Bot (Stars Payments for Plans & Credits)
  bot.on('pre_checkout_query', async (ctx: Context) => {
    if (ctx.preCheckoutQuery) {
      await ctx.answerPreCheckoutQuery(true).catch(() => {});
    }
  });

  // 3. Successful Payment Handler for Plans & Credit Packs
  bot.on(':successful_payment', async (ctx: Context) => {
    const payment = ctx.message?.successful_payment;
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    if (!payment || !chatId || !fromId) return;

    try {
      const payload = JSON.parse(payment.invoice_payload);
      const { t: type, m: merchantId, c: code } = payload;
      const supabase = getSupabase();

      if (type === 'plan') {
        const sub = await upgradeMerchantPlan(merchantId, code);
        const { data: plan } = await supabase.from('plans').select('*').eq('code', code).single();

        const successText =
          `<b>تم تفعيل الاشتراك بنجاح</b>\n\n` +
          `• الخطة: <b>${plan?.name || code}</b>\n` +
          `• العمليات المضافة: <b>+${plan?.included_operations} عملية</b>\n` +
          `• الصلاحية: <b>30 يوماً</b> (حتى <code>${new Date(sub.expires_at || Date.now()).toLocaleDateString('ar-EG')}</code>)\n` +
          `• المبلغ المسدد: <b>${payment.total_amount} Stars</b>\n\n` +
          `تم تحديث رصيد الحساب والبوتات فورياً.`;

        const kb = new InlineKeyboard().text('الرئيسية', 'platform:main_menu');
        await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
      } else if (type === 'credit_pack') {
        const pack = CREDIT_PACKS[code];
        const credits = pack?.credits || 50;
        const usage = await addBonusCredits(merchantId, credits);

        const successText =
          `<b>تم شحن الرصيد الإضافي بنجاح</b>\n\n` +
          `• الباقة: <b>${pack?.name || 'شحن رصيد'}</b>\n` +
          `• العمليات المضافة: <b>+${credits} عملية إضافية</b>\n` +
          `• إجمالي الرصيد الإضافي الآن: <b>${usage.bonus_credits} عملية</b> (دائمة لا تنتهي)\n` +
          `• المبلغ المسدد: <b>${payment.total_amount} Stars</b>\n\n` +
          `تمت إضافة الرصيد إلى حسابك ويمكنك متابعة إصدار الفواتير.`;

        const kb = new InlineKeyboard().text('الرئيسية', 'platform:main_menu');
        await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err: any) {
      await ctx.reply(`حدث خطأ أثناء معالجة الترقية: ${err?.message}`);
    }
  });

  // 4. Text Message Handler (SuperAdmin Custom Top-up Input or Token Receiver)
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text?.trim();
    const from = ctx.from;
    const chat = ctx.chat;
    if (!text || !from || !chat) return;

    // Check if SuperAdmin is in a custom credit input session
    const adminSession = platformSessions.get(from.id);
    if (adminSession && (await checkIsSuperAdmin(from.id))) {
      if (adminSession.action === 'custom_credits') {
        const amount = parseInt(text, 10);
        if (isNaN(amount) || amount <= 0) {
          await ctx.reply('يرجى إدخال رقم صحيح وموجب لعدد العمليات (مثال: 150 أو 500):');
          return;
        }

        platformSessions.delete(from.id);
        const updated = await addBonusCredits(adminSession.merchantId, amount);

        await ctx.reply(
          `<b>تم شحن الرصيد المخصص بنجاح</b>\n\n` +
          `• التاجر: <b>${adminSession.merchantName}</b>\n` +
          `• الرصيد المضاف: <b>+${amount} عملية</b>\n` +
          `• إجمالي الرصيد الإضافي للتاجر: <b>${updated.bonus_credits} عملية</b>`,
          { parse_mode: 'HTML' }
        );
        return;
      }
    }

    // Telegram Bot Token Format Regex: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
    const tokenRegex = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;

    if (tokenRegex.test(text)) {
      const waitMsg = await ctx.reply('<i>جاري التحقق من رمز البوت وتشفيره وتفعيل الـ Webhook...</i>', {
        parse_mode: 'HTML',
      });

      const supabase = getSupabase();

      try {
        // 1. Get or Create User
        let { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('telegram_user_id', from.id)
          .maybeSingle();

        if (!user) {
          const { data: newUser } = await supabase
            .from('users')
            .insert({
              telegram_user_id: from.id,
              role: 'merchant',
            })
            .select('id')
            .single();
          user = newUser;
        }

        if (!user) throw new Error('تعذر إنشاء حساب المستخدم.');

        // 2. Get or Create Merchant
        let { data: merchant } = await supabase
          .from('merchants')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        if (!merchant) {
          const { data: newMerchant } = await supabase
            .from('merchants')
            .insert({
              user_id: user.id,
              business_name: from.first_name ? `متجر ${from.first_name}` : 'متجري الرقمي',
              status: 'active',
            })
            .select('id')
            .single();
          merchant = newMerchant;
        }

        if (!merchant) throw new Error('تعذر إعداد ملف التاجر.');

        // 3. Register & Encrypt the Bot
        const botRecord = await registerBot({
          merchantId: merchant.id,
          rawToken: text,
        });

        const successText =
          `<b>تم ربط وتفعيل البوت بنجاح</b>\n\n` +
          `• اسم البوت: <b>${botRecord.botFirstName || botRecord.botUsername}</b>\n` +
          `• معرف البوت: <b>@${botRecord.botUsername}</b>\n` +
          `• التشفير: <b>AES-256-GCM نشط</b>\n` +
          `• الاتصال: <b>Webhook فوري ومتصل</b>\n\n` +
          `<b>الخطوة التالية:</b>\n` +
          `ادخل إلى بوتك الآن <b>@${botRecord.botUsername}</b> واضغط على <b>/start</b> للبدء في إنشاء الفواتير وإدارتها.`;

        const keyboard = new InlineKeyboard()
          .url(`فتح البوت @${botRecord.botUsername}`, `https://t.me/${botRecord.botUsername}?start=admin`)
          .row()
          .text('الرئيسية', 'platform:main_menu');

        await ctx.api.deleteMessage(chat.id, waitMsg.message_id).catch(() => {});
        await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (err: any) {
        await ctx.api.deleteMessage(chat.id, waitMsg.message_id).catch(() => {});
        const errKb = new InlineKeyboard()
          .text('استعراض بوتاتي المربوطة', 'platform:my_bots')
          .row()
          .text('الرئيسية', 'platform:main_menu');
        await ctx.reply(`تعذر ربط البوت: ${err?.message || 'تأكد من صحة التوكن من @BotFather وحاول مجدداً.'}`, {
          reply_markup: errKb,
        });
      }
    }
  });

  // 5. Render Plans and Add-on Packages View
  async function renderPlansAndPackagesMenu(ctx: Context, userId: number, explicitMerchantId?: string) {
    const merchant = await resolveMerchantForUser(userId, explicitMerchantId);
    const merchantId = merchant?.id || explicitMerchantId;

    const text =
      `<b>الخطط الشهرية وباقات شحن الرصيد</b>\n\n` +
      `<b>1. الخطط الشهرية المتجددة (صلاحية 30 يوماً):</b>\n` +
      `• <b>الباقة الأساسية ($1.00):</b> <code>100 عملية/شهر</code> (50 Stars)\n` +
      `• <b>الباقة القياسية ($3.00):</b> <code>350 عملية/شهر</code> (150 Stars)\n` +
      `• <b>الباقة المتقدمة ($5.00):</b> <code>600 عملية/شهر</code> (250 Stars)\n\n` +
      `<b>2. باقات شحن العمليات الإضافية (دائمة لا تنتهي):</b>\n` +
      `<i>(لشحن عمليات إضافية فوراً في حال نفاد الرصيد)</i>\n` +
      `• <b>50 عملية إضافية:</b> 25 Stars\n` +
      `• <b>200 عملية إضافية:</b> 90 Stars\n` +
      `• <b>500 عملية إضافية:</b> 200 Stars\n\n` +
      `اختر الباقة المناسبة للدفع الفوري بنجوم تيليجرام:`;

    const keyboard = new InlineKeyboard();

    if (merchantId) {
      keyboard
        .text('باقة 1$ (50 Star) - 100 عملية', `plat:buy_plan:${merchantId}:monthly_1`)
        .row()
        .text('باقة 3$ (150 Star) - 350 عملية', `plat:buy_plan:${merchantId}:monthly_3`)
        .row()
        .text('باقة 5$ (250 Star) - 600 عملية', `plat:buy_plan:${merchantId}:monthly_5`)
        .row()
        .text('شحن 50 عملية (25 Star)', `plat:buy_pack:${merchantId}:pack_50`)
        .text('شحن 200 عملية (90 Star)', `plat:buy_pack:${merchantId}:pack_200`)
        .row()
        .text('شحن 500 عملية (200 Star)', `plat:buy_pack:${merchantId}:pack_500`)
        .row();
    } else {
      keyboard.text('يرجى ربط بوت أولاً لتفعيل الاشتراك', 'platform:link_bot').row();
    }

    keyboard.text('الرئيسية', 'platform:main_menu');

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }

  // 6. Plan Purchase Trigger (Sends Stars Invoice directly to Merchant in Platform Bot)
  bot.callbackQuery(/^plat:buy_plan:(.+):(.+)$/, async (ctx: Context) => {
    const merchantId = ctx.match?.[1];
    const planCode = ctx.match?.[2];
    const chatId = ctx.chat?.id;
    if (!merchantId || !planCode || !chatId) return;

    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await sendPlatformSubscriptionStarsInvoice(bot.api, chatId, merchantId, 'plan', planCode);
    } catch (err: any) {
      await ctx.reply(`تعذر إرسال نموذج الدفع: ${err?.message}`);
    }
  });

  bot.callbackQuery(/^plat:buy_pack:(.+):(.+)$/, async (ctx: Context) => {
    const merchantId = ctx.match?.[1];
    const packCode = ctx.match?.[2];
    const chatId = ctx.chat?.id;
    if (!merchantId || !packCode || !chatId) return;

    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await sendPlatformSubscriptionStarsInvoice(bot.api, chatId, merchantId, 'credit_pack', packCode);
    } catch (err: any) {
      await ctx.reply(`تعذر إرسال نموذج الدفع: ${err?.message}`);
    }
  });

  bot.callbackQuery(/^plat:test_buy_pack:(.+):(.+)$/, async (ctx: Context) => {
    const merchantId = ctx.match?.[1];
    const packCode = ctx.match?.[2];
    if (!merchantId || !packCode) return;

    await ctx.answerCallbackQuery().catch(() => {});
    try {
      const pack = CREDIT_PACKS[packCode];
      const credits = pack?.credits || 50;
      const usage = await addBonusCredits(merchantId, credits);

      const successText =
        `🧪 <b>تم شحن الرصيد الإضافي تجريبياً بنجاح (Sandbox Mode)!</b>\n\n` +
        `• الباقة: <b>${pack?.name || 'شحن رصيد'}</b>\n` +
        `• العمليات المضافة: <b>+${credits} عملية إضافية</b>\n` +
        `• الرصيد الإضافي الكلي الآن: <b>${usage.bonus_credits} عملية</b> (دائمة لا تنتهي)\n` +
        `• وسيلة الدفع: <code>🧪 تجريبي Sandbox (بدون نجوم حقيقية)</code>\n\n` +
        `تم تحديث رصيد متجرك فورياً!`;

      const kb = new InlineKeyboard().text('🔙 الرئيسية', 'platform:main_menu');
      if (ctx.callbackQuery) {
        await ctx.editMessageText(successText, { parse_mode: 'HTML', reply_markup: kb });
      } else {
        await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err: any) {
      await ctx.reply(`⚠️ خطأ في المحاكاة التجريبية: ${err?.message}`);
    }
  });

  // 7. SuperAdmin Main Panel Views
  bot.callbackQuery('platform:superadmin_main', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) {
      await ctx.answerCallbackQuery({ text: 'مخصص لإدارة المنصة فقط' }).catch(() => {});
      return;
    }

    const supabase = getSupabase();
    const [merchantsCountRes, botsCountRes, invoicesCountRes, paymentsRes] = await Promise.all([
      supabase.from('merchants').select('id', { count: 'exact' }),
      supabase.from('telegram_bots').select('id', { count: 'exact' }),
      supabase.from('invoices').select('id', { count: 'exact' }).is('deleted_at', null),
      supabase.from('payments').select('amount').eq('status', 'successful'),
    ]);

    const totalMerchants = merchantsCountRes.count ?? 0;
    const totalBots = botsCountRes.count ?? 0;
    const totalInvoices = invoicesCountRes.count ?? 0;
    const totalRevenueStars = (paymentsRes.data || []).reduce((acc, p) => acc + (p.amount || 0), 0);

    const text =
      `<b>لوحة تحكم إدارة المنصة (SuperAdmin)</b>\n\n` +
      `<b>مؤشرات المنصة الكلية:</b>\n` +
      `• إجمالي التجار المشتركين: <b>${totalMerchants}</b> تاجر\n` +
      `• إجمالي البوتات المتصلة: <b>${totalBots}</b> بوت نشط\n` +
      `• إجمالي الفواتير الصادرة: <b>${totalInvoices}</b> فاتورة\n` +
      `• إجمالي النجوم المحصلة: <b>${totalRevenueStars} Stars</b>\n\n` +
      `اختر من القائمة أدناه لإدارة المشتركين أو الرصيد أو ترقية الخطط:`;

    const keyboard = new InlineKeyboard()
      .text('قائمة المشتركين وإدارة الرصيد', 'platform:superadmin_merchants')
      .row()
      .text('تحديث الإحصائيات', 'platform:superadmin_main')
      .text('الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 8. SuperAdmin Merchants Detail List
  bot.callbackQuery('platform:superadmin_merchants', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const supabase = getSupabase();
    const { data: merchants } = await supabase
      .from('merchants')
      .select('*, users(*), usage(*), telegram_bots(*), subscriptions(*, plans(*))')
      .order('created_at', { ascending: false })
      .limit(8);

    let text = `<b>قائمة المشتركين والتجار (${merchants?.length || 0}):</b>\n\n`;
    const keyboard = new InlineKeyboard();

    if (!merchants || merchants.length === 0) {
      text += `<i>لا يوجد تجار مسجلين حتى الآن.</i>\n`;
    } else {
      for (const m of merchants) {
        const botUser = m.telegram_bots?.[0]?.bot_username ? `@${m.telegram_bots[0].bot_username}` : 'بلا بوت';
        const plan = m.subscriptions?.[0]?.plans?.name || 'Trial Starter';
        const used = m.usage?.[0]?.operations_used ?? 0;
        const base = m.usage?.[0]?.base_operations ?? 10;
        const bonus = m.usage?.[0]?.bonus_credits ?? 0;
        const avail = Math.max(0, (base + bonus) - used);
        const statusBadge = m.status === 'active' ? '[نشط]' : '[متوقف]';
        const suspendActionText = m.status === 'active' ? 'إيقاف مؤقت' : 'إعادة التنشيط';

        text += `• <b>${m.business_name || 'تاجر'}</b> (${botUser}) ${statusBadge}\n`;
        text += `  الخطة: <code>${plan}</code> | المتاح: <code>${avail}</code> (المستهلك: <code>${used}</code>)\n`;
        text += `  الرصيد الإضافي: <code>${bonus}</code>\n\n`;

        keyboard
          .text(`شحن رصيد`, `plat:adm_cred_menu:${m.id}`)
          .text(`باقة`, `plat:adm_plan_menu:${m.id}`)
          .text(`${suspendActionText}`, `plat:adm_toggle_suspend:${m.id}`)
          .row();
      }
    }

    keyboard.text('عودة للوحة الإدارة', 'platform:superadmin_main');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // Toggle Merchant Suspension (SuperAdmin)
  bot.callbackQuery(/^plat:adm_toggle_suspend:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    if (!merchantId) return;

    const supabase = getSupabase();
    const { data: merchant } = await supabase.from('merchants').select('status, business_name').eq('id', merchantId).single();
    if (!merchant) return;

    const newStatus = merchant.status === 'active' ? 'suspended' : 'active';
    await supabase.from('merchants').update({ status: newStatus }).eq('id', merchantId);

    // Invalidate bot cache so the new status applies immediately
    const { data: bots } = await supabase.from('telegram_bots').select('id').eq('merchant_id', merchantId);
    if (bots) {
      for (const b of bots) {
        invalidateBotCache(b.id);
      }
    }

    const msg = newStatus === 'suspended' ? 'تم إيقاف حساب التاجر مؤقتاً' : 'تمت إعادة تنشيط حساب التاجر بنجاح';
    await ctx.answerCallbackQuery({ text: msg });

    // Refresh merchants list
    const { data: merchants } = await supabase
      .from('merchants')
      .select('*, users(*), usage(*), telegram_bots(*), subscriptions(*, plans(*))')
      .order('created_at', { ascending: false })
      .limit(8);

    let text = `<b>قائمة المشتركين والتجار (${merchants?.length || 0}):</b>\n\n`;
    const keyboard = new InlineKeyboard();

    if (merchants) {
      for (const m of merchants) {
        const botUser = m.telegram_bots?.[0]?.bot_username ? `@${m.telegram_bots[0].bot_username}` : 'بلا بوت';
        const plan = m.subscriptions?.[0]?.plans?.name || 'Trial Starter';
        const used = m.usage?.[0]?.operations_used ?? 0;
        const base = m.usage?.[0]?.base_operations ?? 10;
        const bonus = m.usage?.[0]?.bonus_credits ?? 0;
        const avail = Math.max(0, (base + bonus) - used);
        const statusBadge = m.status === 'active' ? '[نشط]' : '[متوقف]';
        const suspendActionText = m.status === 'active' ? 'إيقاف مؤقت' : 'إعادة التنشيط';

        text += `• <b>${m.business_name || 'تاجر'}</b> (${botUser}) ${statusBadge}\n`;
        text += `  الخطة: <code>${plan}</code> | المتاح: <code>${avail}</code> (المستهلك: <code>${used}</code>)\n`;
        text += `  الرصيد الإضافي: <code>${bonus}</code>\n\n`;

        keyboard
          .text(`شحن رصيد`, `plat:adm_cred_menu:${m.id}`)
          .text(`باقة`, `plat:adm_plan_menu:${m.id}`)
          .text(`${suspendActionText}`, `plat:adm_toggle_suspend:${m.id}`)
          .row();
      }
    }

    keyboard.text('عودة للوحة الإدارة', 'platform:superadmin_main');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  });

  // 9. SuperAdmin Credit Top-up Options (Quick Packs or Custom Input)
  bot.callbackQuery(/^plat:adm_cred_menu:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    if (!merchantId) return;

    const supabase = getSupabase();
    const { data: merchant } = await supabase.from('merchants').select('business_name').eq('id', merchantId).single();
    const name = merchant?.business_name || 'التاجر';

    const text =
      `<b>شحن رصيد عمليات للتاجر: ${name}</b>\n\n` +
      `اختر عدد العمليات المطلوبة أو اضغط على إدخال رقم مخصص:`;

    const keyboard = new InlineKeyboard()
      .text('+50 عملية', `plat:adm_add_fixed:${merchantId}:50`)
      .text('+200 عملية', `plat:adm_add_fixed:${merchantId}:200`)
      .row()
      .text('+500 عملية', `plat:adm_add_fixed:${merchantId}:500`)
      .text('+1000 عملية', `plat:adm_add_fixed:${merchantId}:1000`)
      .row()
      .text('إدخال عدد مخصص من العمليات', `plat:adm_add_custom:${merchantId}`)
      .row()
      .text('قائمة التجار', 'platform:superadmin_merchants');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery(/^plat:adm_add_fixed:(.+):(\d+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    const amount = parseInt(ctx.match?.[2] || '0', 10);
    if (!merchantId || amount <= 0) return;

    const updated = await addBonusCredits(merchantId, amount);
    await ctx.answerCallbackQuery({ text: `تم شحن +${amount} عملية بنجاح! الرصيد الإضافي الآن: ${updated.bonus_credits}` });

    await ctx.editMessageText(`تم بنجاح إيداع <b>+${amount} عملية إضافية</b> لحساب التاجر.\nالرصيد الإضافي الكلي الآن: <b>${updated.bonus_credits}</b>`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('عودة لقائمة المشتركين', 'platform:superadmin_merchants'),
    });
  });

  bot.callbackQuery(/^plat:adm_add_custom:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    if (!merchantId) return;

    const supabase = getSupabase();
    const { data: merchant } = await supabase.from('merchants').select('business_name').eq('id', merchantId).single();
    const name = merchant?.business_name || 'التاجر';

    platformSessions.set(fromId, {
      action: 'custom_credits',
      merchantId,
      merchantName: name,
    });

    const text =
      `<b>إدخال رصيد مخصص للتاجر (${name}):</b>\n\n` +
      `أرسل الآن <b>عدد العمليات المطلوب شحنها</b> في رسالة نصية (مثال: <code>150</code> أو <code>2500</code>):`;

    const keyboard = new InlineKeyboard().text('إلغاء', 'platform:superadmin_merchants');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 10. SuperAdmin Manual Plan Upgrade
  bot.callbackQuery(/^plat:adm_plan_menu:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    if (!merchantId) return;

    const supabase = getSupabase();
    const { data: merchant } = await supabase.from('merchants').select('business_name').eq('id', merchantId).single();
    const name = merchant?.business_name || 'التاجر';

    const text =
      `<b>ترقية / تغيير خطة التاجر يدوياً: ${name}</b>\n\n` +
      `اختر الخطة المطلوبة لتعيينها وتفعيلها لمدة 30 يوماً فورياً:`;

    const keyboard = new InlineKeyboard()
      .text('خطة Basic ($1 / شهر - 100 عملية)', `plat:adm_set_plan:${merchantId}:monthly_1`)
      .row()
      .text('خطة Standard ($3 / شهر - 350 عملية)', `plat:adm_set_plan:${merchantId}:monthly_3`)
      .row()
      .text('خطة Pro ($5 / شهر - 600 عملية)', `plat:adm_set_plan:${merchantId}:monthly_5`)
      .row()
      .text('إعادة إلى خطة Trial (10 عمليات تجريبية)', `plat:adm_set_plan:${merchantId}:trial`)
      .row()
      .text('قائمة التجار', 'platform:superadmin_merchants');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery(/^plat:adm_set_plan:(.+):(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    const planCode = ctx.match?.[2];
    if (!merchantId || !planCode) return;

    const sub = await upgradeMerchantPlan(merchantId, planCode);
    await ctx.answerCallbackQuery({ text: `تم تغيير الخطة بنجاح` });

    await ctx.editMessageText(
      `<b>تم تحديث وترقية خطة التاجر بنجاح</b>\n\n` +
      `• الخطة الجديدة: <code>${planCode}</code>\n` +
      `• تاريخ التجديد القادم: <code>${new Date(sub.expires_at || Date.now()).toLocaleDateString('ar-EG')}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('عودة لقائمة المشتركين', 'platform:superadmin_merchants'),
      }
    );
  });

  // 11. Main Menu Navigation Callbacks
  bot.callbackQuery('platform:plans', async (ctx: Context) => {
    const from = ctx.from;
    if (from) await renderPlansAndPackagesMenu(ctx, from.id);
  });

  bot.callbackQuery('platform:main_menu', async (ctx: Context) => {
    const from = ctx.from;
    const isSuperAdmin = from ? await checkIsSuperAdmin(from.id) : false;

    // Fetch live platform-wide KPIs
    const supabase = getSupabase();
    let paidCount = 0;
    let totalStars = 0;
    let activeBotsCount = 0;

    try {
      const [paymentsRes, botsRes] = await Promise.all([
        supabase.from('payments').select('amount', { count: 'exact' }).eq('status', 'successful'),
        supabase.from('telegram_bots').select('id', { count: 'exact' }).eq('status', 'active'),
      ]);
      paidCount = paymentsRes.count || 0;
      totalStars = paymentsRes.data?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      activeBotsCount = botsRes.count || 0;
    } catch {}

    const text =
      `<b>ستار باي | StarPay</b>\n\n` +
      `منظومة الفواتير السحابية لإنشاء وإدارة فواتير الدفع واستقبال مدفوعات نجوم تيليجرام (Telegram Stars) بسرعة وأمان.\n\n` +
      `<b>إحصائيات المنصة:</b>\n` +
      `• الفواتير المسددة: <b>${paidCount.toLocaleString('ar-EG')}</b> فاتورة\n` +
      `• الإيرادات المحصلة: <b>${totalStars.toLocaleString('ar-EG')} Stars</b>\n` +
      `• البوتات النشطة: <b>${activeBotsCount.toLocaleString('ar-EG')}</b> بوت\n\n` +
      `اختر من القائمة أدناه:`;

    const keyboard = new InlineKeyboard()
      .text('بوتاتي المربوطة', 'platform:my_bots')
      .text('الاشتراكات وشحن الرصيد', 'platform:plans');

    if (isSuperAdmin) {
      keyboard.row().text('لوحة إدارة المنصة (SuperAdmin)', 'platform:superadmin_main');
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 12. Merchant "My Linked Bots" View & Unlinking Actions
  const renderMyBotsView = async (ctx: Context, telegramUserId: number) => {
    const supabase = getSupabase();

    const { data: user } = await supabase.from('users').select('id').eq('telegram_user_id', telegramUserId).maybeSingle();
    const { data: merchant } = user ? await supabase.from('merchants').select('id').eq('user_id', user.id).maybeSingle() : { data: null };

    if (!merchant) {
      const text =
        `<b>قائمة البوتات المربوطة:</b>\n\n` +
        `<i>لا يوجد أي بوت مربوط بحسابك حتى الآن. يمكنك ربط أول بوت لك الآن بكل سهولة.</i>`;
      const kb = new InlineKeyboard()
        .text('ربط بوت جديد', 'platform:link_bot')
        .row()
        .text('الرئيسية', 'platform:main_menu');

      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
      }
      return;
    }

    const { data: bots } = await supabase
      .from('telegram_bots')
      .select('*')
      .eq('merchant_id', merchant.id)
      .order('created_at', { ascending: false });

    if (!bots || bots.length === 0) {
      const text =
        `<b>قائمة البوتات المربوطة:</b>\n\n` +
        `<i>لا يوجد أي بوت مربوط بحسابك حالياً. يمكنك ربط بوت جديد الآن.</i>`;
      const kb = new InlineKeyboard()
        .text('ربط بوت جديد', 'platform:link_bot')
        .row()
        .text('الرئيسية', 'platform:main_menu');

      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
      }
      return;
    }

    let text = `<b>قائمة البوتات المربوطة بحسابك (${bots.length}):</b>\n\n`;
    const keyboard = new InlineKeyboard();

    for (const b of bots) {
      const statusBadge = b.status === 'active' ? '[متصل ونشط]' : b.status === 'connected' ? '[متصل]' : '[معطل]';
      const linkDate = new Date(b.created_at).toLocaleDateString('ar-EG');

      text += `• <b>@${b.bot_username}</b> ${statusBadge}\n`;
      text += `  معرف البوت: <code>${b.telegram_bot_id}</code> | تاريخ الربط: <code>${linkDate}</code>\n\n`;

      keyboard
        .url(`فتح @${b.bot_username}`, `https://t.me/${b.bot_username}`)
        .row();
    }

    keyboard
      .text('ربط بوت جديد', 'platform:link_bot')
      .text('فصل ربط بوت', 'platform:unlink_picker')
      .row()
      .text('الرئيسية', 'platform:main_menu');

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  };

  bot.callbackQuery('platform:my_bots', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId) return;
    await renderMyBotsView(ctx, fromId);
  });

  // 13. Dedicated Unlink Bot Picker Screen
  bot.callbackQuery('platform:unlink_picker', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('id').eq('telegram_user_id', fromId).maybeSingle();
    const { data: merchant } = user ? await supabase.from('merchants').select('id').eq('user_id', user.id).maybeSingle() : { data: null };

    if (!merchant) return;

    const { data: bots } = await supabase
      .from('telegram_bots')
      .select('*')
      .eq('merchant_id', merchant.id)
      .order('created_at', { ascending: false });

    if (!bots || bots.length === 0) {
      await renderMyBotsView(ctx, fromId);
      return;
    }

    const text =
      `<b>فصل وإلغاء ربط بوت:</b>\n\n` +
      `اختر البوت الذي ترغب في فصل ربطه من القائمة أدناه:`;

    const keyboard = new InlineKeyboard();
    for (const b of bots) {
      keyboard.text(`فصل ربط @${b.bot_username}`, `plat:confirm_unlink:${b.id}`).row();
    }
    keyboard.text('عودة لقائمة البوتات', 'platform:my_bots');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 14. Confirm Unlink Screen
  bot.callbackQuery(/^plat:confirm_unlink:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    const botId = ctx.match?.[1];
    if (!fromId || !botId) return;

    const supabase = getSupabase();
    const { data: bot } = await supabase.from('telegram_bots').select('bot_username, telegram_bot_id').eq('id', botId).maybeSingle();

    if (!bot) {
      await ctx.answerCallbackQuery({ text: 'البوت غير موجود' });
      await renderMyBotsView(ctx, fromId);
      return;
    }

    const text =
      `<b>تأكيد فصل ربط البوت:</b>\n\n` +
      `هل أنت متأكد من رغبتك في فصل وإلغاء ربط البوت <b>@${bot.bot_username}</b>؟\n\n` +
      `<i>سيتم حذف الـ Webhook الخاص به من خوادم تيليجرام فورياً ولن يستقبل أي فواتير حتى تعيد ربطه.</i>`;

    const keyboard = new InlineKeyboard()
      .text('نعم، تأكيد فصل الربط', `plat:do_unlink:${botId}`)
      .row()
      .text('تراجع وإلغاء', 'platform:my_bots');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 15. Execute Unlink Action
  bot.callbackQuery(/^plat:do_unlink:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    const botId = ctx.match?.[1];
    if (!fromId || !botId) return;

    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('id').eq('telegram_user_id', fromId).maybeSingle();
    const { data: merchant } = user ? await supabase.from('merchants').select('id').eq('user_id', user.id).maybeSingle() : { data: null };

    if (!merchant) return;

    try {
      const res = await unlinkBot(botId, merchant.id);
      invalidateBotCache(botId);
      await ctx.answerCallbackQuery({ text: `تم فصل ربط @${res.botUsername}` });

      const text =
        `<b>تم فصل وإلغاء ربط البوت @${res.botUsername} بنجاح</b>\n\n` +
        `تم حذف الويب هوك الخاص بالبوت وتصفير اتصاله. يمكنك الآن إعادة ربطه بأي حساب آخر أو ربط بوت جديد بحرية.`;

      const keyboard = new InlineKeyboard()
        .text('استعراض بوتاتي', 'platform:my_bots')
        .text('ربط بوت جديد', 'platform:link_bot')
        .row()
        .text('الرئيسية', 'platform:main_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      await ctx.answerCallbackQuery({ text: `تعذر فصل الربط: ${err?.message}` });
      await renderMyBotsView(ctx, fromId);
    }
  });

  bot.callbackQuery('platform:link_bot', async (ctx: Context) => {
    const text =
      `<b>طريقة ربط وتفعيل بوت فواتير جديد:</b>\n\n` +
      `1. افتح بوت <b>@BotFather</b> وأنشئ بوتاً جديداً عبر الأمر <code>/newbot</code>.\n` +
      `2. انسخ رمز الـ <b>API Token</b> الذي يمنحك إياه BotFather.\n` +
      `3. <b>أرسل التوكن هنا في هذه المحادثة مباشرة.</b>\n\n` +
      `<i>يتم تشفير التوكن فورياً بأعلى معايير الأمان (AES-256-GCM).</i>`;

    const keyboard = new InlineKeyboard()
      .url('فتح @BotFather', 'https://t.me/BotFather')
      .row()
      .text('الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery('platform:terms', async (ctx: Context) => {
    const text =
      `<b>شروط الخدمة والسياسة:</b>\n\n` +
      `• تخضع جميع المدفوعات لسياسات شروط خدمة Telegram Stars الرسمية.\n` +
      `• يلتزم التاجر بتقديم خدمات مشروعة تتوافق مع القوانين والأنظمة.\n` +
      `• تضمن المنصة تشفير بيانات الاعتماد وعدم مشاركة أي توكنات مع أطراف خارجية.`;

    const keyboard = new InlineKeyboard().text('الرئيسية', 'platform:main_menu');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery('platform:support', async (ctx: Context) => {
    const text =
      `<b>الدعم الفني والمساعدة:</b>\n\n` +
      `لأي استفسارات تقنية أو طلب ترقية باقاتك، يمكنك التواصل مع فريق الدعم الفني.`;

    const keyboard = new InlineKeyboard()
      .url('تواصل مع الدعم', 'https://t.me/telegram')
      .row()
      .text('الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });
}
