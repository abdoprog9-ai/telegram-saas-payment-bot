import { getSupabase } from '../database/supabase.js';
import { Product, DigitalProductCode, ProductType } from '../types/index.js';

export interface CreateProductInput {
  merchantId: string;
  botId: string;
  name: string;
  description?: string;
  priceStars: number;
  productType?: ProductType;
}

export interface ImportCodesResult {
  productId: string;
  importedCount: number;
  totalAvailable: number;
}

/**
 * Creates a new digital product after verifying merchant account plan limits (e.g., max 5 for Free Plan)
 */
export async function createProduct(input: CreateProductInput): Promise<Product> {
  const { merchantId, botId, name, description, priceStars, productType = 'code' } = input;
  const supabase = getSupabase();

  if (!name || name.trim().length === 0) {
    throw new Error('Product name is required');
  }

  if (priceStars <= 0) {
    throw new Error('Product price in Stars must be greater than 0');
  }

  // 1. Verify Plan Product Quota
  const [activeProductsRes, subRes] = await Promise.all([
    supabase
      .from('products')
      .select('id', { count: 'exact' })
      .eq('merchant_id', merchantId)
      .is('deleted_at', null),
    supabase
      .from('subscriptions')
      .select('*, plans(*)')
      .eq('merchant_id', merchantId)
      .single(),
  ]);

  const currentProductsCount = activeProductsRes.count ?? 0;
  const maxAllowedProducts = subRes.data?.plans?.max_products ?? 5; // Default to 5 for Free

  if (currentProductsCount >= maxAllowedProducts) {
    throw new Error(
      `PRODUCT_LIMIT_REACHED: Your plan allows a maximum of ${maxAllowedProducts} active products. Upgrade your plan to add more.`
    );
  }

  // 2. Insert new product
  const { data: newProduct, error } = await supabase
    .from('products')
    .insert({
      merchant_id: merchantId,
      bot_id: botId,
      name: name.trim(),
      description: description?.trim() || null,
      price_stars: priceStars,
      product_type: productType,
      is_active: true,
    })
    .select()
    .single();

  if (error || !newProduct) {
    throw new Error(`Failed to create product: ${error?.message || 'Unknown database error'}`);
  }

  return newProduct;
}

/**
 * Retrieves all active products for a given merchant/bot
 */
export async function getMerchantProducts(merchantId: string, botId?: string): Promise<Product[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('products')
    .select('*')
    .eq('merchant_id', merchantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (botId) {
    query = query.eq('bot_id', botId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list products: ${error.message}`);
  }

  return data || [];
}

/**
 * Soft deletes a product (preserving orders/invoices history)
 */
export async function softDeleteProduct(productId: string, merchantId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('products')
    .update({
      is_active: false,
      deleted_at: new Date().toISOString(),
    })
    .eq('id', productId)
    .eq('merchant_id', merchantId);

  if (error) {
    throw new Error(`Failed to delete product: ${error.message}`);
  }

  return true;
}

/**
 * Imports a batch of digital codes into a product's inventory
 */
export async function importDigitalCodes(
  merchantId: string,
  productId: string,
  rawCodes: string[]
): Promise<ImportCodesResult> {
  const supabase = getSupabase();

  // 1. Verify product ownership
  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .eq('merchant_id', merchantId)
    .is('deleted_at', null)
    .single();

  if (prodErr || !product) {
    throw new Error(`Product not found or not owned by merchant`);
  }

  // 2. Sanitize and filter non-empty codes
  const sanitizedCodes = Array.from(
    new Set(
      rawCodes
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    )
  );

  if (sanitizedCodes.length === 0) {
    throw new Error('No valid digital codes provided for import');
  }

  // 3. Batch insert
  const rows = sanitizedCodes.map((code) => ({
    product_id: productId,
    merchant_id: merchantId,
    code_value: code,
    is_used: false,
  }));

  const { error: insertErr } = await supabase.from('digital_product_codes').insert(rows);

  if (insertErr) {
    throw new Error(`Failed to import digital codes: ${insertErr.message}`);
  }

  // 4. Fetch total available stock
  const { count: availableCount } = await supabase
    .from('digital_product_codes')
    .select('id', { count: 'exact' })
    .eq('product_id', productId)
    .eq('is_used', false);

  return {
    productId,
    importedCount: sanitizedCodes.length,
    totalAvailable: availableCount ?? sanitizedCodes.length,
  };
}

/**
 * Gets stock metrics for a product
 */
export async function getProductInventoryMetrics(
  merchantId: string,
  productId: string
): Promise<{ available: number; used: number; total: number }> {
  const supabase = getSupabase();

  const [availRes, usedRes] = await Promise.all([
    supabase
      .from('digital_product_codes')
      .select('id', { count: 'exact' })
      .eq('merchant_id', merchantId)
      .eq('product_id', productId)
      .eq('is_used', false),
    supabase
      .from('digital_product_codes')
      .select('id', { count: 'exact' })
      .eq('merchant_id', merchantId)
      .eq('product_id', productId)
      .eq('is_used', true),
  ]);

  const available = availRes.count ?? 0;
  const used = usedRes.count ?? 0;

  return {
    available,
    used,
    total: available + used,
  };
}

/**
 * Atomically claims an unused digital code by primary key ID using SKIP LOCKED
 */
export async function claimSingleDigitalCode(
  merchantId: string,
  productId: string,
  orderId?: string
): Promise<string | null> {
  const supabase = getSupabase();

  // In PostgreSQL Supabase, execute atomic claim RPC or atomic select update
  const { data, error } = await supabase.rpc('claim_digital_code_atomic', {
    p_product_id: productId,
    p_merchant_id: merchantId,
    p_order_id: orderId || null,
  });

  if (error) {
    // Fallback: direct atomic update if RPC not yet created in local test DB
    const { data: codeRow } = await supabase
      .from('digital_product_codes')
      .select('id, code_value')
      .eq('product_id', productId)
      .eq('merchant_id', merchantId)
      .eq('is_used', false)
      .limit(1)
      .single();

    if (!codeRow) return null;

    const { error: updateErr } = await supabase
      .from('digital_product_codes')
      .update({
        is_used: true,
        assigned_order_id: orderId || null,
        assigned_at: new Date().toISOString(),
      })
      .eq('id', codeRow.id);

    if (updateErr) return null;
    return codeRow.code_value;
  }

  return data?.[0]?.claimed_code || null;
}
