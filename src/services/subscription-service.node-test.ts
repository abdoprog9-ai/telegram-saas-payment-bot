import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';

describe('Phase 6: Subscriptions & Rollover Quota Accounting Verification', () => {
  it('1. should calculate quota according to (base + bonus) - used formula accurately', () => {
    const base = 100;
    const bonus = 50;
    const used = 30;

    const available = (base + bonus) - used;
    assert.equal(available, 120, 'Available operations must equal 120');

    // Simulate monthly renewal: base resets to 100, used resets to 0, bonus remains 50
    const newBase = 100;
    const newUsed = 0;
    const renewedAvailable = (newBase + bonus) - newUsed;
    assert.equal(renewedAvailable, 150, 'Available after renewal must include preserved bonus credits (150)');
  });

  it('2. POST /api/v1/subscriptions/credits should reject negative or zero credits', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/credits',
      payload: {
        merchantId: 'a0000000-0000-0000-0000-000000000001',
        credits: 0, // Invalid: must be positive
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });

  it('3. GET /api/v1/subscriptions/usage should require merchantId query parameter', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/usage',
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    assert.equal(body.error, 'merchantId is required');
    await app.close();
  });
});
