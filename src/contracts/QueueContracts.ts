import { z } from 'zod';

export enum QueuePriority {
  CRITICAL = 1, // reminder execution
  HIGH = 2,     // incoming chat
  LOW = 5,      // memory compression
  LOWEST = 10   // analytics
}

export enum QueueName {
  REMINDER_EXECUTION = 'REMINDER_EXECUTION',
  INCOMING_CHAT = 'INCOMING_CHAT',
  BATCH_PROCESSING = 'BATCH_PROCESSING',
  ANALYTICS = 'ANALYTICS'
}

export const QueueJobSchema = z.object({
  jobId: z.string(),
  queueName: z.nativeEnum(QueueName),
  priority: z.nativeEnum(QueuePriority),
  payload: z.any(),
  // Distributed tracing across the queue boundary
  traceId: z.string().uuid(),
  correlationId: z.string().uuid(),
  idempotencyKey: z.string()
});

export type QueueJob = z.infer<typeof QueueJobSchema>;
