import { SagaSnapshot } from '../sagas/SagaBase.js';

export interface ISagaRepository {
  save(saga: SagaSnapshot, expectedVersion?: number): Promise<void>;
  findById(sagaId: string): Promise<SagaSnapshot | null>;
}
