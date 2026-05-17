import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { RuntimeConfig } from '../config/RuntimeConfig';
import { RedisDistributedLock } from '../../infrastructure/messaging/redis/RedisDistributedLock';
import { BullMQEventPublisher } from '../../infrastructure/messaging/bullmq/BullMQEventPublisher';
import { RedisIdempotencyStore } from '../../infrastructure/messaging/consumer/RedisIdempotencyStore';
import { RedisDeadLetterQueue } from '../../infrastructure/messaging/redis/RedisDeadLetterQueue';
import { IOutboxStore } from '../../application/ports/IOutboxStore';
import { OutboxDispatcher } from '../../infrastructure/messaging/outbox/OutboxDispatcher';

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
  const redis = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null // Required for BullMQ
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
