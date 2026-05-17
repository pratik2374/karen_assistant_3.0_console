import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import { RuntimeConfig } from '../config/RuntimeConfig';

// Fail-fast startup checks — Karen must never boot in a partially healthy state.
export class StartupValidator {
  constructor(
    private config: RuntimeConfig,
    private mongoClient: MongoClient,
    private redis: Redis
  ) {}

  async validate(): Promise<void> {
    const checks: Array<{ name: string; check: () => Promise<void> }> = [
      { name: 'RuntimeConfig', check: () => this.validateConfig() },
      { name: 'MongoDB', check: () => this.validateMongo() },
      { name: 'Redis', check: () => this.validateRedis() },
    ];

    console.log('[STARTUP] Running startup validation...');
    const failures: string[] = [];

    for (const { name, check } of checks) {
      try {
        await check();
        console.log(`[STARTUP] ✓ ${name}`);
      } catch (err: any) {
        console.error(`[STARTUP] ✗ ${name}: ${err.message}`);
        failures.push(name);
      }
    }

    if (failures.length > 0) {
      console.error(`[STARTUP] Fatal: System cannot boot. Failed checks: ${failures.join(', ')}`);
      process.exit(1);
    }

    console.log('[STARTUP] All checks passed. System is READY.');
  }

  private async validateConfig(): Promise<void> {
    if (!this.config.MONGO_URI) {
      throw new Error('MONGO_URI is required');
    }
    if (this.config.EXECUTION_MODE === 'PRODUCTION' && this.config.WHATSAPP_WEBHOOK_SECRET === 'changeme') {
      throw new Error('WHATSAPP_WEBHOOK_SECRET must be set in PRODUCTION mode');
    }
  }

  private async validateMongo(): Promise<void> {
    await this.mongoClient.db('admin').command({ ping: 1 });
  }

  private async validateRedis(): Promise<void> {
    const pong = await this.redis.ping();
    if (pong !== 'PONG') throw new Error('Redis ping failed');
  }
}
