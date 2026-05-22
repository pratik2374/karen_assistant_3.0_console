import { AggregateRoot } from '../../domain/shared/core/AggregateRoot.js';

export interface IRepository<T extends AggregateRoot> {
  findById(id: string): Promise<T | null>;
  save(aggregate: T): Promise<void>;
  
  // For optimistic concurrency control
  saveWithVersion(aggregate: T, expectedVersion: number): Promise<void>;
}
