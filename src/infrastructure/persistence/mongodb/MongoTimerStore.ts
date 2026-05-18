import { ITimerStore, TimerRecord } from '../../../application/ports/ITimerStore';
import { Db, Collection } from 'mongodb';

export class MongoTimerStore implements ITimerStore {
  private collection: Collection;

  constructor(db: Db) {
    this.collection = db.collection('timers_active');
  }

  async save(timer: TimerRecord): Promise<void> {
    await this.collection.updateOne(
      { _id: timer.timerId as any },
      { $set: { ...timer, _id: timer.timerId } },
      { upsert: true }
    );
  }

  async cancel(timerId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: timerId as any },
      { $set: { status: 'CANCELLED' } }
    );
  }

  async cancelBySaga(sagaId: string): Promise<void> {
    await this.collection.updateMany(
      { sagaId, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } }
    );
  }

  async markExecuted(timerId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: timerId as any },
      { $set: { status: 'EXECUTED' } }
    );
  }

  async getPendingTimers(upToTime: Date = new Date()): Promise<TimerRecord[]> {
    const docs = await this.collection.find({
      status: 'PENDING',
      targetWakeTime: { $lte: upToTime }
    }).toArray();

    return docs.map(doc => ({
      timerId: doc._id.toString(),
      sagaId: doc.sagaId,
      sagaType: doc.sagaType,
      actionIntent: doc.actionIntent,
      payload: doc.payload,
      targetWakeTime: doc.targetWakeTime,
      status: doc.status,
      traceId: doc.traceId,
      correlationId: doc.correlationId
    }));
  }
}
