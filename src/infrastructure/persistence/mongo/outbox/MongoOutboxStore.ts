import { Collection, ClientSession, Db } from 'mongodb';
import { IOutboxStore, OutboxMessage } from '../../../../application/ports/IOutboxStore.js';

export class MongoOutboxStore implements IOutboxStore {
  private collection: Collection<OutboxMessage>;

  constructor(db: Db) {
    this.collection = db.collection<OutboxMessage>('outbox_events');
  }

  async save(message: OutboxMessage, session?: ClientSession): Promise<void> {
    await this.collection.insertOne(message, { session });
  }

  async saveBulk(messages: OutboxMessage[], session?: ClientSession): Promise<void> {
    if (messages.length === 0) return;
    await this.collection.insertMany(messages, { session });
  }

  async getUnpublishedMessages(limit: number): Promise<OutboxMessage[]> {
    return this.collection
      .find({ processedAt: null })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async markAsPublished(messageId: string): Promise<void> {
    await this.collection.updateOne(
      { messageId },
      { $set: { processedAt: new Date() } }
    );
  }
}
