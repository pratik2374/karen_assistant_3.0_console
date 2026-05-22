// @ts-nocheck
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { RuntimeConfig } from '../config/RuntimeConfig.js';
import { RedisDistributedLock } from '../../infrastructure/messaging/redis/RedisDistributedLock.js';
import { BullMQEventPublisher } from '../../infrastructure/messaging/bullmq/BullMQEventPublisher.js';
import { RedisIdempotencyStore } from '../../infrastructure/messaging/consumer/RedisIdempotencyStore.js';
import { RedisDeadLetterQueue } from '../../infrastructure/messaging/redis/RedisDeadLetterQueue.js';
import { IOutboxStore } from '../../application/ports/IOutboxStore.js';
import { OutboxDispatcher } from '../../infrastructure/messaging/outbox/OutboxDispatcher.js';

export interface MessagingModule {
  redis: Redis;
  publisher: BullMQEventPublisher;
  idempotencyStore: RedisIdempotencyStore;
  deadLetterQueue: RedisDeadLetterQueue;
  lock: RedisDistributedLock;
  startOutboxDispatcher: (outboxStore: IOutboxStore) => OutboxDispatcher;
}

const QUEUE_NAMES = ['CRITICAL', 'HIGH', 'LOW', 'LOWEST'];

export function buildMessagingModule(config: RuntimeConfig): MessagingModule {
  const redisOpts = {
    maxRetriesPerRequest: null // Required for BullMQ
  };

  const redis = config.REDIS_URL 
    ? new Redis(config.REDIS_URL, redisOpts)
    : new Redis({
        ...redisOpts,
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD
      });

  const queues = new Map<string, Queue>(
    QUEUE_NAMES.map(name => [name, new Queue(name, { connection: redis })])
  );

  const lock = new RedisDistributedLock([redis]);
  const publisher = new BullMQEventPublisher(queues);
  const idempotencyStore = new RedisIdempotencyStore(redis);
  const deadLetterQueue = new RedisDeadLetterQueue(redis);

  const startOutboxDispatcher = (outboxStore: IOutboxStore): OutboxDispatcher => {
    const dispatcher = new OutboxDispatcher(outboxStore, publisher, lock);
    dispatcher.startPolling(2000);
    return dispatcher;
  };

  console.log('[MESSAGING] BullMQ queues and Redis adapters wired.');
  return { redis, publisher, idempotencyStore, deadLetterQueue, lock, startOutboxDispatcher };
}
