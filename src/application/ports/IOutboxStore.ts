import { DomainEvent } from '../../domain/shared/events/DomainEvent.js';

export interface OutboxMessage {
  messageId: string;
  eventType: string;
  payload: any;
  createdAt: Date;
  processedAt: Date | null;
  // Metadata for reliable publishing
  idempotencyKey: string;
  deduplicationKey: string;
  replaySafe: boolean;
  sideEffectFree: boolean;
  
  // Tracing
  traceId: string;
  correlationId: string;
  causationId?: string;
}

export interface IOutboxStore {
  save(message: OutboxMessage): Promise<void>;
  saveBulk(messages: OutboxMessage[]): Promise<void>;
  
  // Used by the background outbox worker (Infrastructure layer)
  getUnpublishedMessages(limit: number): Promise<OutboxMessage[]>;
  markAsPublished(messageId: string): Promise<void>;
}
