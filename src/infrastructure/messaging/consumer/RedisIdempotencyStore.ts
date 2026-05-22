// @ts-nocheck
import { Redis } from 'ioredis';

export enum ProcessingState {
  RECEIVED = 'RECEIVED',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
  DEAD_LETTERED = 'DEAD_LETTERED'
}

export class RedisIdempotencyStore {
  constructor(private redis: Redis) {}

  async checkAndSetProcessing(deduplicationKey: string): Promise<boolean> {
    const key = `idempotency:${deduplicationKey}`;
    // NX: Set only if it does not exist. EX: Expire in 10 minutes (safety fallback if worker crashes hard)
    const result = await this.redis.set(key, ProcessingState.PROCESSING, 'EX', 600, 'NX');
    return result === 'OK'; // true means we acquired the right to process
  }

  async markProcessed(deduplicationKey: string): Promise<void> {
    const key = `idempotency:${deduplicationKey}`;
    // Keep processed markers for 7 days
    await this.redis.set(key, ProcessingState.PROCESSED, 'EX', 604800);
  }

  async markFailed(deduplicationKey: string): Promise<void> {
    const key = `idempotency:${deduplicationKey}`;
    await this.redis.set(key, ProcessingState.FAILED, 'EX', 3600);
  }
  
  async getStatus(deduplicationKey: string): Promise<ProcessingState | null> {
    const key = `idempotency:${deduplicationKey}`;
    const status = await this.redis.get(key);
    return status as ProcessingState | null;
  }
}
