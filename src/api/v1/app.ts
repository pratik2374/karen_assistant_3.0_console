import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { resolveIdentity } from '../middleware/resolveIdentity.js';
import { createTaskRoutes } from './routes/taskRoutes.js';
import { createWebhookRoutes } from './routes/webhookRoutes.js';
import { TaskController } from './controllers/TaskController.js';
import { WhatsAppWebhookController } from './controllers/WhatsAppWebhookController.js';
import { WebhookIdempotencyGuard } from './middleware/idempotency/WebhookIdempotencyGuard.js';

export function createApp(
  taskController: TaskController,
  webhookController: WhatsAppWebhookController,
  idempotencyGuard: WebhookIdempotencyGuard
): express.Application {
  const app = express();

  // --- Security Hardening ---
  app.use(helmet());
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*' }));
  app.set('trust proxy', 1);

  // Raw body for webhook signature verification (must be registered before global express.json)
  app.use('/v1/webhooks', express.raw({ type: 'application/json', limit: '50kb' }));

  // Payload size limits — prevent abuse
  app.use(express.json({ limit: '100kb' }));

  // Global rate limit — last-resort abuse protection
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'Global rate limit exceeded', code: 'RATE_LIMITED' }
  }));

  // --- Request Context Propagation ---
  app.use(resolveIdentity);

  // --- Versioned API Routes ---
  app.use('/v1/tasks', createTaskRoutes(taskController));
  app.use('/v1/webhooks', createWebhookRoutes(webhookController, idempotencyGuard));

  // Health endpoint — no auth required
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', version: 'v1' });
  });

  return app;
}
