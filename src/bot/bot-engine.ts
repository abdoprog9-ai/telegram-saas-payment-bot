import { Bot, Context, InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { decryptToken } from '../security/encryption.js';
import {
  renderAdminDashboard,
  handleSubscriptionView,
  handleInvoicesView,
  handleSettingsView,
  renderExpirySelectionMenu,
  handleAnalyticsView,
  renderInvoiceDetail,
  handleDeleteInvoice,
  startCreateInvoiceWizard,
  getAdminSession,
  setAdminSession,
  clearAdminSession,
  handleAdminWizardTextInput,
} from './admin-handlers.js';
import { renderCustomerHome } from './customer-handlers.js';
import {
  sendTelegramStarsInvoice,
  handlePreCheckoutQuery,
  handleSuccessfulPayment,
  simulateTestPayment,
} from '../services/payment-service.js';
import { updateMerchantSettings, getMerchantSettings } from '../services/settings-service.js';
import { TelegramBot } from '../types/index.js';

interface CachedBot {
  botRecord: TelegramBot;
  decryptedToken: string;
  merchantTelegramId?: number | null;
  botInstance: Bot;
  cachedAt: number;
}

const BOT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache
const botCache = new Map<string, CachedBot>();

/**
 * Registers a mocked or manual bot in cache (useful for testing or dynamic loading)
 */
export function setCachedBot(botId: string, entry: CachedBot) {
  botCache.set(botId, entry);
}

/**
 * Invalidates the cached bot instance
 */
export function invalidateBotCache(botId: string) {
  botCache.delete(botId);
}

/**
 * Loads or returns the cached GrammY bot instance for a given botId
 */
export async function getOrCreateBotInstance(botId: string): Promise<CachedBot> {
  const cached = botCache.get(botId);
  const now = Date.now();

  if (cached && now - cached.cachedAt < BOT_CACHE_TTL_MS) {
    return cached;
  }

  const supabase = getSupabase();

  // 1. Fetch bot record directly
  const { data: botRecord, error: botError } = await supabase
    .from('telegram_bots')
    .select('*')
    .eq('id', botId)
    .single();

  if (botError || !botRecord) {
    throw new Error(`Bot record not found for id: ${botId}: ${botError?.message}`);
  }

  // 2. Fetch merchant and user details safely
  const { data: merchant } = await supabase
    .from('merchants')
    .select('*, users(*)')
    .eq('id', botRecord.merchant_id)
    .maybeSingle();

  const decryptedToken = decryptToken({
    encryptedText: botRecord.encrypted_token,
    iv: botRecord.token_iv,
    authTag: botRecord.token_auth_tag,
  });

  const userObj = (merchant as any)?.users;
  const merchantTelegramId = (Array.isArray(userObj) ? userObj[0]?.telegram_user_id : userObj?.telegram_user_id) ?? null;
  const merchantStatus = merchant?.status ?? 'active';

  // Initialize lightweight GrammY bot instance
  const bot = new Bot(decryptedToken);

  // Setup Routing & Persona Middlewares
  bot.use(async (ctx: Context, next) => {
    const fromId = ctx.from?.id;
    if (!fromId) return next();

    const isAdmin = merchantTelegramId !== null && fromId === merchantTelegramId;
    (ctx as any).isAdmin = isAdmin;
    (ctx as any).merchantId = botRecord.merchant_id;
    (ctx as any).botId = botRecord.id;
    (ctx as any).botUsername = botRecord.bot_username;

    // Check if Bot or Merchant is Suspended
    if (botRecord.status === 'disabled' || merchantStatus === 'suspended') {
      if (isAdmin && ctx.message?.text === '/admin') {
        // Allow admin to open dashboard to see suspension status & link to Platform Bot
      } else {
        await ctx.reply('عذراً، البوت متوقف مؤقتاً.');
        return;
      }
    }

    return next();
  });

  // 1. Start Command Handler (Dual-Mode: Default Customer View with Deep Link Support)
  bot.command('start', async (ctx: Context) => {
    const matchText = typeof ctx.match === 'string' ? ctx.match : (ctx.match?.[0] || '');
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;
    const botId = (ctx as any).botId;

    // --- Direct Admin Shortcut ---
    if (matchText === 'admin' && isAdmin) {
      await renderAdminDashboard(ctx, merchantId, botUsername);
      return;
    }

    // --- Check if user clicked a direct invoice link: /start inv_<invoiceId> ---
    if (matchText.startsWith('inv_') && chatId && fromId) {
      const invoiceId = matchText.replace('inv_', '').trim();
      const supabase = getSupabase();

      // Upsert Customer
      await supabase.from('customers').upsert({
        merchant_id: merchantId,
        telegram_user_id: fromId,
        username: ctx.from?.username,
        first_name: ctx.from?.first_name,
        last_name: ctx.from?.last_name,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'merchant_id,telegram_user_id' });

      // Fetch target invoice
      const { data: invoice } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', invoiceId)
        .eq('merchant_id', merchantId)
        .single();

      if (!invoice || invoice.deleted_at) {
        await ctx.reply('عذراً، هذه الفاتورة غير موجودة أو تم إلغاؤها.');
        return;
      }

      if (invoice.status === 'paid') {
        await ctx.reply(`هذه الفاتورة (<code>${invoice.invoice_number}</code>) مدفوعة مسبقاً بنجاح.`, { parse_mode: 'HTML' });
        return;
      }

      // Send Invoice Presentation Card
      const settings = await getMerchantSettings(merchantId);
      const cardText =
        `<b>فاتورة مستحقة الدفع:</b>\n\n` +
        `• رقم الفاتورة: <code>${invoice.invoice_number}</code>\n` +
        `• البيان: <b>${invoice.title}</b>\n` +
        (invoice.description ? `• التفاصيل: ${invoice.description}\n` : '') +
        `• المبلغ المطلوب: <b>${invoice.total_amount} ⭐️ Stars</b>\n\n` +
        `<i>تم إرسال نموذج السداد بنجوم تيليجرام أدناه:</i>`;

      const cardKb = new InlineKeyboard();
      if (settings.test_mode) {
        cardKb.text('🧪 سداد تجريبي (Sandbox Test Payment)', `cust:test_pay:${invoice.id}`);
      }

      await ctx.reply(cardText, { parse_mode: 'HTML', reply_markup: cardKb.inline_keyboard.length > 0 ? cardKb : undefined });

      // Trigger Telegram Stars Checkout Sheet
      try {
        await sendTelegramStarsInvoice(bot.api, chatId, invoice);
      } catch (err: any) {
        await ctx.reply(`تعذر إرسال نموذج الدفع: ${err?.message}`);
      }
      return;
    }

    // Default: Customer Facing View (with Admin Switch button visible to all, protected for owner)
    await renderCustomerHome(ctx, merchantId, botId, botUsername);
  });

  bot.command('admin', async (ctx: Context) => {
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;

    if (isAdmin) {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else {
      await ctx.reply('عذراً، لا تملك صلاحية الوصول إلى لوحة تحكم التاجر.');
    }
  });

  bot.command('cancel', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;

    if (fromId) clearAdminSession(fromId);
    if ((ctx as any).isAdmin) {
      await ctx.reply('تم إلغاء العملية الحالية والعودة للرئيسية.');
      await renderAdminDashboard(ctx, merchantId, botUsername);
    }
  });

  // 2. Text Message Handler (Dispatches to Admin Wizard or Invoice Number Lookup)
  bot.on('message:text', async (ctx: Context, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text?.trim() || '';
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;

    // Check if user is in an active Admin wizard step
    if (isAdmin && fromId) {
      const session = getAdminSession(fromId);
      if (session) {
        const handled = await handleAdminWizardTextInput(ctx, session);
        if (handled) return;
      }
    }

    // Check if text is an Invoice Number lookup (e.g. INV-B16AED)
    const invoiceNumberPattern = /^INV-[A-Z0-9]{6}$/i;
    if (invoiceNumberPattern.test(text) && merchantId) {
      const supabase = getSupabase();
      const { data: invoice } = await supabase
        .from('invoices')
        .select('*')
        .eq('merchant_id', merchantId)
        .ilike('invoice_number', text)
        .is('deleted_at', null)
        .single();

      if (invoice) {
        if (isAdmin) {
          await renderInvoiceDetail(ctx, invoice.id, merchantId, botUsername);
          return;
        } else if (chatId) {
          if (invoice.status === 'paid') {
            await ctx.reply(`هذه الفاتورة (<code>${invoice.invoice_number}</code>) مدفوعة مسبقاً بنجاح.`, { parse_mode: 'HTML' });
            return;
          }

          const settings = await getMerchantSettings(merchantId);
          const cardText =
            `<b>فاتورة مستحقة الدفع:</b>\n\n` +
            `• رقم الفاتورة: <code>${invoice.invoice_number}</code>\n` +
            `• البيان: <b>${invoice.title}</b>\n` +
            (invoice.description ? `• التفاصيل: ${invoice.description}\n` : '') +
            `• المبلغ المطلوب: <b>${invoice.total_amount} ⭐️ Stars</b>\n\n` +
            `<i>تم إرسال نموذج السداد بنجوم تيليجرام أدناه:</i>`;

          const cardKb = new InlineKeyboard();
          if (settings.test_mode) {
            cardKb.text('🧪 سداد تجريبي (Sandbox Test Payment)', `cust:test_pay:${invoice.id}`);
          }

          await ctx.reply(cardText, { parse_mode: 'HTML', reply_markup: cardKb.inline_keyboard.length > 0 ? cardKb : undefined });
          try {
            await sendTelegramStarsInvoice(bot.api, chatId, invoice);
          } catch (err: any) {
            await ctx.reply(`تعذر إرسال نموذج الدفع: ${err?.message}`);
          }
          return;
        }
      } else {
        await ctx.reply(`لم يتم العثور على فاتورة برقم <code>${text}</code> في هذا المتجر.`, { parse_mode: 'HTML' });
        return;
      }
    }

    return next();
  });

  // 3. Pre-checkout query handler (Telegram Stars verification)
  bot.on('pre_checkout_query', async (ctx: Context) => {
    if (ctx.preCheckoutQuery) {
      await handlePreCheckoutQuery(bot.api, ctx.preCheckoutQuery);
    }
  });

  // 4. Successful payment handler (Telegram Stars fulfillment)
  bot.on(':successful_payment', async (ctx: Context) => {
    const payment = ctx.message?.successful_payment;
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;

    if (payment && chatId && fromId) {
      await handleSuccessfulPayment(bot.api, chatId, fromId, payment as any);
    }
  });

  // 5. Callback Queries Dispatcher
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;
    const botId = (ctx as any).botId;
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;

    await ctx.answerCallbackQuery().catch(() => {});

    // Permission Guard for all admin routes
    if (data?.startsWith('admin:') && !isAdmin) {
      await ctx.answerCallbackQuery({ text: '⚠️ عذراً، هذا القسم مخصص لمالك البوت فقط.' }).catch(() => {});
      return;
    }

    // --- Admin Views & Actions ---
    if (data === 'admin:main_menu') {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else if (data === 'admin:refresh') {
      await renderAdminDashboard(ctx, merchantId, botUsername, true);
    } else if (data === 'admin:subscription') {
      await handleSubscriptionView(ctx, merchantId);
    } else if (data === 'admin:invoices') {
      await handleInvoicesView(ctx, merchantId, botId);
    } else if (data?.startsWith('admin:view_inv:')) {
      const invId = data.replace('admin:view_inv:', '');
      await renderInvoiceDetail(ctx, invId, merchantId, botUsername);
    } else if (data?.startsWith('admin:del_inv:')) {
      const invId = data.replace('admin:del_inv:', '');
      await handleDeleteInvoice(ctx, invId, merchantId, botId);
    } else if (data === 'admin:create_invoice') {
      await startCreateInvoiceWizard(ctx, merchantId, botId, botUsername);
    } else if (data === 'admin:analytics') {
      await handleAnalyticsView(ctx, merchantId);
    } else if (data === 'admin:settings') {
      await handleSettingsView(ctx, merchantId, botUsername, botId);
    } else if (data === 'admin:cancel_wizard') {
      if (fromId) clearAdminSession(fromId);
      await renderAdminDashboard(ctx, merchantId, botUsername);
    }

    // --- Settings Configuration Handlers ---
    else if (data === 'admin:set:biz_name' && fromId) {
      setAdminSession(fromId, {
        step: 'set_biz_name',
        data: { merchantId, botId, botUsername },
      });
      const prompt = `أرسل الآن <b>اسم النشاط أو المتجر الجديد</b> الذي ترغب في ظهوره لعملائك:`;
      const kb = new InlineKeyboard().text('إلغاء', 'admin:settings');
      await ctx.editMessageText(prompt, { parse_mode: 'HTML', reply_markup: kb });
    } else if (data === 'admin:set:welcome_msg' && fromId) {
      setAdminSession(fromId, {
        step: 'set_welcome_msg',
        data: { merchantId, botId, botUsername },
      });
      const prompt = `أرسل الآن <b>رسالة الترحيب المخصصة</b> التي ستظهر للعملاء عند فتح البوت:`;
      const kb = new InlineKeyboard().text('إلغاء', 'admin:settings');
      await ctx.editMessageText(prompt, { parse_mode: 'HTML', reply_markup: kb });
    } else if (data === 'admin:set:thankyou_msg' && fromId) {
      setAdminSession(fromId, {
        step: 'set_thankyou_msg',
        data: { merchantId, botId, botUsername },
      });
      const prompt = `أرسل الآن <b>رسالة ما بعد الدفع</b> (تظهر للعميل فور نجاح السداد مع تعليمات استلام الخدمة):`;
      const kb = new InlineKeyboard().text('إلغاء', 'admin:settings');
      await ctx.editMessageText(prompt, { parse_mode: 'HTML', reply_markup: kb });
    } else if (data === 'admin:set:support_user' && fromId) {
      setAdminSession(fromId, {
        step: 'set_support_user',
        data: { merchantId, botId, botUsername },
      });
      const prompt = `أرسل الآن <b>يوزر الدعم الفني</b> (مثال: <code>@SupportUsername</code>):`;
      const kb = new InlineKeyboard().text('إلغاء', 'admin:settings');
      await ctx.editMessageText(prompt, { parse_mode: 'HTML', reply_markup: kb });
    } else if (data === 'admin:set:expiry_menu') {
      await renderExpirySelectionMenu(ctx, merchantId);
    } else if (data?.startsWith('admin:set_exp:')) {
      const hours = parseInt(data.replace('admin:set_exp:', ''), 10) || 0;
      await updateMerchantSettings(merchantId, { invoice_expiry_hours: hours });
      await ctx.answerCallbackQuery({ text: 'تم تحديث مدة الصلاحية بنجاح' });
      await handleSettingsView(ctx, merchantId, botUsername, botId);
    } else if (data === 'admin:set:toggle_notify') {
      const current = await getMerchantSettings(merchantId);
      const newStatus = current.notify_on_payment === false ? true : false;
      await updateMerchantSettings(merchantId, { notify_on_payment: newStatus });
      await ctx.answerCallbackQuery({ text: newStatus ? 'تم تفعيل التنبيهات' : 'تم كتم التنبيهات' });
      await handleSettingsView(ctx, merchantId, botUsername, botId);
    } else if (data === 'admin:set:toggle_test_mode') {
      const current = await getMerchantSettings(merchantId);
      const newStatus = current.test_mode === false ? true : false;
      await updateMerchantSettings(merchantId, { test_mode: newStatus });
      await ctx.answerCallbackQuery({ text: newStatus ? 'تم تفعيل وضع الاختبار (Sandbox)' : 'تم تعطيل وضع الاختبار (الإنتاج)' });
      await handleSettingsView(ctx, merchantId, botUsername, botId);
    }

    // --- Customer Views & Actions ---
    else if (data === 'cust:home') {
      await renderCustomerHome(ctx, merchantId, botId, botUsername);
    } else if (data?.startsWith('cust:test_pay:') && chatId && fromId) {
      const invoiceId = data.replace('cust:test_pay:', '');
      try {
        await simulateTestPayment(bot.api, chatId, fromId, invoiceId);
      } catch (err: any) {
        await ctx.reply(`⚠️ تعذر إتمام السداد التجريبي: ${err?.message}`);
      }
    } else if (data?.startsWith('pay:inv:') && chatId) {
      const invoiceId = data.replace('pay:inv:', '');
      const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (invoice) {
        try {
          await sendTelegramStarsInvoice(bot.api, chatId, invoice);
        } catch (err: any) {
          await ctx.reply(`تعذر إرسال نموذج الدفع: ${err?.message}`);
        }
      }
    }
  });

  // Initialize bot info for GrammY webhook handling
  await bot.init();

  const entry: CachedBot = {
    botRecord,
    decryptedToken,
    merchantTelegramId,
    botInstance: bot,
    cachedAt: now,
  };

  botCache.set(botId, entry);
  return entry;
}

