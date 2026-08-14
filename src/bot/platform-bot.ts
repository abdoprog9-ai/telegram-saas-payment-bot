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
 * Configures commands, interactive menus, and token receiver for the Platform Main Bot
 */
function setupPlatformBotHandlers(bot: Bot) {
  // 1. Start command
  bot.command('start', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const supabase = getSupabase();

    // Upsert platform user record
    await supabase.from('users').upsert({
      telegram_user_id: from.id,
      role: 'merchant',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'telegram_user_id' });

    const text = 
      `👋 <b>أهلاً بك في منصة Telegram SaaS Payments!</b>\n\n` +
      `المنصة السحابية المتكاملة لإدارة مبيعاتك ومنتجاتك الرقمية وفواتيرك واستقبال مدفوعات <b>Telegram Stars</b> بكل سهولة وأمان.\n\n` +
      `💡 <b>الخيارات المتاحة:</b>\n` +
      `• استعراض الخطط والأسعار\n` +
      `• شروط الخدمة وسياسة الاستخدام\n` +
      `• ربط بوت جديد وإدارة متاجرك`;

    const keyboard = new InlineKeyboard()
      .text('💎 الخطط والأسعار', 'platform:plans')
      .text('📜 الشروط والسياسة', 'platform:terms')
      .row()
      .text('🤖 فتح / ربط بوت جديد', 'platform:link_bot')
      .row()
      .text('💬 الدعم والمساعدة', 'platform:support');

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // 2. Token Input Handler (Catches Bot Tokens sent in chat directly)
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text?.trim();
    const from = ctx.from;
    const chat = ctx.chat;
    if (!text || !from || !chat) return;

    // Telegram Bot Token Format Regex: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
    const tokenRegex = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;

    if (tokenRegex.test(text)) {
      const waitMsg = await ctx.reply('⏳ <i>جاري التحقق من رمز البوت وتشفيره وتفعيل الـ Webhook...</i>', {
        parse_mode: 'HTML',
      });

      const supabase = getSupabase();

      try {
        // 1. Get or Create User
        let { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('telegram_user_id', from.id)
          .single();

        if (!user) {
          const { data: newUser, error: uErr } = await supabase
            .from('users')
            .insert({ telegram_user_id: from.id, role: 'merchant' })
            .select('id')
            .single();

          if (uErr || !newUser) throw new Error(`فشل إنشاء حساب المستخدم: ${uErr?.message}`);
          user = newUser;
        }

        // 2. Get or Create Merchant Record
        let { data: merchant } = await supabase
          .from('merchants')
          .select('id, status')
          .eq('user_id', user.id)
          .single();

        if (!merchant) {
          const businessName = from.first_name ? `متجر ${from.first_name}` : 'متجري الرقمي';
          const { data: newMerchant, error: mErr } = await supabase
            .from('merchants')
            .insert({
              user_id: user.id,
              business_name: businessName,
              status: 'active',
            })
            .select('id, status')
            .single();

          if (mErr || !newMerchant) throw new Error(`فشل إنشاء ملف التاجر: ${mErr?.message}`);
          merchant = newMerchant;

          // Initialize Usage quota
          await supabase.from('usage').insert({
            merchant_id: merchant.id,
            base_operations: 20,
            bonus_credits: 0,
            operations_used: 0,
          });

          // Attach Free Plan Subscription
          const { data: freePlan } = await supabase.from('plans').select('id').eq('code', 'free').single();
          if (freePlan) {
            await supabase.from('subscriptions').insert({
              merchant_id: merchant.id,
              plan_id: freePlan.id,
              status: 'active',
              starts_at: new Date().toISOString(),
            });
          }
        }

        // 3. Register & Encrypt the Bot
        const appBaseUrl = process.env.APP_BASE_URL;
        const linkedBot = await registerBot({
          merchantId: merchant.id,
          rawToken: text,
          appBaseUrl,
        });

        // 4. Success Message
        let successText =
          `🎉 <b>تم ربط بوتك بنجاح وأمان تام!</b>\n\n` +
          `• <b>اسم البوت:</b> ${linkedBot.botFirstName || linkedBot.botUsername}\n` +
          `• <b>المعرف:</b> @${linkedBot.botUsername}\n` +
          `• <b>الحالة:</b> 🟢 ${linkedBot.status === 'active' ? 'نشط ومتصل بالـ Webhook' : 'متصل'}\n` +
          `• <b>الأمان:</b> 🔒 تم تشفير التوكن عسكرياً بـ <code>AES-256-GCM</code>\n\n` +
          `🚀 <b>ماذا تفعل الآن؟</b>\n` +
          `ادخل إلى بوتك (@${linkedBot.botUsername}) واضغط على <code>/start</code> لتفتح لك <b>لوحة تحكم التاجر</b> فورياً!`;

        const keyboard = new InlineKeyboard()
          .url('🚀 الانتقال إلى لوحة تحكم بوتك', `https://t.me/${linkedBot.botUsername}`)
          .row()
          .text('🔙 القائمة الرئيسية', 'platform:main_menu');

        await ctx.api.deleteMessage(chat.id, waitMsg.message_id).catch(() => {});
        await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (err: any) {
        await ctx.api.deleteMessage(chat.id, waitMsg.message_id).catch(() => {});
        await ctx.reply(`⚠️ <b>تعذر ربط البوت:</b>\n${err?.message || 'تأكد من صحة التوكن وحاول ثانية.'}`, {
          parse_mode: 'HTML',
        });
      }
    } else {
      // User sent text that is not a token
      const helpText =
        `💡 <b>لربط متجرك الجديد:</b>\n\n` +
        `يرجى إرسال <b>API Token</b> الذي حصلت عليه من @BotFather مباشرة في هذه المحادثة.\n\n` +
        `مثال على شكل التوكن:\n<code>123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ</code>`;

      const keyboard = new InlineKeyboard()
        .text('💎 الخطط والأسعار', 'platform:plans')
        .text('🔙 الرئيسية', 'platform:main_menu');

      await ctx.reply(helpText, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });

  // 3. Callback queries for Platform Bot
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    await ctx.answerCallbackQuery().catch(() => {});

    if (data === 'platform:plans') {
      const supabase = getSupabase();
      const { data: plans } = await supabase.from('plans').select('*').eq('is_active', true);

      let text = `💎 <b>الخطط والأسعار المتاحة:</b>\n\n`;
      text += `🟢 <b>الخطة المجانية (FREE):</b>\n`;
      text += `• 20 فاتورة أو طلب (رصيد على مستوى الحساب)\n`;
      text += `• 5 منتجات رقمية مستقلة (مخزون أكواد غير محدود)\n`;
      text += `• بوت تيليجرام واحد\n`;
      text += `• مناسبة جداً للتجربة والانطلاق\n\n`;

      const proPlan = plans?.find(p => p.code === 'pro_monthly');
      const starsPrice = proPlan?.price_stars ?? 50;
      const usdPrice = proPlan?.price_usd ?? 1;

      text += `⭐ <b>الخطة الاحترافية (PRO):</b>\n`;
      text += `• <b>$${usdPrice}/شهرياً</b> أو ما يعادلها بـ <b>${starsPrice} ⭐️ Stars</b>\n`;
      text += `• 100 عملية شهرية + باقات رصيد إضافية تراكمية\n`;
      text += `• حتى 50 منتجاً رقمياً\n`;
      text += `• ربط عدة بوتات ودعم فني مباشر\n\n`;

      const keyboard = new InlineKeyboard()
        .text('🤖 ربط بوتك الآن', 'platform:link_bot')
        .row()
        .text('🔙 الرئيسية', 'platform:main_menu');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else if (data === 'platform:terms') {
      const text = 
        `📜 <b>الشروط والأحكام وسياسة الاستخدام:</b>\n\n` +
        `1. الالتزام بسياسات وقوانين Telegram وسياسات بيع المحتوى الرقمي.\n` +
        `2. يتم تشفير رموز البوتات (Bot Tokens) عسكرياً بـ AES-256-GCM لحمايتها.\n` +
        `3. يحظر استخدام الخدمة في أي أنشطة احتيالية أو غير مصرح بها.\n` +
        `4. المدفوعات الرقمية تتم بالكامل عبر البنية التحتية الأصلية لـ Telegram Stars.`;

      const keyboard = new InlineKeyboard().text('🔙 الرئيسية', 'platform:main_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else if (data === 'platform:link_bot') {
      const text = 
        `🤖 <b>طريقة ربط بوت جديد:</b>\n\n` +
        `1. ادخل إلى بوت <b>@BotFather</b> وأنشئ بوتاً جديداً عبر الأمر <code>/newbot</code>.\n` +
        `2. انسخ الـ API Token الذي يعطيك إياه BotFather.\n` +
        `3. <b>أرسل التوكن هنا في هذه المحادثة مباشرة</b> وسنقوم بربطه وتشفيره لك فورياً!\n\n` +
        `🔒 <i>التوكن الخاص بك مشفر بالكامل ولا يمكن لأي شخص الاطلاع عليه.</i>`;

      const keyboard = new InlineKeyboard().text('🔙 الرئيسية', 'platform:main_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else if (data === 'platform:support') {
      const text =
        `💬 <b>الدعم الفني والمساعدة:</b>\n\n` +
        `إذا واجهتك أي مشكلة أو كان لديك استفسار حول استخدام المنصة، يمكنك التواصل مع فريق الدعم.\n\n` +
        `⚡ منصة سحابية لإدارة المدفوعات الرقمية والـ Stars.`;

      const keyboard = new InlineKeyboard().text('🔙 الرئيسية', 'platform:main_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else if (data === 'platform:main_menu') {
      const text = 
        `👋 <b>أهلاً بك مجدداً في منصة Telegram SaaS Payments!</b>\n\n` +
        `اختر ما يناسبك من القائمة أدناه أو أرسل توكن بوت جديد لربطه:`;

      const keyboard = new InlineKeyboard()
        .text('💎 الخطط والأسعار', 'platform:plans')
        .text('📜 الشروط والسياسة', 'platform:terms')
        .row()
        .text('🤖 فتح / ربط بوت جديد', 'platform:link_bot')
        .row()
        .text('💬 الدعم والمساعدة', 'platform:support');

      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });
}
