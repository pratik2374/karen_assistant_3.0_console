import { ISagaRepository } from '../../../application/ports/ISagaRepository';
import { SagaSnapshot } from '../../../application/sagas/SagaBase';
import { Db, Collection } from 'mongodb';

export class MongoSagaRepository implements ISagaRepository {
  private collection: Collection;

  constructor(db: Db) {
    this.collection = db.collection('saga_states');
  }

  async save(saga: SagaSnapshot, expectedVersion: number = 0): Promise<void> {
    const result = await this.collection.updateOne(
      { _id: saga.sagaId as any, version: expectedVersion },
      {
        $set: {
          ...saga,
          _id: saga.sagaId,
          version: expectedVersion + 1
        }
      },
      { upsert: expectedVersion === 0 }
    );

    if (result.matchedCount === 0 && result.upsertedCount === 0) {
      throw new Error(`Saga optimistic concurrency failure. Expected version: ${expectedVersion}`);
    }
  }

  async findById(sagaId: string): Promise<SagaSnapshot | null> {
    const doc = await this.collection.findOne({ _id: sagaId as any });
    if (!doc) return null;

    return {
      sagaId: doc.sagaId,
      sagaType: doc.sagaType,
      currentState: doc.currentState,
      aggregateId: doc.aggregateId,
      correlationId: doc.correlationId,
      traceId: doc.traceId,
      startedAt: doc.startedAt,
      updatedAt: doc.updatedAt,
      version: doc.version,
      payloadData: doc.payloadData
    };
  }
}
