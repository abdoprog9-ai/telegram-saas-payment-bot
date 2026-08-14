import { Bot, Context, InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';

let platformBotInstance: Bot | null = null;

/**
 * Initializes or retrieves the Platform Main Bot instance
 */
export function getPlatformBot(): Bot | null {
  const token = process.env.PLATFORM_BOT_TOKEN;
  if (!token || token.includes('placeholder')) {
    return null;
  }

  if (!platformBotInstance) {
    platformBotInstance = new Bot(token);
    setupPlatformBotHandlers(platformBotInstance);
  }

  return platformBotInstance;
}

/**
 * Configures commands and interactive menus for the Platform Main Bot
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

  // 2. Callback queries for Platform Bot
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
        `3. أرسل التوكن هنا أو استخدم لوحة التحكم لربطه فورياً مع متجرك!\n\n` +
        `🔒 <i>التوكن الخاص بك مشفر بالكامل ولن يظهر لأي شخص.</i>`;

      const keyboard = new InlineKeyboard().text('🔙 الرئيسية', 'platform:main_menu');
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else if (data === 'platform:main_menu') {
      const text = 
        `👋 <b>أهلاً بك مجدداً في منصة Telegram SaaS Payments!</b>\n\n` +
        `اختر ما يناسبك من القائمة أدناه:`;

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
