import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { createInvoice } from '../services/invoice-service.js';
import { createProduct, importDigitalCodes, softDeleteProduct } from '../services/product-service.js';

export interface AdminSession {
  step:
    | 'invoice_title'
    | 'invoice_desc'
    | 'invoice_amount'
    | 'prod_name'
    | 'prod_desc'
    | 'prod_price'
    | 'prod_type'
    | 'prod_codes'
    | 'restock_codes';
  data: {
    merchantId: string;
    botId: string;
    botUsername: string;
    invoiceTitle?: string;
    invoiceDesc?: string;
    invoiceAmount?: number;
    productName?: string;
    productDesc?: string;
    productPrice?: number;
    productType?: 'code' | 'file' | 'content';
    productId?: string;
    productNameRef?: string;
  };
}

// In-Memory Session Store for Admin Wizards
const adminSessions = new Map<number, AdminSession>();

export function getAdminSession(userId: number): AdminSession | undefined {
  return adminSessions.get(userId);
}

export function setAdminSession(userId: number, session: AdminSession) {
  adminSessions.set(userId, session);
}

export function clearAdminSession(userId: number) {
  adminSessions.delete(userId);
}

/**
 * Builds the Main Admin Dashboard Inline Keyboard
 */
export function buildAdminMainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📄 الفواتير', 'admin:invoices')
    .text('📦 المنتجات', 'admin:products')
    .row()
    .text('🛒 الطلبات', 'admin:orders')
    .text('💳 اشتراكي', 'admin:subscription')
    .row()
    .text('⚙️ الإعدادات', 'admin:settings')
    .text('🔄 تحديث', 'admin:refresh');
}

/**
 * Handles the /start or /admin command for Merchant Bot Admin
 */
export async function renderAdminDashboard(ctx: any, merchantId: string, botUsername: string, isRefresh = false) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  // Fetch metrics for dashboard summary
  const [usageRes, subRes, productsRes, ordersRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
    supabase.from('products').select('id', { count: 'exact' }).eq('merchant_id', merchantId).is('deleted_at', null),
    supabase.from('orders').select('id', { count: 'exact' }).eq('merchant_id', merchantId),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const planName = sub?.plans?.name || 'Free Starter';

  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);
  const productsCount = productsRes.count ?? 0;
  const ordersCount = ordersRes.count ?? 0;

  const text =
    `👑 <b>لوحة تحكم التاجر | @${botUsername}</b>\n\n` +
    `📊 <b>ملخص الحساب:</b>\n` +
    `• الخطة الحالية: <b>${planName}</b>\n` +
    `• العمليات المتاحة: <b>${available}</b> (المستهلك: ${used})\n` +
    `• الرصيد الإضافي (Bonus): <b>${bonus}</b>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? '🟢 نشط' : '🔴 متوقف'}</b>\n` +
    `• المنتجات المعروضة: <b>${productsCount}</b>\n` +
    `• إجمالي الطلبات: <b>${ordersCount}</b>\n\n` +
    `اختر من القائمة أدناه لإدارة متجرك وفواتيرك:`;

  const keyboard = buildAdminMainMenu();

  if (isRefresh && ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: '✅ تم تحديث البيانات بنجاح!' }).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:invoices' view - lists invoices with interactive detail buttons
 */
