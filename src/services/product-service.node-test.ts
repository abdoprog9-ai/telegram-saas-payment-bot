import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';

describe('Phase 3: Products & Digital Codes Inventory Verification', () => {
  it('1. POST /api/v1/products should validate body schema and require priceStars > 0', async () => {
    const app = await buildServer();
    
    // Invalid price <= 0
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      payload: {
        merchantId: 'a0000000-0000-0000-0000-000000000001',
        botId: 'b0000000-0000-0000-0000-000000000001',
        name: 'VIP Telegram Group Key',
        priceStars: 0, // Invalid: must be positive
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });

  it('2. POST /api/v1/products/:id/codes/import should validate codes array is not empty', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products/c0000000-0000-0000-0000-000000000001/codes/import',
      payload: {
        merchantId: 'a0000000-0000-0000-0000-000000000001',
        codes: [], // Invalid: empty codes array
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });

  it('3. GET /api/v1/products should require merchantId query parameter', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    assert.equal(body.error, 'merchantId query parameter is required');
    await app.close();
  });
});