/**
 * Handles incoming webhook updates from Telegram with secret token verification & idempotency
 */
export async function processTelegramWebhookUpdate(
  botId: string,
  incomingSecretToken: string | undefined,
  update: any,
  logger: any
): Promise<{ processed: boolean; reason?: string }> {
  // Fast Fail: Drop requests without secret token immediately
  if (!incomingSecretToken) {
    logger.warn({ botId }, '🚨 Dropping webhook request: missing secret-token header');
    throw new Error('UNAUTHORIZED_WEBHOOK_SECRET');
  }

  const supabase = getSupabase();

  // 1. Get or create bot instance
  const { botRecord, botInstance } = await getOrCreateBotInstance(botId);

  // 2. Security Check: Validate Secret Token Header
  if (incomingSecretToken !== botRecord.webhook_secret) {
    logger.warn({ botId }, '🚨 Unauthorized webhook invocation: secret_token mismatch');
    throw new Error('UNAUTHORIZED_WEBHOOK_SECRET');
  }

  // 3. Status Guard: If bot is disabled, respond with neutral standard message
  if (botRecord.status === 'disabled') {
    if (update?.message?.chat?.id) {
      try {
        await botInstance.api.sendMessage(update.message.chat.id, 'عذراً، البوت متوقف مؤقتاً.');
      } catch {}
    }
    return { processed: false, reason: 'BOT_DISABLED' };
  }

  // 4. Idempotency Check: Prevent duplicate processing of the same update_id
  const updateId = update?.update_id;
  if (updateId) {
    const { error: insertError } = await supabase.from('webhook_events').insert({
      bot_id: botId,
      update_id: updateId,
      payload: update,
    });

    if (insertError) {
      logger.debug({ botId, updateId }, 'Ignoring duplicate webhook update_id');
      return { processed: true, reason: 'DUPLICATE_IDEMPOTENT_IGNORE' };
    }
  }

  // 5. Dispatch update into GrammY bot
  await botInstance.handleUpdate(update);

  return { processed: true };
}
