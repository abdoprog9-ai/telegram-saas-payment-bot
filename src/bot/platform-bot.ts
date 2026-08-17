import { Bot, Context, InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { registerBot } from '../services/bot-service.js';

let platformBotInstance: Bot | null = null;
let isInitializing = false;

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
 * Configures commands, menus, SuperAdmin panel, and token receiver for the Platform Main Bot
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

    // Also support SUPERADMIN_TELEGRAM_IDS env variable
    const adminIds = process.env.SUPERADMIN_TELEGRAM_IDS?.split(',').map((id) => id.trim()) || [];
    return adminIds.includes(String(telegramUserId));
  };

  // 1. Start command
  bot.command(['start', 'admin'], async (ctx: Context) => {
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

    let text = 
      `<b>منصة Telegram SaaS Payments</b>\n\n` +
      `المنصة السحابية المتكاملة لربط بوتات الفواتير والمدفوعات واستقبال نجوم تيليجرام (Telegram Stars) بدون أي تعقيدات.\n\n` +
      `<b>الخيارات المتاحة:</b>\n` +
      `• ربط بوت جديد وإدارته فورياً\n` +
      `• استعراض الخطط والأسعار\n` +
      `• الشروط والسياسة`;

    const keyboard = new InlineKeyboard()
      .text('🤖 ربط / تفعيل بوت جديد', 'platform:link_bot')
      .row()
      .text('💎 الخطط والأسعار', 'platform:plans')
      .text('📜 الشروط والسياسة', 'platform:terms')
      .row()
      .text('💬 الدعم الفني للمنصة', 'platform:support');

    if (isSuperAdmin) {
      keyboard.row().text('👑 لوحة تحكم السوبر أدمن (إدارة المنصة)', 'platform:superadmin_main');
    }

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 2. SuperAdmin Main Panel View
  bot.callbackQuery('platform:superadmin_main', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) {
      await ctx.answerCallbackQuery({ text: 'عذراً، هذه اللوحة مخصصة لإدارة المنصة فقط' }).catch(() => {});
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
      `👑 <b>لوحة تحكم السوبر أدمن | إدارة المنصة</b>\n\n` +
      `<b>مؤشرات المنصة الكلية:</b>\n` +
      `• إجمالي التجار المشتركين: <b>${totalMerchants}</b> تاجر\n` +
      `• إجمالي البوتات المتصلة: <b>${totalBots}</b> بوت نشط\n` +
      `• إجمالي الفواتير الصادرة: <b>${totalInvoices}</b> فاتورة\n` +
      `• إجمالي النجوم المحصلة: <b>${totalRevenueStars} ⭐️ Stars</b>\n\n` +
      `اختر من القائمة أدناه لإدارة المشتركين أو الرصيد:`;

    const keyboard = new InlineKeyboard()
      .text('👥 قائمة المشتركين والتجار', 'platform:superadmin_merchants')
      .row()
      .text('🔄 تحديث الإحصائيات', 'platform:superadmin_main')
      .text('🔙 الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 3. SuperAdmin Merchants & Usage List
  bot.callbackQuery('platform:superadmin_merchants', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const supabase = getSupabase();
    const { data: merchants } = await supabase
      .from('merchants')
      .select('*, users(*), usage(*), telegram_bots(*), subscriptions(*, plans(*))')
      .order('created_at', { ascending: false })
      .limit(8);

    let text = `👥 <b>قائمة المشتركين والتجار (${merchants?.length || 0}):</b>\n\n`;
    const keyboard = new InlineKeyboard();

    if (!merchants || merchants.length === 0) {
      text += `<i>لا يوجد تجار مسجلين حتى الآن.</i>\n`;
    } else {
      for (const m of merchants) {
        const botUser = m.telegram_bots?.[0]?.bot_username ? `@${m.telegram_bots[0].bot_username}` : 'بلا بوت';
        const plan = m.subscriptions?.[0]?.plans?.name || 'Free';
        const used = m.usage?.[0]?.operations_used ?? 0;
        const base = m.usage?.[0]?.base_operations ?? 20;
        const bonus = m.usage?.[0]?.bonus_credits ?? 0;
        const avail = Math.max(0, (base + bonus) - used);

        text += `• <b>${m.business_name || 'تاجر'}</b> (${botUser})\n`;
        text += `  الخطة: <code>${plan}</code> | المتاح: <code>${avail}</code> (المستهلك: <code>${used}</code>)\n`;
        text += `  الحالة: <b>${m.status === 'active' ? '[نشط]' : '[متوقف]'}</b>\n\n`;

        keyboard.text(`⚡ شحن رصيد: ${m.business_name || botUser}`, `platform:add_credits:${m.id}`).row();
      }
    }

    keyboard
      .text('🔙 عودة للوحة السوبر أدمن', 'platform:superadmin_main');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 4. SuperAdmin Add Bonus Credits Handler
  bot.callbackQuery(/^platform:add_credits:(.+)$/, async (ctx: Context) => {
    const fromId = ctx.from?.id;
    if (!fromId || !(await checkIsSuperAdmin(fromId))) return;

    const merchantId = ctx.match?.[1];
    if (!merchantId) return;

    const supabase = getSupabase();
    const { data: usage } = await supabase.from('usage').select('*').eq('merchant_id', merchantId).single();

    const currentBonus = usage?.bonus_credits ?? 0;
    const newBonus = currentBonus + 50;

    await supabase.from('usage').update({ bonus_credits: newBonus, updated_at: new Date().toISOString() }).eq('merchant_id', merchantId);

    await ctx.answerCallbackQuery({ text: `✅ تم شحن +50 عملية إضافية بنجاح! الرصيد الإضافي الآن: ${newBonus}` });

    // Return to merchants list
    const { data: merchants } = await supabase
      .from('merchants')
      .select('*, users(*), usage(*), telegram_bots(*), subscriptions(*, plans(*))')
      .order('created_at', { ascending: false })
      .limit(8);

    let text = `👥 <b>قائمة المشتركين والتجار:</b>\n\n`;
    const keyboard = new InlineKeyboard();

    if (merchants) {
      for (const m of merchants) {
        const botUser = m.telegram_bots?.[0]?.bot_username ? `@${m.telegram_bots[0].bot_username}` : 'بلا بوت';
        const plan = m.subscriptions?.[0]?.plans?.name || 'Free';
        const used = m.usage?.[0]?.operations_used ?? 0;
        const base = m.usage?.[0]?.base_operations ?? 20;
        const bonus = m.usage?.[0]?.bonus_credits ?? 0;
        const avail = Math.max(0, (base + bonus) - used);

        text += `• <b>${m.business_name || 'تاجر'}</b> (${botUser})\n`;
        text += `  الخطة: <code>${plan}</code> | المتاح: <code>${avail}</code> (المستهلك: <code>${used}</code>)\n`;
        text += `  الحالة: <b>${m.status === 'active' ? '[نشط]' : '[متوقف]'}</b>\n\n`;

        keyboard.text(`⚡ شحن رصيد: ${m.business_name || botUser}`, `platform:add_credits:${m.id}`).row();
      }
    }

    keyboard.text('🔙 عودة للوحة السوبر أدمن', 'platform:superadmin_main');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 5. Token Input Handler (Catches Bot Tokens sent in chat directly)
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text?.trim();
    const from = ctx.from;
    const chat = ctx.chat;
    if (!text || !from || !chat) return;

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

        if (!user) throw new Error('تعذر إنشاء أو مطابقة حساب المستخدم في النظام.');

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

        if (!merchant) throw new Error('تعذر إعداد ملف التاجر في قاعدة البيانات.');

        // 3. Register & Encrypt the Bot
        const botRecord = await registerBot({
          merchantId: merchant.id,
          rawToken: text,
        });

        const successText =
          `<b>تم ربط وتفعيل بوتك بنجاح</b>\n\n` +
          `• اسم البوت: <b>${botRecord.botFirstName || botRecord.botUsername}</b>\n` +
          `• يوزر البوت: <b>@${botRecord.botUsername}</b>\n` +
          `• التشفير: <b>AES-256-GCM نشط</b>\n` +
          `• الربط: <b>Webhook فوري ومتصل</b>\n\n` +
          `<b>الخطوة التالية:</b>\n` +
          `ادخل إلى بوتك الآن <b>@${botRecord.botUsername}</b> واضغط على <b>لوحة الإدارة</b> أو <b>/start</b> للبدء فورياً في إنشاء الفواتير ومشاركتها مع عملائك!`;

        const keyboard = new InlineKeyboard()
          .url(`فتح البوت @${botRecord.botUsername}`, `https://t.me/${botRecord.botUsername}?start=admin`)
          .row()
          .text('🔙 القائمة الرئيسية', 'platform:main_menu');

        await ctx.api.deleteMessage(chat.id, waitMsg.message_id).catch(() => {});
        await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (err: any) {
        await ctx.api.deleteMessage(chat.id, waitMsg.message_id).catch(() => {});
        await ctx.reply(`تعذر ربط البوت: ${err?.message || 'تأكد من صحة التوكن من @BotFather وحاول مجدداً.'}`);
      }
    }
  });

  // 6. Main Menu & Navigation Callbacks
  bot.callbackQuery('platform:main_menu', async (ctx: Context) => {
    const from = ctx.from;
    const isSuperAdmin = from ? await checkIsSuperAdmin(from.id) : false;

    const text =
      `<b>منصة Telegram SaaS Payments</b>\n\n` +
      `المنصة السحابية المتكاملة لربط بوتات الفواتير والمدفوعات واستقبال نجوم تيليجرام (Telegram Stars) بكل سهولة وأمان.`;

    const keyboard = new InlineKeyboard()
      .text('🤖 ربط / تفعيل بوت جديد', 'platform:link_bot')
      .row()
      .text('💎 الخطط والأسعار', 'platform:plans')
      .text('📜 الشروط والسياسة', 'platform:terms')
      .row()
      .text('💬 الدعم الفني للمنصة', 'platform:support');

    if (isSuperAdmin) {
      keyboard.row().text('👑 لوحة تحكم السوبر أدمن (إدارة المنصة)', 'platform:superadmin_main');
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery('platform:link_bot', async (ctx: Context) => {
    const text =
      `<b>طريقة ربط وتفعيل بوت فواتير جديد:</b>\n\n` +
      `1. افتح بوت <b>@BotFather</b> وأنشئ بوتاً جديداً عبر الأمر <code>/newbot</code>.\n` +
      `2. انسخ الـ <b>API Token</b> الذي يمنحك إياه BotFather.\n` +
      `3. <b>أرسل التوكن هنا في هذه المحادثة مباشرة!</b>\n\n` +
      `<i>يتم تشفير التوكن فورياً بأعلى معايير الأمان (AES-256-GCM).</i>`;

    const keyboard = new InlineKeyboard()
      .url('فتح @BotFather', 'https://t.me/BotFather')
      .row()
      .text('🔙 الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery('platform:plans', async (ctx: Context) => {
    const text =
      `<b>الخطط والباقات المتاحة:</b>\n\n` +
      `1️⃣ <b>خطة Free Starter (المجانية):</b>\n` +
      `• 20 عملية مجاناً كل دورة تجديد.\n` +
      `• فواتير وروابط دفع غير محدودة.\n` +
      `• دعم كامل لمدفوعات Telegram Stars.\n\n` +
      `2️⃣ <b>خطة Pro Merchant (للمحترفين):</b>\n` +
      `• 1000 عملية مفوترة.\n` +
      `• رصيد إضافي متراكم (لا ينتهي أبداً).\n` +
      `• أولوية في المعالجة الفورية.`;

    const keyboard = new InlineKeyboard()
      .text('🤖 ابدأ بربط بوتك الآن مجاناً', 'platform:link_bot')
      .row()
      .text('🔙 الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery('platform:terms', async (ctx: Context) => {
    const text =
      `<b>شروط الخدمة والسياسة:</b>\n\n` +
      `• تخضع جميع المدفوعات لسياسات شروط خدمة Telegram Stars الرسمية.\n` +
      `• يلتزم التاجر بتقديم خدمات مشروعة تتوافق مع القوانين والأنظمة.\n` +
      `• تضمن المنصة تشفير بيانات الاعتماد وعدم مشاركة أي توكنات مع أطراف خارجية.`;

    const keyboard = new InlineKeyboard().text('🔙 الرئيسية', 'platform:main_menu');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery('platform:support', async (ctx: Context) => {
    const text =
      `<b>الدعم الفني والمساعدة:</b>\n\n` +
      `لأي استفسارات تقنية أو طلب ترقية باقاتك، يمكنك التواصل مع فريق الدعم الفني.`;

    const keyboard = new InlineKeyboard()
      .url('تواصل مع الدعم', 'https://t.me/telegram')
      .row()
      .text('🔙 الرئيسية', 'platform:main_menu');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });
}
