import { buildServer } from './server.js';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

/**
 * Automatically sets up Platform Main Bot Webhook with Telegram API on server start
 */
async function setupPlatformBotWebhook(appBaseUrl?: string, botToken?: string, secretToken?: string) {
  if (!appBaseUrl || !botToken || botToken.includes('placeholder') || botToken.length < 10) {
    return;
  }

  try {
    const formattedBaseUrl = appBaseUrl.startsWith('http://') || appBaseUrl.startsWith('https://')
      ? appBaseUrl
      : `https://${appBaseUrl}`;

    const webhookUrl = `${formattedBaseUrl}/api/v1/telegram/platform-webhook`;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken || undefined,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        drop_pending_updates: false,
      }),
    });
    const data = await res.json() as any;
    if (data.ok) {
      console.log(`🤖 [Telegram] Platform Bot Webhook successfully registered: ${webhookUrl}`);
    } else {
      console.warn(`⚠️ [Telegram] Platform Bot setWebhook returned: ${data.description}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [Telegram] Could not auto-register platform bot webhook: ${err.message}`);
  }
}

async function main() {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`🚀 Telegram SaaS Server running on http://${HOST}:${PORT}`);

    // Auto configure Platform Bot Webhook if credentials exist
    await setupPlatformBotWebhook(
      process.env.APP_BASE_URL,
      process.env.PLATFORM_BOT_TOKEN,
      process.env.PLATFORM_BOT_SECRET
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
