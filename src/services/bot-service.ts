import { getSupabase } from '../database/supabase.js';
import { encryptToken, decryptToken, generateWebhookSecret, maskToken } from '../security/encryption.js';
import { TelegramBot, BotStatus } from '../types/index.js';

export interface TelegramMeResponse {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
    can_join_groups?: boolean;
    can_read_all_group_messages?: boolean;
    supports_inline_queries?: boolean;
  };
  description?: string;
  error_code?: number;
}

export interface RegisterBotInput {
  merchantId: string;
  rawToken: string;
  appBaseUrl?: string;
}

export interface SanitizedBotResponse {
  id: string;
  merchantId: string;
  telegramBotId: number;
  botUsername: string;
  botFirstName?: string | null;
  maskedToken: string;
  status: BotStatus;
  createdAt: string;
}

/**
 * Validates a Telegram Bot Token by invoking Telegram's getMe API.
 */
export async function verifyTelegramToken(rawToken: string): Promise<{
  id: number;
  username: string;
  firstName: string;
}> {
  if (!rawToken || typeof rawToken !== 'string' || !rawToken.includes(':')) {
    throw new Error('Invalid Telegram bot token format. It must follow 123456:ABC-DEF pattern.');
  }

  const response = await fetch(`https://api.telegram.org/bot${rawToken}/getMe`);
  const data = (await response.json()) as TelegramMeResponse;

  if (!data.ok || !data.result) {
    throw new Error(`Telegram API validation failed: ${data.description || 'Unknown error'}`);
  }

  if (!data.result.is_bot) {
    throw new Error('The provided token does not belong to a Telegram Bot.');
  }

  return {
    id: data.result.id,
    username: data.result.username,
    firstName: data.result.first_name,
  };
}

/**
 * Configures the Telegram webhook with secret token verification.
 */
export async function configureTelegramWebhook(
  rawToken: string,
  webhookUrl: string,
  secretToken: string
): Promise<boolean> {
  const response = await fetch(`https://api.telegram.org/bot${rawToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'shipping_query'],
      drop_pending_updates: false,
    }),
  });

  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Failed to set Telegram webhook: ${data.description || 'Unknown error'}`);
  }

  return true;
}

/**
 * Verifies, encrypts, and registers a new Merchant Telegram Bot.
 */
export async function registerBot(input: RegisterBotInput): Promise<SanitizedBotResponse> {
  const { merchantId, rawToken, appBaseUrl } = input;
  const supabase = getSupabase();

  // 1. Verify token directly with Telegram
  const botInfo = await verifyTelegramToken(rawToken);

  // 2. Prevent duplicate bot registration across multiple accounts
  const { data: existingBot } = await supabase
    .from('telegram_bots')
    .select('id, merchant_id')
    .eq('telegram_bot_id', botInfo.id)
    .single();

  if (existingBot) {
    if (existingBot.merchant_id === merchantId) {
      throw new Error('هذا البوت مربوط مسبقاً بحسابك التجاري.');
    } else {
      throw new Error('هذا البوت مربوط بحساب تاجر آخر بالفعل.');
    }
  }

  // 3. Encrypt Bot Token using AES-256-GCM
  const encrypted = encryptToken(rawToken);
  const webhookSecret = generateWebhookSecret();

  // 4. Save Bot record into database
  const { data: newBot, error: insertError } = await supabase
    .from('telegram_bots')
    .insert({
      merchant_id: merchantId,
      telegram_bot_id: botInfo.id,
      bot_username: botInfo.username,
      bot_first_name: botInfo.firstName,
      encrypted_token: encrypted.encryptedText,
      token_iv: encrypted.iv,
      token_auth_tag: encrypted.authTag,
      webhook_secret: webhookSecret,
      status: 'connected',
    })
    .select()
    .single();

  if (insertError || !newBot) {
    throw new Error(`خطأ في قاعدة البيانات أثناء حفظ البوت: ${insertError?.message || 'Unknown database error'}`);
  }

  // 5. If Base URL is provided, set Webhook and activate bot
  let finalStatus: BotStatus = 'connected';
  if (appBaseUrl) {
    try {
      const formattedBaseUrl = appBaseUrl.startsWith('http://') || appBaseUrl.startsWith('https://')
        ? appBaseUrl
        : `https://${appBaseUrl}`;

      const webhookUrl = `${formattedBaseUrl}/api/v1/telegram/webhook/${newBot.id}`;
      await configureTelegramWebhook(rawToken, webhookUrl, webhookSecret);
      
      await supabase
        .from('telegram_bots')
        .update({ status: 'active' })
        .eq('id', newBot.id);

      finalStatus = 'active';
    } catch (err: any) {
      await supabase
        .from('telegram_bots')
        .update({ status: 'webhook_error', last_error_message: err?.message })
        .eq('id', newBot.id);
      finalStatus = 'webhook_error';
    }
  }

  return {
    id: newBot.id,
    merchantId: newBot.merchant_id,
    telegramBotId: newBot.telegram_bot_id,
    botUsername: newBot.bot_username,
    botFirstName: newBot.bot_first_name,
    maskedToken: maskToken(rawToken),
    status: finalStatus,
    createdAt: newBot.created_at,
  };
}

