import { getSupabase } from '../database/supabase.js';
import { createInvoice } from './invoice-service.js';
import { Order, Invoice, OrderStatus } from '../types/index.js';

export interface CreateProductOrderInput {
  merchantId: string;
  botId: string;
  customerId: string;
  productId: string;
}

/**
 * Initiates an order for a product, generating a linked invoice with single-deduction accounting
 */
export async function createProductOrder(input: CreateProductOrderInput): Promise<{
  order: Order;
  invoice: Invoice;
}> {
  const { merchantId, botId, customerId, productId } = input;
  const supabase = getSupabase();

  // 1. Fetch Product details
  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .eq('merchant_id', merchantId)
    .is('deleted_at', null)
    .single();

  if (prodErr || !product) {
    throw new Error('Product not found or currently unavailable');
  }

  // 2. Check Quota on Merchant Account Level
  const { data: usage } = await supabase
    .from('usage')
    .select('base_operations, bonus_credits, operations_used')
    .eq('merchant_id', merchantId)
    .single();

  if (usage) {
    const available = (usage.base_operations + usage.bonus_credits) - usage.operations_used;
    if (available <= 0) {
      throw new Error('MERCHANT_QUOTA_EXHAUSTED: Store purchase quota exhausted');
    }
  }

  // 3. Create linked Invoice (skipQuotaDeduction = true to prevent double charge)
  const invoice = await createInvoice({
    merchantId,
    botId,
    customerId,
    title: product.name,
    description: product.description || `Purchase of ${product.name}`,
    currency: 'XTR',
    totalAmount: product.price_stars,
    items: [
      {
        productId: product.id,
        title: product.name,
        quantity: 1,
        unitPrice: product.price_stars,
        totalPrice: product.price_stars,
      },
    ],
    skipQuotaDeduction: true,
  });

  // 4. Create Order Record
  const { data: newOrder, error: orderErr } = await supabase
    .from('orders')
    .insert({
      merchant_id: merchantId,
      bot_id: botId,
      customer_id: customerId,
      product_id: productId,
      invoice_id: invoice.id,
      amount: product.price_stars,
      status: 'pending',
    })
    .select()
    .single();

  if (orderErr || !newOrder) {
    throw new Error(`Failed to create order: ${orderErr?.message || 'Database error'}`);
  }

  // 5. Deduct 1 operation from merchant quota for the entire purchase transaction
  await supabase.rpc('deduct_merchant_operation', { p_merchant_id: merchantId });

  return {
    order: newOrder,
    invoice,
  };
}

/**
 * Retrieves orders for a merchant
 */
export async function getMerchantOrders(
  merchantId: string,
  botId?: string,
  status?: OrderStatus,
  limit: number = 20,
  offset: number = 0
): Promise<{ orders: Order[]; total: number }> {
  const supabase = getSupabase();

  let query = supabase
    .from('orders')
    .select('*, products(name), customers(first_name, username), invoices(invoice_number, status)', { count: 'exact' })
    .eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (botId) {
    query = query.eq('bot_id', botId);
  }

  if (status) {
    query = query.eq('status', status);
  }

  const { data, count, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch orders: ${error.message}`);
  }

  return {
    orders: data || [],
    total: count ?? 0,
  };
}
