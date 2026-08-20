import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';
import { buildAdminMainMenu } from './admin-handlers.js';

describe('Phase 2: Telegram Webhooks & Multi-Bot Routing Verification', () => {
  it('1. should construct admin dashboard inline keyboard with core sections', () => {
    const keyboard = buildAdminMainMenu();
    const inline = keyboard.inline_keyboard;

    assert.ok(inline.length >= 2, 'Admin keyboard must have multiple rows');
    
    // Check for Invoices, Subscription, Settings
    const allButtons = inline.flat();
    const buttonTexts = allButtons.map(b => b.text);

    assert.ok(buttonTexts.some(t => t.includes('الفواتير')), 'Must have Invoices button');
    assert.ok(buttonTexts.some(t => t.includes('الاشتراك') || t.includes('اشتراكي')), 'Must have Subscription button');
    assert.ok(buttonTexts.some(t => t.includes('إعدادات')), 'Must have Settings button');
  });

  it('2. POST /api/v1/telegram/webhook/:botId should return 401 for requests with missing secret token', async () => {
    const app = await buildServer();
    
    // Request without X-Telegram-Bot-Api-Secret-Token
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/telegram/webhook/123e4567-e89b-12d3-a456-426614174000',
      payload: {
        update_id: 1001,
        message: { text: '/start', from: { id: 999999 } },
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Unauthorized secret token');
    await app.close();
  });

  it('3. POST /api/v1/telegram/platform-webhook should reject unauthorized platform requests', async () => {
    process.env.PLATFORM_BOT_SECRET = 'correct_platform_secret_123';
    const app = await buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/telegram/platform-webhook',
      headers: {
        'x-telegram-bot-api-secret-token': 'wrong_secret',
      },
      payload: { update_id: 1 },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    await app.close();
  });
});
