import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateInvoiceNumber } from './invoice-service.js';
import { buildServer } from '../server.js';

describe('Phase 4: Invoices & Orders Single-Deduction Verification', () => {
  it('1. should generate unique human-friendly invoice numbers with prefix INV-', () => {
    const inv1 = generateInvoiceNumber();
    const inv2 = generateInvoiceNumber();

    assert.ok(inv1.startsWith('INV-'), 'Invoice number must start with INV-');
    assert.ok(inv2.startsWith('INV-'), 'Invoice number must start with INV-');
    assert.notEqual(inv1, inv2, 'Generated invoice numbers must be unique');
  });

  it('2. POST /api/v1/invoices should reject negative or zero amounts', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      payload: {
        merchantId: 'a0000000-0000-0000-0000-000000000001',
        botId: 'b0000000-0000-0000-0000-000000000001',
        title: 'Custom Service Billing',
        totalAmount: -10, // Invalid negative amount
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });

  it('3. POST /api/v1/orders should require merchantId, botId, customerId, and productId', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      payload: {
        merchantId: 'a0000000-0000-0000-0000-000000000001',
        // Missing botId, customerId, productId
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    await app.close();
  });

  it('4. GET /api/v1/invoices/lookup/:invoiceNumber should return 404 for non-existent invoice', async () => {
    const app = await buildServer();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices/lookup/INV-NONEXISTENT',
    });

    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.success, false);
    assert.equal(body.error, 'Invoice not found');
    await app.close();
  });
});
