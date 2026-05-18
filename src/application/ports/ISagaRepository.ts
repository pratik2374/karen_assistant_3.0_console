import { SagaSnapshot } from '../sagas/SagaBase';

export interface ISagaRepository {
  save(saga: SagaSnapshot, expectedVersion?: number): Promise<void>;
  findById(sagaId: string): Promise<SagaSnapshot | null>;
}
