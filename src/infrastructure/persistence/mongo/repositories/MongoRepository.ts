import { Collection, Db, ClientSession } from 'mongodb';
import { IRepository } from '../../../../application/ports/IRepository.js';
import { AggregateRoot } from '../../../../domain/shared/core/AggregateRoot.js';
import { IDocumentMapper, IMongoDocument } from '../mappers/IDocumentMapper.js';
import { DomainInvariantError } from '../../../../domain/shared/errors/DomainErrors.js';

export abstract class MongoRepository<TAggregate extends AggregateRoot, TDocument extends IMongoDocument> implements IRepository<TAggregate> {
  protected collection: Collection<TDocument>;

  constructor(
    protected db: Db,
    collectionName: string,
    protected mapper: IDocumentMapper<TAggregate, TDocument>
  ) {
    this.collection = this.db.collection<TDocument>(collectionName);
  }

  async findById(id: string, session?: ClientSession): Promise<TAggregate | null> {
    const doc = await this.collection.findOne({ _id: id as any }, { session });
    if (!doc) return null;
    return this.mapper.toDomain(doc as any);
  }

  async save(aggregate: TAggregate, session?: ClientSession): Promise<void> {
    const doc = this.mapper.toDocument(aggregate);
    
    await this.collection.updateOne(
      { _id: aggregate.id as any },
      { $set: doc },
      { upsert: true, session }
    );
  }

  async saveWithVersion(aggregate: TAggregate, expectedVersion: number, session?: ClientSession): Promise<void> {
    const doc = this.mapper.toDocument(aggregate);

    const result = await this.collection.updateOne(
      { _id: aggregate.id as any, __v: expectedVersion } as any,
      { $set: doc },
      { upsert: expectedVersion === 0, session }
    );

    if (result.matchedCount === 0 && expectedVersion !== 0) {
      throw new DomainInvariantError(`Optimistic concurrency failure for Aggregate ${aggregate.id}`);
    }
  }
}
