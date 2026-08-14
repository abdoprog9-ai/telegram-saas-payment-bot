import crypto from 'crypto';
import { getSupabase } from '../database/supabase.js';
import { Invoice, InvoiceStatus } from '../types/index.js';

export interface CreateInvoiceItemInput {
  productId?: string;
  title: string;
  quantity?: number;
  unitPrice: number;
  totalPrice?: number;
}

export interface CreateInvoiceInput {
  merchantId: string;
  botId: string;
  customerId?: string;
  title: string;
  description?: string;
  currency?: string;
  totalAmount: number;
  items?: CreateInvoiceItemInput[];
  expiresAt?: string;
  skipQuotaDeduction?: boolean; // When called from Order creation (Single Deduction Policy)
}

/**
 * Generates a human-friendly unique invoice number (e.g. INV-7A9B2C)
 */
export function generateInvoiceNumber(): string {
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `INV-${randomHex}`;
}

/**
 * Creates a new manual invoice and deducts 1 operation from merchant quota
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const {
    merchantId,
    botId,
    customerId,
    title,
    description,
    currency = 'XTR',
    totalAmount,
    items,
    expiresAt,
    skipQuotaDeduction = false,
  } = input;

  const supabase = getSupabase();

  if (!title || title.trim().length === 0) {
    throw new Error('Invoice title is required');
  }

  if (totalAmount <= 0) {
    throw new Error('Total amount must be greater than 0');
  }

  // 1. Quota Check & Single-Deduction Handling
  if (!skipQuotaDeduction) {
    const { data: usage } = await supabase
      .from('usage')
      .select('base_operations, bonus_credits, operations_used')
      .eq('merchant_id', merchantId)
      .single();

    if (usage) {
      const available = (usage.base_operations + usage.bonus_credits) - usage.operations_used;
      if (available <= 0) {
        throw new Error('MERCHANT_QUOTA_EXHAUSTED: You have 0 available operations. Please upgrade or add bonus credits.');
      }
    }
  }

  const invoiceNumber = generateInvoiceNumber();

  // 2. Insert Invoice
  const { data: newInvoice, error: invError } = await supabase
    .from('invoices')
    .insert({
      merchant_id: merchantId,
      bot_id: botId,
      customer_id: customerId || null,
      invoice_number: invoiceNumber,
      title: title.trim(),
      description: description?.trim() || null,
      currency,
      total_amount: totalAmount,
      status: 'pending',
      expires_at: expiresAt || null,
    })
    .select()
    .single();

  if (invError || !newInvoice) {
    throw new Error(`Failed to create invoice: ${invError?.message || 'Database error'}`);
  }

  // 3. Insert Invoice Items if provided
  if (items && items.length > 0) {
    const itemRows = items.map((item) => ({
      invoice_id: newInvoice.id,
      product_id: item.productId || null,
      title: item.title.trim(),
      quantity: item.quantity ?? 1,
      unit_price: item.unitPrice,
      total_price: item.totalPrice ?? (item.unitPrice * (item.quantity ?? 1)),
    }));

    await supabase.from('invoice_items').insert(itemRows);
  }

  // 4. Deduct 1 operation from merchant account quota
  if (!skipQuotaDeduction) {
    await supabase.rpc('deduct_merchant_operation', { p_merchant_id: merchantId });
  }

  return newInvoice;
}

/**
 * Retrieves invoices for a merchant with soft-delete filter
 */
export async function getMerchantInvoices(
  merchantId: string,
  botId?: string,
  status?: InvoiceStatus,
  limit: number = 20,
  offset: number = 0
): Promise<{ invoices: Invoice[]; total: number }> {
  const supabase = getSupabase();

  let query = supabase
    .from('invoices')
    .select('*, customers(first_name, username)', { count: 'exact' })
    .eq('merchant_id', merchantId)
    .is('deleted_at', null)
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
    throw new Error(`Failed to fetch invoices: ${error.message}`);
  }

  return {
    invoices: data || [],
    total: count ?? 0,
  };
}

/**
 * Soft deletes or cancels an invoice
 */
export async function softDeleteInvoice(invoiceId: string, merchantId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('invoices')
    .update({
      status: 'cancelled',
      deleted_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .eq('merchant_id', merchantId);

  if (error) {
    throw new Error(`Failed to cancel invoice: ${error.message}`);
  }

  return true;
}

/**
 * Looks up a single invoice by its public human invoice number (e.g. INV-7A9B2C)
 */
export async function getInvoiceByNumber(invoiceNumber: string): Promise<Invoice | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('invoices')
    .select('*, invoice_items(*)')
    .eq('invoice_number', invoiceNumber)
    .is('deleted_at', null)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}
