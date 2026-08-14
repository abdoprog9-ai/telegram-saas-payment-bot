import { FastifyInstance } from 'fastify';
import { processTelegramWebhookUpdate } from '../bot/bot-engine.js';
import { getPlatformBot } from '../bot/platform-bot.js';

export async function telegramWebhookRoutes(app: FastifyInstance) {
  // 1. Dynamic Webhook Endpoint for all Merchant Bots (Hundreds of bots through one endpoint)
  app.post<{
    Params: { botId: string };
  }>('/api/v1/telegram/webhook/:botId', async (request, reply) => {
    const { botId } = request.params;
    const secretTokenHeader = request.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    const update = request.body;

    try {
      const result = await processTelegramWebhookUpdate(botId, secretTokenHeader, update, request.log);
      return { ok: true, ...result };
    } catch (err: any) {
      if (err.message === 'UNAUTHORIZED_WEBHOOK_SECRET') {
        reply.status(401);
        return { ok: false, error: 'Unauthorized secret token' };
      }
      request.log.error({ err, botId }, 'Error processing Telegram webhook');
      // Return 200 to Telegram so it does not retry on internal handling bugs
      return { ok: false, error: err?.message || 'Processing error' };
    }
  });

  // 2. Platform Main Bot Webhook Endpoint
  app.post('/api/v1/telegram/platform-webhook', async (request, reply) => {
    const secretTokenHeader = request.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    const platformSecret = process.env.PLATFORM_BOT_SECRET;

    if (platformSecret && secretTokenHeader !== platformSecret) {
      reply.status(401);
      return { ok: false, error: 'Unauthorized platform secret' };
    }

    const platformBot = await getPlatformBot();
    if (!platformBot) {
      return { ok: false, message: 'Platform bot not configured' };
    }

    try {
      await platformBot.handleUpdate(request.body as any);
      return { ok: true };
    } catch (err: any) {
      request.log.error({ err }, 'Error in platform bot update');
      return { ok: false, error: err?.message };
    }
  });
}
