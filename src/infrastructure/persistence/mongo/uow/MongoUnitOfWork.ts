import { ClientSession, Db, MongoClient } from 'mongodb';
import { IUnitOfWork } from '../../../../application/ports/IUnitOfWork.js';

export class MongoUnitOfWork implements IUnitOfWork {
  private session: ClientSession | null = null;

  constructor(private client: MongoClient, private db: Db) {}

  async start(): Promise<void> {
    this.session = this.client.startSession();
    this.session.startTransaction();
  }

  async commit(): Promise<void> {
    if (!this.session) throw new Error('Transaction not started');
    await this.session.commitTransaction();
    await this.session.endSession();
    this.session = null;
  }

  async rollback(): Promise<void> {
    if (!this.session) return;
    await this.session.abortTransaction();
    await this.session.endSession();
    this.session = null;
  }

  getContext(): ClientSession {
    if (!this.session) {
      throw new Error('No active transaction context');
    }
    return this.session;
  }
}
