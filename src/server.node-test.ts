import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';

describe('Fastify Server & API Endpoints Verification', () => {
  it('1. GET /health should return status ok', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'telegram-saas-core');
    await app.close();
  });

  it('2. POST /api/v1/bots/preview should reject invalid token format', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/preview',
      payload: { token: 'invalid' },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });

  it('3. POST /api/v1/bots/verify-and-link should validate input with Zod and require valid UUID', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/verify-and-link',
      payload: {
        merchantId: 'not-a-uuid',
        token: '123456:ABC-DEF',
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });
});
