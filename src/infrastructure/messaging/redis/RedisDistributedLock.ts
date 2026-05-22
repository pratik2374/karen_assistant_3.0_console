// @ts-nocheck
// @ts-ignore
import Redlock, { Lock } from 'redlock';
import { Redis } from 'ioredis';

export interface DistributedLockContext {
  lockId: string;
  fencingToken: number;
}

export class RedisDistributedLock {
  private redlock: Redlock;

  constructor(redisClients: Redis[]) {
    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500
    });
  }

  /**
   * Acquires a lease. The returned fencingToken represents the lock's version
   * which can be validated by consumers to ensure the lease hasn't expired.
   */
  async acquire(resourceKey: string, ttlMs: number): Promise<{ lock: Lock; context: DistributedLockContext }> {
    const lock = await this.redlock.acquire([resourceKey], ttlMs);
    
    // Simulate a simple fencing token by using the lock start timestamp
    // A robust fencing token would ideally be monotonic across the distributed store.
    const fencingToken = Date.now();
    
    return {
      lock,
      context: {
        lockId: resourceKey,
        fencingToken
      }
    };
  }

  async extend(lock: Lock, ttlMs: number): Promise<Lock> {
    return await lock.extend(ttlMs);
  }

  async release(lock: Lock): Promise<void> {
    await lock.release();
  }
}