/**
 * Unlinks / removes a connected Telegram bot and clears its Telegram webhook
 */
export async function unlinkBot(botId: string, merchantId: string): Promise<{ success: boolean; botUsername: string }> {
  const supabase = getSupabase();

  const { data: bot, error } = await supabase
    .from('telegram_bots')
    .select('*')
    .eq('id', botId)
    .eq('merchant_id', merchantId)
    .single();

  if (error || !bot) {
    throw new Error('البوت غير موجود أو لا تملك صلاحية إدارته.');
  }

  // Attempt to delete webhook from Telegram API
  try {
    const rawToken = decryptToken({
      encryptedText: bot.encrypted_token,
      iv: bot.token_iv,
      authTag: bot.token_auth_tag,
    });
    await fetch(`https://api.telegram.org/bot${rawToken}/deleteWebhook`);
  } catch (err: any) {
    console.warn(`[unlinkBot] Warning deleting webhook for @${bot.bot_username}:`, err?.message);
  }

  // Delete bot from database
  await supabase.from('telegram_bots').delete().eq('id', botId);

  return { success: true, botUsername: bot.bot_username };
}

/**
 * Automatically syncs and configures Telegram webhooks for all connected bots in database
 */
export async function syncAllMerchantBotWebhooks(appBaseUrl?: string): Promise<number> {
  const url = appBaseUrl || process.env.APP_BASE_URL;
  if (!url) {
    console.warn('⚠️ [Webhooks] APP_BASE_URL is not configured in .env! Merchant bots will not receive webhook updates.');
    return 0;
  }

  const formattedBaseUrl = url.startsWith('http://') || url.startsWith('https://')
    ? url
    : `https://${url}`;

  const supabase = getSupabase();
  const { data: bots } = await supabase
    .from('telegram_bots')
    .select('*')
    .neq('status', 'disabled');

  if (!bots || bots.length === 0) return 0;

  let count = 0;
  for (const bot of bots) {
    try {
      const rawToken = decryptToken({
        encryptedText: bot.encrypted_token,
        iv: bot.token_iv,
        authTag: bot.token_auth_tag,
      });

      const webhookUrl = `${formattedBaseUrl}/api/v1/telegram/webhook/${bot.id}`;
      await configureTelegramWebhook(rawToken, webhookUrl, bot.webhook_secret);

      if (bot.status !== 'active') {
        await supabase.from('telegram_bots').update({ status: 'active' }).eq('id', bot.id);
      }
      count++;
      console.log(`🤖 [Webhook Engine] Active webhook set for @${bot.bot_username}: ${webhookUrl}`);
    } catch (err: any) {
      console.warn(`⚠️ [Webhook Engine] Failed to configure webhook for @${bot.bot_username}:`, err?.message);
    }
  }

  return count;
}
