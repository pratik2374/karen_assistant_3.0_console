import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import { OutboxDispatcher } from '../../infrastructure/messaging/outbox/OutboxDispatcher';

export interface GracefulShutdownTargets {
  mongoClient: MongoClient;
  redis: Redis;
  outboxDispatcher: OutboxDispatcher;
}

export class GracefulShutdown {
  private isShuttingDown = false;

  constructor(private targets: GracefulShutdownTargets) {}

  register(): void {
    const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
    signals.forEach(signal => {
      process.on(signal, () => this.shutdown(signal));
    });
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log(`[SHUTDOWN] Received ${signal}. Starting graceful shutdown...`);

    try {
      // 1. Stop accepting new outbox work first
      this.targets.outboxDispatcher.stop();
      console.log('[SHUTDOWN] ✓ Outbox dispatcher stopped');

      // 2. Close Redis (releases Redlock leases)
      await this.targets.redis.quit();
      console.log('[SHUTDOWN] ✓ Redis connection closed');

      // 3. Close Mongo sessions last (flush any remaining writes)
      await this.targets.mongoClient.close();
      console.log('[SHUTDOWN] ✓ MongoDB connection closed');

      console.log('[SHUTDOWN] Graceful shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error('[SHUTDOWN] Error during shutdown:', err);
      process.exit(1);
    }
  }
}