export async function handleInvoicesView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  const { data: invoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(10);

  let text = `📄 <b>إدارة وسجل الفواتير:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!invoices || invoices.length === 0) {
    text += `<i>لا توجد فواتير منشأة حالياً. يمكنك إنشاء فاتورة جديدة فورياً ومشاركتها مع عميلك برابط مباشر لسدادها بالـ Stars!</i>\n\n`;
  } else {
    text += `اضغط على أي فاتورة لعرض تفاصيلها، رابط سدادها، أو إدارتها:\n\n`;
    for (const inv of invoices) {
      const statusIcon = inv.status === 'paid' ? '🟢' : inv.status === 'pending' ? '🟡' : '🔴';
      keyboard.text(`${statusIcon} ${inv.invoice_number} | ${inv.title} (${inv.total_amount}⭐️)`, `admin:view_inv:${inv.id}`).row();
    }
  }

  keyboard
    .text('➕ إنشاء فاتورة جديدة', 'admin:create_invoice')
    .row()
    .text('🔄 تحديث القائمة', 'admin:invoices')
    .text('🔙 الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders full details for a specific invoice with sharing link and action buttons
 */
export async function renderInvoiceDetail(ctx: any, invoiceId: string, merchantId: string, botUsername: string) {
  const supabase = getSupabase();
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('merchant_id', merchantId)
    .single();

  if (!invoice || invoice.deleted_at) {
    const text = `⚠️ <b>عذراً، هذه الفاتورة غير موجودة أو تم حذفها مسبقاً.</b>`;
    const kb = new InlineKeyboard().text('🔙 قائمة الفواتير', 'admin:invoices');
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  const directPayLink = `https://t.me/${botUsername}?start=inv_${invoice.id}`;
  const statusLabel = invoice.status === 'paid' ? '🟢 مسددة بنجاح' : invoice.status === 'pending' ? '🟡 بانتظار السداد' : '🔴 ملغاة';
  const createdDate = new Date(invoice.created_at).toLocaleString('ar-EG');
  const paidDate = invoice.paid_at ? new Date(invoice.paid_at).toLocaleString('ar-EG') : null;

  const text =
    `📄 <b>تفاصيل الفاتورة | ${invoice.invoice_number}</b>\n\n` +
    `• <b>البيان / العنوان:</b> ${invoice.title}\n` +
    (invoice.description ? `• <b>الوصف:</b> ${invoice.description}\n` : '') +
    `• <b>المبلغ المطلوب:</b> <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
    `• <b>الحالة:</b> ${statusLabel}\n` +
    `• <b>تاريخ الإنشاء:</b> <code>${createdDate}</code>\n` +
    (paidDate ? `• <b>تاريخ السداد:</b> <code>${paidDate}</code>\n` : '') +
    `\n🔗 <b>رابط السداد المباشر للعميل:</b>\n<code>${directPayLink}</code>\n\n` +
    `💡 <i>يمكنك نسخ الرابط ومشاركته مع العميل في أي وقت ليسدد الفاتورة فورياً!</i>`;

  const keyboard = new InlineKeyboard()
    .url('🔗 فتح رابط الفاتورة', directPayLink)
    .row();

  if (invoice.status === 'pending') {
    keyboard
      .text('⭐️ تجربة سداد الفاتورة', `pay:inv:${invoice.id}`)
      .text('🗑️ إلغاء الفاتورة', `admin:del_inv:${invoice.id}`)
      .row();
  }

  keyboard
    .text('🔙 قائمة الفواتير', 'admin:invoices')
    .text('🏠 الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles soft deleting / canceling an invoice
 */
export async function handleDeleteInvoice(ctx: any, invoiceId: string, merchantId: string, botId: string) {
  const supabase = getSupabase();
  await supabase
    .from('invoices')
    .update({
      status: 'cancelled',
      deleted_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .eq('merchant_id', merchantId);

  if (ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: '🗑️ تم إلغاء وحذف الفاتورة بنجاح!' }).catch(() => {});
  }

  await handleInvoicesView(ctx, merchantId, botId);
}

/**
 * Starts the Create Invoice Wizard
 */
export async function startCreateInvoiceWizard(ctx: any, merchantId: string, botId: string, botUsername: string) {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  setAdminSession(fromId, {
    step: 'invoice_title',
    data: { merchantId, botId, botUsername },
  });

  const text =
    `📝 <b>إنشاء فاتورة جديدة (الخطوة 1 من 3):</b>\n\n` +
    `أدخل <b>عنوان أو اسم الفاتورة</b> (مثال: تصميم شعار / استشارة تقنية / خدمة رقمية):`;

  const keyboard = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:products' view - lists products with interactive buttons
 */
export async function handleProductsView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  const { data: products } = await supabase
    .from('products')
    .select('*, digital_product_codes(count)')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  let text = `📦 <b>إدارة المنتجات الرقمية والمخزون:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!products || products.length === 0) {
    text += `<i>لا توجد منتجات مضافة في متجرك حالياً. اضغط على زر "إضافة منتج" أدناه لإضافة منتجك الرقمي وتعبئة مخزونه!</i>\n\n`;
  } else {
    text += `اضغط على أي منتج لعرض تفاصيله، تعبئة مخزونه، أو إدارته:\n\n`;
    for (const p of products) {
      const stockCount = p.digital_product_codes?.[0]?.count ?? 0;
      keyboard.text(`📦 ${p.name} (${p.price_stars}⭐️) - مخزون: ${stockCount}`, `admin:view_prod:${p.id}`).row();
    }
  }

  keyboard
    .text('➕ إضافة منتج جديد', 'admin:add_product')
    .text('📥 استيراد وتعبئة أكواد', 'admin:import_codes')
    .row()
    .text('🔄 تحديث القائمة', 'admin:products')
    .text('🔙 الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders detail view for a specific product
 */
export async function renderProductDetail(ctx: any, productId: string, merchantId: string, botUsername: string) {
  const supabase = getSupabase();
  const { data: product } = await supabase
    .from('products')
    .select('*, digital_product_codes(count)')
    .eq('id', productId)
    .eq('merchant_id', merchantId)
    .single();

  if (!product || product.deleted_at) {
    const text = `⚠️ <b>عذراً، هذا المنتج غير موجود أو تم حذفه مسبقاً.</b>`;
    const kb = new InlineKeyboard().text('🔙 قائمة المنتجات', 'admin:products');
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  const stockCount = product.digital_product_codes?.[0]?.count ?? 0;
  const createdDate = new Date(product.created_at).toLocaleString('ar-EG');

  const text =
    `📦 <b>تفاصيل المنتج | ${product.name}</b>\n\n` +
    (product.description ? `• <b>الوصف:</b> ${product.description}\n` : '') +
    `• <b>السعر:</b> <b>${product.price_stars} ⭐️ Stars</b>\n` +
    `• <b>نوع المنتج:</b> <code>${product.product_type === 'code' ? 'أكواد رقمية' : 'ملف / محتوى'}</code>\n` +
    `• <b>المخزون المتوفر:</b> <b>${stockCount}</b> كود نشط\n` +
    `• <b>تاريخ الإضافة:</b> <code>${createdDate}</code>\n\n` +
    `💡 <i>عند قيام العميل بالشراء، يقوم البوت بتسليم كود محجوز ذرياً وتلقائياً.</i>`;

  const keyboard = new InlineKeyboard();

  if (product.product_type === 'code') {
    keyboard.text('📥 تعبئة مخزون أكواد لهذا المنتج', `admin:restock:${product.id}`).row();
  }

  keyboard
    .text('🗑️ حذف المنتج', `admin:del_prod:${product.id}`)
    .row()
    .text('🔙 قائمة المنتجات', 'admin:products')
    .text('🏠 الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles deleting a product
 */
export async function handleDeleteProduct(ctx: any, productId: string, merchantId: string, botId: string) {
  await softDeleteProduct(productId, merchantId);

  if (ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: '🗑️ تم حذف المنتج بنجاح!' }).catch(() => {});
  }

  await handleProductsView(ctx, merchantId, botId);
}

/**
 * Starts the Add Product Wizard
 */
export async function startAddProductWizard(ctx: any, merchantId: string, botId: string, botUsername: string) {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  setAdminSession(fromId, {
    step: 'prod_name',
    data: { merchantId, botId, botUsername },
  });

  const text =
    `📦 <b>إضافة منتج رقمي جديد (الخطوة 1 من 4):</b>\n\n` +
    `أدخل <b>اسم المنتج</b> (مثال: اشتراك نتفلكس 3 أشهر / مفتاح تفعيل ويندوز 11):`;

  const keyboard = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Starts the Select Product for Restock Wizard
 */
export async function startRestockProductSelection(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  const { data: products } = await supabase
    .from('products')
    .select('id, name, price_stars')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .eq('product_type', 'code')
    .is('deleted_at', null);

  if (!products || products.length === 0) {
    const text = `⚠️ <i>ليس لديك منتجات من نوع "أكواد رقمية" لإضافة مخزون لها. يرجى إضافة منتج أولاً.</i>`;
    const kb = new InlineKeyboard()
      .text('➕ إضافة منتج الآن', 'admin:add_product')
      .row()
      .text('🔙 العودة للمنتجات', 'admin:products');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  let text = `📥 <b>اختر المنتج الذي ترغب في تعبئة مخزون أكواد له:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  for (const p of products) {
    keyboard.text(`📦 ${p.name}`, `admin:restock:${p.id}`).row();
  }

  keyboard.text('🔙 العودة للمنتجات', 'admin:products');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/**
 * Prompt to send codes for restocking a specific product
 */
export async function promptRestockCodes(ctx: any, productId: string, merchantId: string, botId: string, botUsername: string) {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  const supabase = getSupabase();
  const { data: product } = await supabase.from('products').select('name').eq('id', productId).single();

  setAdminSession(fromId, {
    step: 'restock_codes',
    data: {
      merchantId,
      botId,
      botUsername,
      productId,
      productNameRef: product?.name || 'المنتج',
    },
  });

  const text =
    `📥 <b>تعبئة مخزون لمنتج: ${product?.name}</b>\n\n` +
    `أرسل الآن قائمة الأكواد في رسالة نصية (<b>كل كود في سطر مستقل</b>):\n\n` +
    `مثال:\n` +
    `<code>CODE-111-AAA\nCODE-222-BBB\nCODE-333-CCC</code>`;

  const keyboard = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/**
 * Handles Text Input for all Admin Wizards (Invoices, Products, and Codes)
 */
export async function handleAdminWizardTextInput(ctx: any, session: AdminSession): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const fromId = ctx.from?.id;
  if (!text || !fromId) return false;

  const { merchantId, botId, botUsername } = session.data;

  // ----------------------------------------------------
  // 1. INVOICE WIZARD
  // ----------------------------------------------------
  if (session.step === 'invoice_title') {
    session.data.invoiceTitle = text;
    session.step = 'invoice_desc';
    setAdminSession(fromId, session);

    const promptText =
      `📝 <b>إنشاء الفاتورة (الخطوة 2 من 3):</b>\n\n` +
      `العنوان: <b>${text}</b>\n\n` +
      `أدخل الآن <b>وصف الفاتورة أو التفاصيل</b> (أو اضغط زر تخطي):`;

    const kb = new InlineKeyboard()
      .text('⏩ تخطي الوصف', 'admin:skip_inv_desc')
      .row()
      .text('❌ إلغاء', 'admin:cancel_wizard');

    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  if (session.step === 'invoice_desc') {
    session.data.invoiceDesc = text;
    session.step = 'invoice_amount';
    setAdminSession(fromId, session);

    const promptText =
      `📝 <b>إنشاء الفاتورة (الخطوة 3 من 3):</b>\n\n` +
      `أدخل <b>المبلغ المطلوب سداده بالنجوم (⭐️ Stars)</b> (أرقام فقط، مثال: <code>50</code>):`;

    const kb = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  if (session.step === 'invoice_amount') {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('⚠️ يرجى إدخال رقم صحيح وموجب للمبلغ (مثال: 25 أو 100):');
      return true;
    }

    session.data.invoiceAmount = amount;
    clearAdminSession(fromId);

    try {
      const invoice = await createInvoice({
        merchantId,
        botId,
        title: session.data.invoiceTitle || 'فاتورة جديدة',
        description: session.data.invoiceDesc || undefined,
        totalAmount: amount,
        currency: 'XTR',
      });

      const directPayLink = `https://t.me/${botUsername}?start=inv_${invoice.id}`;

      const successText =
        `🎉 <b>تم إنشاء الفاتورة بنجاح!</b>\n\n` +
        `• <b>رقم الفاتورة:</b> <code>${invoice.invoice_number}</code>\n` +
        `• <b>العنوان:</b> ${invoice.title}\n` +
        (invoice.description ? `• <b>الوصف:</b> ${invoice.description}\n` : '') +
        `• <b>المبلغ:</b> <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
        `• <b>الحالة:</b> 🟡 بانتظار السداد\n\n` +
        `🔗 <b>رابط السداد المباشر للعميل:</b>\n` +
        `<code>${directPayLink}</code>\n\n` +
        `💡 <i>بمجرد أن يضغط العميل على هذا الرابط في تيليجرام، سيفتح له البوت مباشرة ويطلب منه الدفع بالنجوم في ثانية واحدة!</i>`;

      const kb = new InlineKeyboard()
        .url('🔗 فتح رابط الفاتورة', directPayLink)
        .row()
        .text('⭐️ تجربة سداد الفاتورة بنفسك', `pay:inv:${invoice.id}`)
        .row()
        .text('📄 قائمة الفواتير', 'admin:invoices')
        .text('🔙 الرئيسية', 'admin:main_menu');

      await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
      await ctx.reply(`⚠️ تعذر إنشاء الفاتورة: ${err?.message || 'خطأ غير معروف'}`);
    }
    return true;
  }

  // ----------------------------------------------------
  // 2. PRODUCT WIZARD
  // ----------------------------------------------------
  if (session.step === 'prod_name') {
    session.data.productName = text;
    session.step = 'prod_desc';
    setAdminSession(fromId, session);

    const promptText =
      `📦 <b>إضافة منتج (الخطوة 2 من 4):</b>\n\n` +
      `الاسم: <b>${text}</b>\n\n` +
      `أدخل <b>وصف المنتج أو مميزاته</b> (أو اضغط زر تخطي):`;

    const kb = new InlineKeyboard()
      .text('⏩ تخطي الوصف', 'admin:skip_prod_desc')
      .row()
      .text('❌ إلغاء', 'admin:cancel_wizard');

    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  if (session.step === 'prod_desc') {
    session.data.productDesc = text;
    session.step = 'prod_price';
    setAdminSession(fromId, session);

    const promptText =
      `📦 <b>إضافة منتج (الخطوة 3 من 4):</b>\n\n` +
      `أدخل <b>سعر المنتج بالنجوم (⭐️ Stars)</b> (أرقام فقط، مثال: <code>20</code>):`;

    const kb = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  if (session.step === 'prod_price') {
    const price = parseInt(text, 10);
    if (isNaN(price) || price <= 0) {
      await ctx.reply('⚠️ يرجى إدخال رقم صحيح وموجب لسعر المنتج (مثال: 15 أو 50):');
      return true;
    }

    session.data.productPrice = price;
    session.step = 'prod_type';
    setAdminSession(fromId, session);

    const promptText =
      `📦 <b>إضافة منتج (الخطوة 4 من 4):</b>\n\n` +
      `المنتج: <b>${session.data.productName}</b>\n` +
      `السعر: <b>${price} ⭐️ Stars</b>\n\n` +
      `حدد <b>نوع المنتج</b>:`;

    const kb = new InlineKeyboard()
      .text('📦 أكواد رقمية (كروت/مفاتيح)', 'admin:set_prod_type:code')
      .row()
      .text('📁 ملف / محتوى رقمي', 'admin:set_prod_type:file')
      .row()
      .text('❌ إلغاء', 'admin:cancel_wizard');

    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  if (session.step === 'prod_codes') {
    const codes = text
      .split('\n')
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0);

    if (codes.length === 0) {
      await ctx.reply('⚠️ لم يتم العثور على أكواد صالحة. يرجى إرسال كل كود في سطر مستقل:');
      return true;
    }

    clearAdminSession(fromId);

    try {
      // 1. Create Product
      const product = await createProduct({
        merchantId,
        botId,
        name: session.data.productName || 'منتج رقمي',
        description: session.data.productDesc,
        priceStars: session.data.productPrice || 10,
        productType: 'code',
      });

      // 2. Import Codes
      const importRes = await importDigitalCodes(
        merchantId,
        product.id,
        codes
      );

      const successText =
        `🎉 <b>تمت إضافة المنتج ومخزون الأكواد بنجاح!</b>\n\n` +
        `• <b>المنتج:</b> ${product.name}\n` +
        `• <b>السعر:</b> <b>${product.price_stars} ⭐️ Stars</b>\n` +
        `• <b>المخزون المدخل:</b> <b>${importRes.importedCount}</b> كود نشط\n` +
        `• <b>الحالة:</b> 🟢 معروض الآن في متجر البوت للعملاء!\n\n` +
        `عند قيام أي عميل بالشراء بالنجوم، سيقوم البوت تلقائياً بحجز كود ذرياً وتسليمه له فورياً.`;

      const kb = new InlineKeyboard()
        .text('📦 إدارة المنتجات', 'admin:products')
        .text('🔙 الرئيسية', 'admin:main_menu');

      await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
      await ctx.reply(`⚠️ تعذر إضافة المنتج: ${err?.message || 'خطأ غير معروف'}`);
    }
    return true;
  }

  // ----------------------------------------------------
  // 3. RESTOCK CODES WIZARD
  // ----------------------------------------------------
  if (session.step === 'restock_codes') {
    const codes = text
      .split('\n')
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0);

    if (codes.length === 0) {
      await ctx.reply('⚠️ يرجى إرسال كود واحد على الأقل (كل كود في سطر مستقل):');
      return true;
    }

    const productId = session.data.productId;
    if (!productId) return false;

    clearAdminSession(fromId);

    try {
      const importRes = await importDigitalCodes(
        merchantId,
        productId,
        codes
      );

      const successText =
        `🎉 <b>تمت تعبئة المخزون بنجاح!</b>\n\n` +
        `• <b>المنتج:</b> ${session.data.productNameRef || 'المنتج'}\n` +
        `• <b>الأكواد المضافة:</b> +${importRes.importedCount} كود جديد\n` +
        `• <b>إجمالي المخزون المتوفر الآن:</b> <b>${importRes.totalAvailable}</b> كود`;

      const kb = new InlineKeyboard()
        .text('📦 قائمة المنتجات', 'admin:products')
        .text('🔙 الرئيسية', 'admin:main_menu');

      await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
      await ctx.reply(`⚠️ تعذر استيراد الأكواد: ${err?.message || 'خطأ غير معروف'}`);
    }
    return true;
  }

  return false;
}

/**
 * Handles 'admin:subscription' view
 */
export async function handleSubscriptionView(ctx: any, merchantId: string) {
  const supabase = getSupabase();

  const [usageRes, subRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const plan = sub?.plans;

  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  const resetDate = usage?.cycle_reset_at ? new Date(usage.cycle_reset_at).toLocaleDateString('ar-EG') : 'غير محدد';

  const text =
    `💳 <b>تفاصيل اشتراكي والخطة:</b>\n\n` +
    `• الخطة الحالية: <b>${plan?.name || 'Free Starter'}</b>\n` +
    `• الرصيد الأساسي للدورة: <b>${base}</b> عملية\n` +
    `• الرصيد الإضافي التراكمي (Bonus): <b>${bonus}</b> عملية (لا ينتهي)\n` +
    `• العمليات المستهلكة: <b>${used}</b> عملية\n` +
    `• <b>الرصيد المتبقي المتاح:</b> <code>${available}</code> عملية\n` +
    `• تاريخ التجديد القادم: <b>${resetDate}</b>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? '🟢 نشط' : '🔴 متوقف'}</b>\n\n` +
    `💡 <i>ملاحظة: لشحن رصيد إضافي أو ترقية الباقة، يمكنك استخدام بوت المنصة الأساسي.</i>`;

  const keyboard = new InlineKeyboard()
    .text('🔄 تحديث الرصيد', 'admin:subscription')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:orders' view
 */
export async function handleOrdersView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();

  const { data: orders } = await supabase
    .from('orders')
    .select('*, products(name)')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .order('created_at', { ascending: false })
    .limit(8);

  let text = `🛒 <b>سجل طلبات العملاء:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!orders || orders.length === 0) {
    text += `<i>لا توجد طلبات شراء حتى الآن. ستظهر هنا عمليات الشراء المكتملة عبر Telegram Stars فور حدوثها.</i>\n\n`;
  } else {
    for (const ord of orders) {
      const prodName = ord.products?.name || 'منتج رقمي';
      const statusIcon = ord.status === 'completed' ? '✅ تم التسليم' : ord.status === 'paid' ? '🟢 مدفوع' : '⏳ معلق';
      text += `• <b>طلب: ${prodName}</b>\n`;
      text += `  المبلغ: <b>${ord.amount} ⭐️ Stars</b> | الحالة: ${statusIcon}\n`;
      text += `  التاريخ: <code>${new Date(ord.created_at).toLocaleDateString('ar-EG')}</code>\n\n`;
    }
  }

  keyboard
    .text('🔄 تحديث الطلبات', 'admin:orders')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:settings' view
 */
export async function handleSettingsView(ctx: any, botUsername: string, botId: string) {
  const text =
    `⚙️ <b>إعدادات وحالة البوت:</b>\n\n` +
    `• معرف البوت: <code>@${botUsername}</code>\n` +
    `• معرف النظام (UUID): <code>${botId}</code>\n` +
    `• التشفير: 🔒 <b>AES-256-GCM نشط</b>\n` +
    `• نظام الـ Webhook: 🟢 <b>متصل وفوري</b>\n` +
    `• الدفع بالنجوم: ⭐ <b>مفعل (XTR)</b>\n\n` +
    `💡 <i>جميع البيانات محمية بنظام العزل المتعدد (Multi-Tenant).</i>`;

  const keyboard = new InlineKeyboard().text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
