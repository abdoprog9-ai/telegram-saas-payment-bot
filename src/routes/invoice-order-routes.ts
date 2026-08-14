import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createInvoice,
  getMerchantInvoices,
  getInvoiceByNumber,
  softDeleteInvoice,
} from '../services/invoice-service.js';
import { createProductOrder, getMerchantOrders } from '../services/order-service.js';

const createInvoiceSchema = z.object({
  merchantId: z.string().uuid(),
  botId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  currency: z.string().optional().default('XTR'),
  totalAmount: z.number().int().positive(),
  items: z.array(
    z.object({
      productId: z.string().uuid().optional(),
      title: z.string().min(1),
      quantity: z.number().int().positive().optional().default(1),
      unitPrice: z.number().int().positive(),
      totalPrice: z.number().int().positive().optional(),
    })
  ).optional(),
  expiresAt: z.string().optional(),
});

const createOrderSchema = z.object({
  merchantId: z.string().uuid(),
  botId: z.string().uuid(),
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
});

export async function invoiceOrderRoutes(app: FastifyInstance) {
  // 1. Create Invoice
  app.post('/api/v1/invoices', async (request, reply) => {
    try {
      const body = createInvoiceSchema.parse(request.body);
      const invoice = await createInvoice(body);
      return { success: true, invoice };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to create invoice' };
    }
  });

  // 2. List Invoices
  app.get<{
    Querystring: { merchantId: string; botId?: string; status?: any; limit?: string; offset?: string };
  }>('/api/v1/invoices', async (request, reply) => {
    const { merchantId, botId, status, limit, offset } = request.query;
    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    try {
      const result = await getMerchantInvoices(
        merchantId,
        botId,
        status,
        limit ? parseInt(limit, 10) : 20,
        offset ? parseInt(offset, 10) : 0
      );
      return { success: true, ...result };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });

  // 3. Lookup Invoice by Public Invoice Number
  app.get<{
    Params: { invoiceNumber: string };
  }>('/api/v1/invoices/lookup/:invoiceNumber', async (request, reply) => {
    try {
      const invoice = await getInvoiceByNumber(request.params.invoiceNumber);
      if (!invoice) {
        reply.status(404);
        return { success: false, error: 'Invoice not found' };
      }
      return { success: true, invoice };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });

  // 4. Soft Delete / Cancel Invoice
  app.delete<{
    Params: { id: string };
    Querystring: { merchantId: string };
  }>('/api/v1/invoices/:id', async (request, reply) => {
    const { id } = request.params;
    const { merchantId } = request.query;

    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    try {
      await softDeleteInvoice(id, merchantId);
      return { success: true, message: 'Invoice soft-deleted/cancelled successfully' };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });

  // 5. Create Order for Product
  app.post('/api/v1/orders', async (request, reply) => {
    try {
      const body = createOrderSchema.parse(request.body);
      const result = await createProductOrder(body);
      return { success: true, ...result };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to create order' };
    }
  });

  // 6. List Orders
  app.get<{
    Querystring: { merchantId: string; botId?: string; status?: any; limit?: string; offset?: string };
  }>('/api/v1/orders', async (request, reply) => {
    const { merchantId, botId, status, limit, offset } = request.query;
    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    try {
      const result = await getMerchantOrders(
        merchantId,
        botId,
        status,
        limit ? parseInt(limit, 10) : 20,
        offset ? parseInt(offset, 10) : 0
      );
      return { success: true, ...result };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });
}
