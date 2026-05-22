// @ts-nocheck
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { RuntimeEventBus } from '../../../../console/RuntimeEventBus.js';
import { RuntimeStore } from '../../../../console/RuntimeStore.js';

export class WebhookIdempotencyGuard {
  constructor(private redis: Redis) {}

  public middleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      (req as any).idempotencyInvocations = ((req as any).idempotencyInvocations || 0) + 1;
      const invCount = (req as any).idempotencyInvocations;

      const payload = Buffer.isBuffer(req.body)
        ? JSON.parse(req.body.toString())
        : req.body;
      
      const entry = payload?.entry?.[0];
      const change = entry?.changes?.[0];
      const messagesList = change?.value?.messages;
      const statusesList = change?.value?.statuses;
      
      const payloadType = messagesList ? 'messages' :
                          statusesList ? 'statuses' : 'other';

      const message = messagesList?.[0];
      const statusObj = statusesList?.[0];
      
      RuntimeEventBus.log('IDEMPOTENCY_DIAGNOSTIC_START', 'TRANSPORT',
        `Idempotency Guard | Invocation: ${invCount} | Payload type: ${payloadType} | Msg ID: ${message?.id || 'none'} | Status ID: ${statusObj?.id || 'none'}`,
        req.traceId
      );

      if (!message || !message.id) {
        RuntimeEventBus.log('IDEMPOTENCY_SKIP', 'TRANSPORT',
          'Idempotency skipped: no message object or message.id found',
          req.traceId
        );
        return next();
      }

      const messageId = message.id;
      const cacheKey = `wh:idempotency:${messageId}`;

      // SETNX: Set if Not Exists
      const acquired = await this.redis.set(cacheKey, 'processed', 'EX', 172800, 'NX');

      RuntimeEventBus.log('IDEMPOTENCY_REDIS_RESULT', 'TRANSPORT',
        `Idempotency Redis check | Key: ${cacheKey} | Acquired NX: ${!!acquired}`,
        req.traceId
      );

      if (!acquired) {
        RuntimeEventBus.log('IDEMPOTENCY_SUPPRESSED', 'TRANSPORT',
          `Idempotency suppressed: duplicate message detected for key: ${cacheKey}`,
          req.traceId
        );

        RuntimeStore.recordWebhook(true);
        RuntimeEventBus.log('WEBHOOK_DUPLICATE', 'TRANSPORT',
          `Duplicate suppressed: ${messageId}`, req.traceId, { messageId });

        res.status(200).json({ status: 'duplicate_suppressed' });
        return;
      }

      RuntimeStore.recordWebhook(false);
      next();
    } catch (error: any) {
      RuntimeEventBus.log('IDEMPOTENCY_GUARD_ERROR', 'ERROR',
        `Idempotency Guard failed: ${error.message}`,
        req.traceId,
        { stack: error.stack }
      );
      next();
    }
  }
}
