// @ts-nocheck
import { Redis } from 'ioredis';
import { IDeadLetterQueue, DeadLetterRecord } from '../../../application/ports/DeadLetterContracts.js';

export class RedisDeadLetterQueue implements IDeadLetterQueue {
  private readonly DLQ_LIST_KEY = 'dlq:messages';

  constructor(private redis: Redis) {}

  async enqueue(record: DeadLetterRecord): Promise<void> {
    const quarantinedRecord = {
      ...record,
      quarantinedAt: new Date(),
      reviewedBy: null,
      replayApproved: false
    };

    // Push to the right of the Redis list (FIFO)
    await this.redis.rpush(this.DLQ_LIST_KEY, JSON.stringify(quarantinedRecord));
    
    // We could also emit an alert metric here for Observability Phase 2D
  }

  async getQuarantinedMessages(limit: number = 100): Promise<any[]> {
    const messages = await this.redis.lrange(this.DLQ_LIST_KEY, 0, limit - 1);
    return messages.map((msg: any) => JSON.parse(msg));
  }
}
