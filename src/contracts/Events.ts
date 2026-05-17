import { z } from 'zod';

export enum EventType {
  TASK_CREATED = 'TASK_CREATED',
  TASK_UPDATED = 'TASK_UPDATED',
  REMINDER_SENT = 'REMINDER_SENT',
  REMINDER_ACKNOWLEDGED = 'REMINDER_ACKNOWLEDGED',
  MEMORY_COMPRESSED = 'MEMORY_COMPRESSED',
  CALENDAR_SYNCED = 'CALENDAR_SYNCED'
}

export const DomainEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.nativeEnum(EventType),
  eventVersion: z.number().int().positive(),
  timestamp: z.date(),
  payload: z.any(),
  // Tracing context
  traceId: z.string().uuid(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional()
});

/**
 * All Domain Events must be immutable to guarantee audit replay integrity.
 */
export type DomainEvent = Readonly<z.infer<typeof DomainEventSchema>>;
