import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';

describe('Phase 5: Telegram Stars Payments & Idempotency Verification', () => {
  it('1. GET /api/v1/payments should require merchantId query parameter', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/payments',
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    assert.equal(body.error, 'merchantId is required');
    await app.close();
  });

  it('2. POST /api/v1/payments/refund should validate UUID fields and charge ID', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/refund',
      payload: {
        botId: 'invalid-bot-uuid',
        merchantId: 'a0000000-0000-0000-0000-000000000001',
        userId: 12345678,
        telegramChargeId: 'charge_123',
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });
});
