import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { HttpErrorMapper } from '../../errors/HttpErrorMapper.js';
import { InboundMessagePipeline } from '../../../application/conversation/InboundMessagePipeline.js';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';

const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET ?? 'changeme';

function verifySignature(payload: Buffer, signature: string): boolean {
  const expected = createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  const expectedBuffer = Buffer.from(`sha256=${expected}`);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export class WhatsAppWebhookController {
  
  constructor(private pipeline: InboundMessagePipeline) {}

  verify(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Forbidden');
    }
  }

  async receive(req: Request, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-hub-signature-256'] as string;

      if (!verifySignature(req.body, signature)) {
        res.status(401).json({ error: 'Invalid webhook signature', code: 'SIGNATURE_FAILURE' });
        return;
      }

      const payload = JSON.parse(req.body.toString());

      const entry = payload?.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      const contact = change?.value?.contacts?.[0];
      
      if (!message || !message.id) {
        res.status(200).json({ status: 'ignored_non_message' });
        return;
      }

      const messageId = message.id;
      const userId = contact?.wa_id || message.from;
      const messageText = message.text?.body;

      RuntimeEventBus.log('WEBHOOK_RECEIVED', 'TRANSPORT',
        `Inbound message from ${userId}: "${messageText?.substring(0, 40)}..."`,
        req.traceId, { messageId, userId }
      );

      // Immediately return 200 OK to WhatsApp to prevent retries and timeouts
      res.status(200).json({ status: 'received' });

      // Async Background Dispatch
      if (messageText && userId) {
        this.pipeline.process(userId, messageText, messageId, req.traceId).catch(err => {
          RuntimeEventBus.log('PIPELINE_ERROR', 'ERROR',
            `Async pipeline failure: ${err.message}`, req.traceId);
        });
      }

    } catch (err) {
      HttpErrorMapper.toResponse(err, res, req.correlationId);
    }
  }
}

