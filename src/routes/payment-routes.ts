import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSupabase } from '../database/supabase.js';
import { getOrCreateBotInstance } from '../bot/bot-engine.js';
import { refundTelegramStarsPayment } from '../services/payment-service.js';

const refundSchema = z.object({
  botId: z.string().uuid(),
  merchantId: z.string().uuid(),
  userId: z.number().int().positive(),
  telegramChargeId: z.string().min(1),
  reason: z.string().optional(),
});

export async function paymentRoutes(app: FastifyInstance) {
  // 1. List Payments
  app.get<{
    Querystring: { merchantId: string; limit?: string; offset?: string };
  }>('/api/v1/payments', async (request, reply) => {
    const { merchantId, limit, offset } = request.query;
    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    const supabase = getSupabase();
    const { data, count, error } = await supabase
      .from('payments')
      .select('*, invoices(invoice_number, title)', { count: 'exact' })
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false })
      .range(
        offset ? parseInt(offset, 10) : 0,
        (offset ? parseInt(offset, 10) : 0) + (limit ? parseInt(limit, 10) : 20) - 1
      );

    if (error) {
      reply.status(500);
      return { success: false, error: error.message };
    }

    return { success: true, payments: data || [], total: count ?? 0 };
  });

  // 2. Process Refund
  app.post('/api/v1/payments/refund', async (request, reply) => {
    try {
      const body = refundSchema.parse(request.body);
      const { botInstance } = await getOrCreateBotInstance(body.botId);

      const refund = await refundTelegramStarsPayment(
        botInstance.api,
        body.userId,
        body.telegramChargeId,
        body.merchantId,
        body.reason
      );

      return { success: true, refund };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to refund payment' };
    }
  });
}
