import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { exec } from 'child_process';
import path from 'path';

/**
 * Validates GitHub Webhook HMAC-SHA256 signature
 */
function verifyGitHubSignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = `sha256=${hmac.update(payload).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export async function deployWebhookRoutes(app: FastifyInstance) {
  // Capture raw body for signature verification
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      const json = JSON.parse(body as string);
      (req as any).rawBody = body;
      done(null, json);
    } catch (err: any) {
      done(err, undefined);
    }
  });

  app.post('/api/v1/system/deploy-webhook', async (request, reply) => {
    const secret = process.env.DEPLOY_WEBHOOK_SECRET;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (request as any).rawBody || JSON.stringify(request.body);

    if (!secret) {
      reply.status(500);
      return { success: false, error: 'DEPLOY_WEBHOOK_SECRET is not configured on server' };
    }

    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      reply.status(401);
      return { success: false, error: 'Invalid GitHub webhook signature' };
    }

    const payload = request.body as any;
    const ref = payload?.ref;

    // Only deploy on push to main branch
    if (ref !== 'refs/heads/main') {
      return { success: true, message: `Ignored push to branch ${ref}` };
    }

    app.log.info('🚀 GitHub Push received on main! Initiating automated deployment...');

    // Run deployment script asynchronously
    const deployScriptPath = path.resolve(process.cwd(), 'deploy.sh');
    
    exec(`bash "${deployScriptPath}"`, (error, stdout, stderr) => {
      if (error) {
        app.log.error({ error, stderr }, '❌ Auto-deployment failed');
        return;
      }
      app.log.info({ stdout }, '✅ Auto-deployment completed successfully');
    });

    return {
      success: true,
      message: 'Deployment triggered successfully on main branch update',
      commit: payload?.head_commit?.id,
    };
  });
}
