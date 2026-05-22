import { IOutboxStore } from '../../../application/ports/IOutboxStore.js';
import { RedisDistributedLock } from '../redis/RedisDistributedLock.js';
import { BullMQEventPublisher } from '../bullmq/BullMQEventPublisher.js';

export class OutboxDispatcher {
  private isRunning: boolean = false;

  constructor(
    private outboxStore: IOutboxStore,
    private publisher: BullMQEventPublisher,
    private lockService: RedisDistributedLock
  ) {}

  public async startPolling(intervalMs: number = 2000): Promise<void> {
    this.isRunning = true;
    while (this.isRunning) {
      await this.dispatchBatch();
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  public stop(): void {
    this.isRunning = false;
  }

  private async dispatchBatch(): Promise<void> {
    const lockKey = 'locks:outbox-dispatcher';
    
    try {
      // Visibility timeout: 10 seconds. If worker crashes, another worker can acquire after 10s.
      const { lock } = await this.lockService.acquire(lockKey, 10000);
      
      try {
        const messages = await this.outboxStore.getUnpublishedMessages(50);
        
        for (const msg of messages) {
          try {
            await this.publisher.publish(msg);
            await this.outboxStore.markAsPublished(msg.messageId);
            
            // Heartbeat extension for long batches
            await this.lockService.extend(lock, 5000);
          } catch (err) {
            // Poison message isolation: skip this message, continue batch
            console.error(`Failed to dispatch message ${msg.messageId}`, err);
          }
        }
      } finally {
        await this.lockService.release(lock);
      }
    } catch (err) {
      // Failed to acquire lock, another worker is actively dispatching. Safe to skip.
    }
  }
}
