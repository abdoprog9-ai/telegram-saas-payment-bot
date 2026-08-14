import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import dotenv from 'dotenv';
import { z } from 'zod';
import { registerBot, verifyTelegramToken } from './services/bot-service.js';
import { maskToken } from './security/encryption.js';
import { deployWebhookRoutes } from './routes/deploy-webhook.js';
import { telegramWebhookRoutes } from './routes/telegram-webhook.js';
import { productRoutes } from './routes/product-routes.js';

dotenv.config();

const registerBotSchema = z.object({
  merchantId: z.string().uuid({ message: 'merchantId must be a valid UUID' }),
  token: z.string().min(10, { message: 'Telegram Bot Token is required' }),
});

export async function buildServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(sensible);

  // 1. Register GitHub Auto-Deployment Webhook Route
  await app.register(deployWebhookRoutes);

  // 2. Register Unified Telegram Webhook Routes (Phase 2)
  await app.register(telegramWebhookRoutes);

  // 3. Register Product & Digital Code Routes (Phase 3)
  await app.register(productRoutes);

  // 4. Health Check Endpoint
  app.get('/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: 'telegram-saas-core',
    };
  });

  // 5. Verify Bot Token without linking (Preview endpoint)
  app.post('/api/v1/bots/preview', async (request, reply) => {
    try {
      const body = z.object({ token: z.string().min(10) }).parse(request.body);
      const botInfo = await verifyTelegramToken(body.token);
      return {
        success: true,
        bot: {
          id: botInfo.id,
          username: botInfo.username,
          firstName: botInfo.firstName,
          maskedToken: maskToken(body.token),
        },
      };
    } catch (err: any) {
      reply.status(400);
      return { success: false, error: err?.message || 'Invalid bot token' };
    }
  });

  // 6. Register & Link Bot Endpoint (Phase 1)
  app.post('/api/v1/bots/verify-and-link', async (request, reply) => {
    try {
      const parsed = registerBotSchema.parse(request.body);
      const appBaseUrl = process.env.APP_BASE_URL;

      const registeredBot = await registerBot({
        merchantId: parsed.merchantId,
        rawToken: parsed.token,
        appBaseUrl,
      });

      return {
        success: true,
        message: 'Bot successfully verified, encrypted, and linked.',
        bot: registeredBot,
      };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to register bot' };
    }
  });

  return app;
}
