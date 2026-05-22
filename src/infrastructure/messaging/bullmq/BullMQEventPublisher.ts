import { Queue } from 'bullmq';
import { OutboxMessage } from '../../../application/ports/IOutboxStore.js';
import { MessageEnvelope } from '../contracts/MessageEnvelope.js';

export class BullMQEventPublisher {
  constructor(private queues: Map<string, Queue>) {}

  public async publish(message: OutboxMessage): Promise<void> {
    const queueName = this.determineQueuePriority(message.eventType);
    const queue = this.queues.get(queueName);

    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const envelope: MessageEnvelope<any> = {
      messageId: message.messageId,
      eventId: message.messageId, // Standardized internally
      schemaVersion: 1,
      traceId: message.traceId,
      correlationId: message.correlationId,
      causationId: message.causationId,
      aggregateId: 'system', // Pulled from outbox parsing logic in reality
      aggregateType: 'Outbox',
      aggregateVersion: 1,
      retryCount: 0,
      issuedAt: message.createdAt,
      replayed: false,
      replaySafe: message.replaySafe,
      sideEffectFree: message.sideEffectFree,
      payload: message.payload
    };

    // Use job ID for internal BullMQ deduplication in addition to explicit consumer deduplication
    await queue.add(message.eventType, envelope, {
      jobId: message.deduplicationKey,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    });
  }

  private determineQueuePriority(eventType: string): string {
    if (eventType.startsWith('Reminder.')) return 'CRITICAL';
    if (eventType.startsWith('Memory.')) return 'LOW';
    if (eventType.startsWith('Analytics.')) return 'LOWEST';
    return 'HIGH'; // Default user commands
  }
}
