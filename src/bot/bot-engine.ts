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
  renderInvoiceDetail,
  handleDeleteInvoice,
  renderProductDetail,
  handleDeleteProduct,
  startCreateInvoiceWizard,
  startAddProductWizard,
  startRestockProductSelection,
  promptRestockCodes,
  getAdminSession,
  setAdminSession,
  clearAdminSession,
  handleAdminWizardTextInput,
} from './admin-handlers.js';
import { renderCustomerHome, renderCustomerCatalog } from './customer-handlers.js';
import {
  sendTelegramStarsInvoice,
  handlePreCheckoutQuery,
  handleSuccessfulPayment,
} from '../services/payment-service.js';
import { createProductOrder } from '../services/order-service.js';
import { createProduct } from '../services/product-service.js';
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

  // 1. Start Command Handler (Supports Direct Deep Links, e.g. /start inv_<id>)
  bot.command('start', async (ctx: Context) => {
    const matchText = typeof ctx.match === 'string' ? ctx.match : (ctx.match?.[0] || '');
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;
    const botId = (ctx as any).botId;

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
        await ctx.reply('⚠️ <b>عذراً، هذه الفاتورة غير موجودة أو تم إلغاؤها.</b>', { parse_mode: 'HTML' });
        return;
      }

      if (invoice.status === 'paid') {
        await ctx.reply(`✅ <b>هذه الفاتورة (<code>${invoice.invoice_number}</code>) مدفوعة مسبقاً بنجاح.</b>`, { parse_mode: 'HTML' });
        return;
      }

      // Send Invoice Presentation Card
      const cardText =
        `📄 <b>فاتورة مستحقة الدفع:</b>\n\n` +
        `• <b>رقم الفاتورة:</b> <code>${invoice.invoice_number}</code>\n` +
        `• <b>البيان / الخدمة:</b> ${invoice.title}\n` +
        (invoice.description ? `• <b>التفاصيل:</b> ${invoice.description}\n` : '') +
        `• <b>المبلغ المطلوب:</b> <b>${invoice.total_amount} ⭐️ Stars</b>\n\n` +
        `<i>تم إرسال نموذج السداد بنجوم تيليجرام أدناه:</i>`;

      await ctx.reply(cardText, { parse_mode: 'HTML' });

      // Trigger Telegram Stars Checkout Sheet
      try {
        await sendTelegramStarsInvoice(bot.api, chatId, invoice);
      } catch (err: any) {
        await ctx.reply(`⚠️ تعذر إرسال نموذج الدفع: ${err?.message}`);
      }
      return;
    }

    // --- Standard Start Routing ---
    if (isAdmin) {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else {
      await renderCustomerHome(ctx, merchantId, botId, botUsername);
    }
  });

  bot.command('admin', async (ctx: Context) => {
    const isAdmin = (ctx as any).isAdmin;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;

    if (isAdmin) {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else {
      await ctx.reply('⚠️ عذراً، لا تملك صلاحية الوصول إلى لوحة تحكم التاجر.');
    }
  });

  bot.command('cancel', async (ctx: Context) => {
    const fromId = ctx.from?.id;
    const merchantId = (ctx as any).merchantId;
    const botUsername = (ctx as any).botUsername;

    if (fromId) clearAdminSession(fromId);
    if ((ctx as any).isAdmin) {
      await ctx.reply('❌ تم إلغاء العملية الحالية والعودة للرئيسية.');
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
            await ctx.reply(`✅ <b>هذه الفاتورة (<code>${invoice.invoice_number}</code>) مدفوعة مسبقاً بنجاح.</b>`, { parse_mode: 'HTML' });
            return;
          }

          const cardText =
            `📄 <b>فاتورة مستحقة الدفع:</b>\n\n` +
            `• <b>رقم الفاتورة:</b> <code>${invoice.invoice_number}</code>\n` +
            `• <b>البيان / الخدمة:</b> ${invoice.title}\n` +
            (invoice.description ? `• <b>التفاصيل:</b> ${invoice.description}\n` : '') +
            `• <b>المبلغ المطلوب:</b> <b>${invoice.total_amount} ⭐️ Stars</b>\n\n` +
            `<i>تم إرسال نموذج السداد بنجوم تيليجرام أدناه:</i>`;

          await ctx.reply(cardText, { parse_mode: 'HTML' });
          try {
            await sendTelegramStarsInvoice(bot.api, chatId, invoice);
          } catch (err: any) {
            await ctx.reply(`⚠️ تعذر إرسال نموذج الدفع: ${err?.message}`);
          }
          return;
        }
      } else {
        await ctx.reply(`⚠️ لم يتم العثور على فاتورة برقم <code>${text}</code> في هذا المتجر.`, { parse_mode: 'HTML' });
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

    if (data?.startsWith('admin:') && !isAdmin) {
      await ctx.reply('⚠️ عذراً، لا تملك صلاحية الوصول إلى لوحة تحكم التاجر.');
      return;
    }

    // --- Admin Views ---
    if (data === 'admin:main_menu') {
      await renderAdminDashboard(ctx, merchantId, botUsername);
    } else if (data === 'admin:refresh') {
      await renderAdminDashboard(ctx, merchantId, botUsername, true);
    } else if (data === 'admin:subscription') {
      await handleSubscriptionView(ctx, merchantId);
    } else if (data === 'admin:products') {
      await handleProductsView(ctx, merchantId, botId);
    } else if (data?.startsWith('admin:view_prod:')) {
      const prodId = data.replace('admin:view_prod:', '');
      await renderProductDetail(ctx, prodId, merchantId, botUsername);
    } else if (data?.startsWith('admin:del_prod:')) {
      const prodId = data.replace('admin:del_prod:', '');
      await handleDeleteProduct(ctx, prodId, merchantId, botId);
    } else if (data === 'admin:invoices') {
      await handleInvoicesView(ctx, merchantId, botId);
    } else if (data?.startsWith('admin:view_inv:')) {
      const invId = data.replace('admin:view_inv:', '');
      await renderInvoiceDetail(ctx, invId, merchantId, botUsername);
    } else if (data?.startsWith('admin:del_inv:')) {
      const invId = data.replace('admin:del_inv:', '');
      await handleDeleteInvoice(ctx, invId, merchantId, botId);
    } else if (data === 'admin:orders') {
      await handleOrdersView(ctx, merchantId, botId);
    } else if (data === 'admin:settings') {
      await handleSettingsView(ctx, botUsername, botId);
    } else if (data === 'admin:cancel_wizard') {
      if (fromId) clearAdminSession(fromId);
      await renderAdminDashboard(ctx, merchantId, botUsername);
    }

    // --- Admin Wizards ---
    else if (data === 'admin:create_invoice') {
      await startCreateInvoiceWizard(ctx, merchantId, botId, botUsername);
    } else if (data === 'admin:skip_inv_desc') {
      if (fromId) {
        const session = getAdminSession(fromId);
        if (session && session.step === 'invoice_desc') {
          session.data.invoiceDesc = undefined;
          session.step = 'invoice_amount';
          setAdminSession(fromId, session);

          const promptText =
            `📝 <b>إنشاء الفاتورة (الخطوة 3 من 3):</b>\n\n` +
            `أدخل <b>المبلغ المطلوب سداده بالنجوم (⭐️ Stars)</b> (مثال: <code>50</code>):`;
          const kb = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
          await ctx.editMessageText(promptText, { parse_mode: 'HTML', reply_markup: kb });
        }
      }
    } else if (data === 'admin:add_product') {
      await startAddProductWizard(ctx, merchantId, botId, botUsername);
    } else if (data === 'admin:skip_prod_desc') {
      if (fromId) {
        const session = getAdminSession(fromId);
        if (session && session.step === 'prod_desc') {
          session.data.productDesc = undefined;
          session.step = 'prod_price';
          setAdminSession(fromId, session);

          const promptText =
            `📦 <b>إضافة منتج (الخطوة 3 من 4):</b>\n\n` +
            `أدخل <b>سعر المنتج بالنجوم (⭐️ Stars)</b> (مثال: <code>20</code>):`;
          const kb = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
          await ctx.editMessageText(promptText, { parse_mode: 'HTML', reply_markup: kb });
        }
      }
    } else if (data === 'admin:set_prod_type:code') {
      if (fromId) {
        const session = getAdminSession(fromId);
        if (session) {
          session.data.productType = 'code';
          session.step = 'prod_codes';
          setAdminSession(fromId, session);

          const promptText =
            `📥 <b>إدخال مخزون الأكواد الرقمية:</b>\n\n` +
            `أرسل الآن قائمة الأكواد في رسالة نصية (<b>كل كود في سطر مستقل</b>):\n\n` +
            `مثال:\n` +
            `<code>CODE-111-AAA\nCODE-222-BBB\nCODE-333-CCC</code>`;
          const kb = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
          await ctx.editMessageText(promptText, { parse_mode: 'HTML', reply_markup: kb });
        }
      }
    } else if (data === 'admin:set_prod_type:file') {
      if (fromId) {
        const session = getAdminSession(fromId);
        if (session) {
          clearAdminSession(fromId);
          try {
            const product = await createProduct({
              merchantId,
              botId,
              name: session.data.productName || 'منتج رقمي',
              description: session.data.productDesc,
              priceStars: session.data.productPrice || 10,
              productType: 'file',
            });

            const successText =
              `🎉 <b>تمت إضافة المنتج الرقمي بنجاح!</b>\n\n` +
              `• <b>المنتج:</b> ${product.name}\n` +
              `• <b>السعر:</b> <b>${product.price_stars} ⭐️ Stars</b>\n` +
              `• <b>النوع:</b> 📁 ملف / محتوى رقمي\n` +
              `• <b>الحالة:</b> 🟢 معروض الآن في متجر البوت للعملاء!`;

            const kb = new InlineKeyboard()
              .text('📦 إدارة المنتجات', 'admin:products')
              .text('🔙 الرئيسية', 'admin:main_menu');

            await ctx.editMessageText(successText, { parse_mode: 'HTML', reply_markup: kb });
          } catch (err: any) {
            await ctx.reply(`⚠️ تعذر إضافة المنتج: ${err?.message || 'خطأ غير معروف'}`);
          }
        }
      }
    } else if (data === 'admin:import_codes') {
      await startRestockProductSelection(ctx, merchantId, botId);
    } else if (data?.startsWith('admin:restock:')) {
      const targetProdId = data.replace('admin:restock:', '');
      await promptRestockCodes(ctx, targetProdId, merchantId, botId, botUsername);
    }

    // --- Customer Views & Actions ---
    else if (data === 'cust:home') {
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
        try {
          await sendTelegramStarsInvoice(bot.api, chatId, invoice);
        } catch (err: any) {
          await ctx.reply(`⚠️ تعذر إرسال نموذج الدفع: ${err?.message}`);
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
