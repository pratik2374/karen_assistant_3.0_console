import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { WhatsAppWebhookController } from '../controllers/WhatsAppWebhookController.js';
import { WebhookIdempotencyGuard } from '../middleware/idempotency/WebhookIdempotencyGuard.js';

export function createWebhookRoutes(controller: WhatsAppWebhookController, guard: WebhookIdempotencyGuard): Router {
  const router = Router();

  // Strict rate limiting for webhook endpoint
  const webhookRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Webhook rate limit exceeded', code: 'RATE_LIMITED' }
  });

  // Verification handshake (GET)
  router.get('/whatsapp', webhookRateLimit, (req, res) => controller.verify(req, res));

  // Inbound webhook (POST) — raw body needed for HMAC verification
  router.post('/whatsapp', webhookRateLimit, guard.middleware, (req, res) => controller.receive(req, res));

  return router;
}

