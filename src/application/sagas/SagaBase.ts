import { CompensationAction, CompensationStrategy } from './CompensationStrategy.js';

export interface SagaSnapshot {
  sagaId: string;
  sagaType: string;
  currentState: string;
  aggregateId: string;
  correlationId: string;
  startedAt: Date;
  updatedAt: Date;
  version: number;
  traceId: string;
  payloadData: any;
}

export abstract class SagaBase<TState extends string> {
  public sagaId: string;
  public sagaType: string;
  public currentState: TState;
  
  public aggregateId: string;
  public correlationId: string;
  public causationId?: string;
  public traceId: string;
  public version: number;
  
  public startedAt: Date;
  public updatedAt: Date;
  public timeoutAt?: Date;
  public completedAt?: Date;
  
  public retryCount: number = 0;
  public lastError?: string;
  public compensationState?: CompensationAction;

  constructor(
    sagaId: string,
    sagaType: string,
    initialState: TState,
    aggregateId: string,
    correlationId: string,
    traceId: string
  ) {
    this.sagaId = sagaId;
    this.sagaType = sagaType;
    this.currentState = initialState;
    this.aggregateId = aggregateId;
    this.correlationId = correlationId;
    this.traceId = traceId;
    this.version = 0;
    
    this.startedAt = new Date();
    this.updatedAt = new Date();
  }

  protected transition(nextState: TState): void {
    this.currentState = nextState;
    this.updatedAt = new Date();
  }

  public markAsCompleted(): void {
    this.completedAt = new Date();
  }

  public markAsFailed(error: string, strategy: CompensationStrategy): void {
    this.lastError = error;
    this.compensationState = {
      strategy,
      reason: error,
      payload: {}
    };
    this.updatedAt = new Date();
  }

  public createSnapshot(): SagaSnapshot {
    return {
      sagaId: this.sagaId,
      sagaType: this.sagaType,
      currentState: String(this.currentState),
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      version: this.version,
      traceId: this.traceId,
      payloadData: this.getSnapshotPayload()
    };
  }

  protected abstract getSnapshotPayload(): any;
  public abstract restoreFromSnapshot(snapshot: SagaSnapshot): void;
}
