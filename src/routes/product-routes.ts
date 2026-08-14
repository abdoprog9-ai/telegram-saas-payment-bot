import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createProduct,
  getMerchantProducts,
  softDeleteProduct,
  importDigitalCodes,
  getProductInventoryMetrics,
} from '../services/product-service.js';

const createProductSchema = z.object({
  merchantId: z.string().uuid({ message: 'merchantId must be a valid UUID' }),
  botId: z.string().uuid({ message: 'botId must be a valid UUID' }),
  name: z.string().min(1, { message: 'Product name is required' }),
  description: z.string().optional(),
  priceStars: z.number().int().positive({ message: 'priceStars must be a positive integer' }),
  productType: z.enum(['code', 'file', 'content']).optional().default('code'),
});

const importCodesSchema = z.object({
  merchantId: z.string().uuid({ message: 'merchantId must be a valid UUID' }),
  codes: z.array(z.string()).min(1, { message: 'codes array must contain at least 1 code' }),
});

export async function productRoutes(app: FastifyInstance) {
  // 1. Create Product
  app.post('/api/v1/products', async (request, reply) => {
    try {
      const body = createProductSchema.parse(request.body);
      const product = await createProduct(body);
      return { success: true, product };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to create product' };
    }
  });

  // 2. List Products
  app.get<{
    Querystring: { merchantId?: string; botId?: string };
  }>('/api/v1/products', async (request, reply) => {
    const { merchantId, botId } = request.query;
    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId query parameter is required' };
    }

    try {
      const products = await getMerchantProducts(merchantId, botId);
      return { success: true, products };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });

  // 3. Import Digital Codes
  app.post<{
    Params: { id: string };
  }>('/api/v1/products/:id/codes/import', async (request, reply) => {
    const productId = request.params.id;
    try {
      const body = importCodesSchema.parse(request.body);
      const result = await importDigitalCodes(body.merchantId, productId, body.codes);
      return { success: true, result };
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        reply.status(400);
        return { success: false, errors: err.errors };
      }
      reply.status(400);
      return { success: false, error: err?.message || 'Failed to import codes' };
    }
  });

  // 4. Get Inventory Metrics
  app.get<{
    Params: { id: string };
    Querystring: { merchantId: string };
  }>('/api/v1/products/:id/inventory', async (request, reply) => {
    const productId = request.params.id;
    const { merchantId } = request.query;

    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    try {
      const metrics = await getProductInventoryMetrics(merchantId, productId);
      return { success: true, productId, ...metrics };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });

  // 5. Soft Delete Product
  app.delete<{
    Params: { id: string };
    Querystring: { merchantId: string };
  }>('/api/v1/products/:id', async (request, reply) => {
    const productId = request.params.id;
    const { merchantId } = request.query;

    if (!merchantId) {
      reply.status(400);
      return { success: false, error: 'merchantId is required' };
    }

    try {
      await softDeleteProduct(productId, merchantId);
      return { success: true, message: 'Product soft-deleted successfully' };
    } catch (err: any) {
      reply.status(500);
      return { success: false, error: err?.message };
    }
  });
}
