import { MessageEnvelope } from '../contracts/MessageEnvelope.js';
import { RedisIdempotencyStore, ProcessingState } from './RedisIdempotencyStore.js';
import { IDeadLetterQueue } from '../../../application/ports/DeadLetterContracts.js';

export abstract class IdempotentConsumer<TPayload> {
  constructor(
    private idempotencyStore: RedisIdempotencyStore,
    private deadLetterQueue: IDeadLetterQueue
  ) {}

  public async consume(envelope: MessageEnvelope<TPayload>): Promise<void> {
    // 1. Replay Safety Guard
    if (envelope.replayed && !envelope.replaySafe) {
      console.warn(`Dropping replayed message ${envelope.messageId} - marked as unsafe.`);
      return;
    }

    const dedupKey = `${envelope.aggregateType}:${envelope.aggregateId}:${envelope.eventId}`;

    // 2. Check Processing State
    const status = await this.idempotencyStore.getStatus(dedupKey);

    if (status === ProcessingState.PROCESSED) {
      console.log(`Message ${dedupKey} already processed. Dropping duplicate.`);
      return;
    }

    if (status === ProcessingState.PROCESSING) {
      // Another worker is actively processing. We should throw to let BullMQ retry this later,
      // simulating a visibility timeout / lock wait.
      throw new Error(`Message ${dedupKey} is currently processing by another worker. Retrying...`);
    }

    // 3. Acquire Processing Lock
    const acquired = await this.idempotencyStore.checkAndSetProcessing(dedupKey);
    if (!acquired) {
      throw new Error(`Failed to acquire processing lock for ${dedupKey}. Retrying...`);
    }

    try {
      // 4. Delegate to Application Layer Handler
      await this.handle(envelope.payload, envelope);

      // 5. Mark as Processed
      await this.idempotencyStore.markProcessed(dedupKey);
    } catch (error: any) {
      // 6. Handle Failure
      await this.idempotencyStore.markFailed(dedupKey);
      throw error; // Let BullMQ retry, or it goes to Dead Letter Queue when retries exhaust
    }
  }

  // Abstract method implemented by specific application-level consumer adapters
  protected abstract handle(payload: TPayload, envelope: MessageEnvelope<TPayload>): Promise<void>;
}
