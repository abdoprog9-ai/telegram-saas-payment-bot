import { Bot, Context, InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { decryptToken } from '../security/encryption.js';
import {
  renderAdminDashboard,
  handleSubscriptionView,
  handleProductsView,
  handleInvoicesView,
  handleOrdersView,
  handleSettingsView,
} from './admin-handlers.js';
import { renderCustomerHome, renderCustomerCatalog } from './customer-handlers.js';
import {
  sendTelegramStarsInvoice,
  handlePreCheckoutQuery,
  handleSuccessfulPayment,
} from '../services/payment-service.js';
import { createProductOrder } from '../services/order-service.js';
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

  // Fetch bot along with merchant and owner's telegram ID
  const { data: botRecord, error } = await supabase
    .from('telegram_bots')
    .select('*, merchants!inner(user_id, users!inner(telegram_user_id))')
    .eq('id', botId)
    .single();

  if (error || !botRecord) {
    throw new Error(`Bot record not found for id: ${botId}`);
  }

  const decryptedToken = decryptToken({
    encryptedText: botRecord.encrypted_token,
    iv: botRecord.token_iv,
    authTag: botRecord.token_auth_tag,
  });

  const merchantTelegramId = botRecord.merchants?.users?.telegram_user_id ?? null;

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

    return next();
  });

  // 1. Start Command Handler
  bot.command(['start', 'admin'], async (ctx: Context) => {
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;
    const botId = (ctx as any).botId;

    if (isAdmin) {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else {
      await renderCustomerHome(ctx, merchantId, botId, botUsername);
    }
  });

  // 2. Pre-checkout query handler (Telegram Stars verification)
  bot.on('pre_checkout_query', async (ctx: Context) => {
    if (ctx.preCheckoutQuery) {
      await handlePreCheckoutQuery(bot.api, ctx.preCheckoutQuery);
    }
  });

  // 3. Successful payment handler (Telegram Stars fulfillment)
  bot.on(':successful_payment', async (ctx: Context) => {
    const payment = ctx.message?.successful_payment;
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;

    if (payment && chatId && fromId) {
      await handleSuccessfulPayment(bot.api, chatId, fromId, payment as any);
    }
  });

  // 4. Callback Queries Dispatcher
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;
    const botId = (ctx as any).botId;
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;

    await ctx.answerCallbackQuery().catch(() => {});

    if (data?.startsWith('admin:') && !isAdmin) {
      await ctx.reply('⚠️ عذراً، لا تملك صلاحية الوصول إلى لوحة تحكم التاجر.');
      return;
    }

    if (data === 'admin:main_menu') {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else if (data === 'admin:refresh') {
      await renderAdminDashboard(ctx, merchantId, botUsername, true);
    } else if (data === 'admin:subscription') {
      await handleSubscriptionView(ctx, merchantId);
    } else if (data === 'admin:products') {
      await handleProductsView(ctx, merchantId, botId);
    } else if (data === 'admin:invoices') {
      await handleInvoicesView(ctx, merchantId, botId);
    } else if (data === 'admin:orders') {
      await handleOrdersView(ctx, merchantId, botId);
    } else if (data === 'admin:settings') {
      await handleSettingsView(ctx, botUsername, botId);
    } else if (data === 'admin:add_product' || data === 'admin:import_codes') {
      const infoText =
        `💡 <b>إدارة الكتالوج والمخزون:</b>\n\n` +
        `يمكنك إضافة المنتجات واستيراد الأكواد الرقمية عبر الـ API:\n` +
        `• إضافة منتج: <code>POST /api/v1/products</code>\n` +
        `• استيراد أكواد: <code>POST /api/v1/products/:id/codes/import</code>\n\n` +
        `🔒 جميع العمليات تتم بعزل كامل لكل متجر.`;
      const kb = new InlineKeyboard().text('🔙 العودة للمنتجات', 'admin:products');
      await ctx.editMessageText(infoText, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
    } else if (data === 'cust:home') {
      await renderCustomerHome(ctx, merchantId, botId, botUsername);
    } else if (data === 'cust:catalog') {
      await renderCustomerCatalog(ctx, merchantId, botId);
    } else if (data?.startsWith('buy:prod:') && chatId && fromId) {
      const productId = data.replace('buy:prod:', '');
      try {
        const { data: customer } = await supabase
          .from('customers')
          .select('id')
          .eq('merchant_id', merchantId)
          .eq('telegram_user_id', fromId)
          .single();

        if (!customer) {
          await ctx.reply('يرجى إعادة إرسال /start لتحديث بيانات حسابك.');
          return;
        }

        const { order, invoice } = await createProductOrder({
          merchantId,
          botId,
          customerId: customer.id,
          productId,
        });

        await sendTelegramStarsInvoice(bot.api, chatId, invoice, {
          orderId: order.id,
          productId,
        });
      } catch (err: any) {
        if (err?.message?.includes('MERCHANT_QUOTA_EXHAUSTED')) {
          await ctx.reply('⚠️ نعتذر منك، عمليات الشراء والفوترة متوقفة مؤقتاً في المتجر حالياً. يرجى التواصل مع صاحب المتجر.');
        } else {
          await ctx.reply(`⚠️ تعذر بدء الفاتورة: ${err?.message || 'خطأ غير معروف'}`);
        }
      }
    } else if (data?.startsWith('pay:inv:') && chatId) {
      const invoiceId = data.replace('pay:inv:', '');
      const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (invoice) {
        await sendTelegramStarsInvoice(bot.api, chatId, invoice);
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
