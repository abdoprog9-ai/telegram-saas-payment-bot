import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getMerchantUsageSummary,
  addBonusCredits,
  upgradeMerchantPlan,
} from '../services/subscription-service.js';

const upgradeSchema = z.object({
  merchantId: z.string().uuid(),
  planCode: z.string().min(1),
});

const creditsSchema = z.object({
  merchantId: z.string().uuid(),
  credits: z.number().int().positive({ message: 'Credits must be a positive integer' }),
});

export async function subscriptionRoutes(app: FastifyInstance) {
  // 1. Get Usage & Quota Summary
  app.get<{
    Querystring: { merchantId: string };
  }>('/api/v1/subscriptions/usage', async (request, reply) => {
    const { merchantId } = request.query;
    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    try {
      const summary = await getMerchantUsageSummary(merchantId);
      return { success: true, ...summary };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });

  // 2. Upgrade Subscription Plan
  app.post('/api/v1/subscriptions/upgrade', async (request, reply) => {
    try {
      const body = upgradeSchema.parse(request.body);
      const subscription = await upgradeMerchantPlan(body.merchantId, body.planCode);
      return { success: true, subscription };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to upgrade plan' };
    }
  });

  // 3. Add Top-up Bonus Credits
  app.post('/api/v1/subscriptions/credits', async (request, reply) => {
    try {
      const body = creditsSchema.parse(request.body);
      const usage = await addBonusCredits(body.merchantId, body.credits);
      return { success: true, usage };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to add credits' };
    }
  });
}
