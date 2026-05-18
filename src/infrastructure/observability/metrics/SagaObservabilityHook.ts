export interface SagaObservabilitySnapshot {
  sagaId: string;
  sagaType: string;
  currentState: string;
  retryCount: number;
  isTimedOut: boolean;
  isCompensating: boolean;
  waitingForDependencies: string[];
  lastUpdatedAt: string;
}

// Observers hook into Saga lifecycle without modifying Saga orchestration logic
export class SagaObservabilityHook {
  private snapshots: Map<string, SagaObservabilitySnapshot> = new Map();

  recordStateTransition(
    sagaId: string,
    sagaType: string,
    fromState: string,
    toState: string,
    retryCount: number
  ): void {
    const snapshot: SagaObservabilitySnapshot = {
      sagaId,
      sagaType,
      currentState: toState,
      retryCount,
      isTimedOut: false,
      isCompensating: false,
      waitingForDependencies: [],
      lastUpdatedAt: new Date().toISOString()
    };
    this.snapshots.set(sagaId, snapshot);
    console.log(JSON.stringify({
      type: 'SAGA_STATE_TRANSITION',
      sagaId,
      sagaType,
      fromState,
      toState,
      retryCount,
      timestamp: new Date().toISOString()
    }));
  }

  recordTimeout(sagaId: string): void {
    const s = this.snapshots.get(sagaId);
    if (s) {
      s.isTimedOut = true;
      console.log(JSON.stringify({ type: 'SAGA_TIMEOUT', sagaId, timestamp: new Date().toISOString() }));
    }
  }

  recordCompensation(sagaId: string, strategy: string): void {
    const s = this.snapshots.get(sagaId);
    if (s) {
      s.isCompensating = true;
      console.log(JSON.stringify({ type: 'SAGA_COMPENSATION_TRIGGERED', sagaId, strategy, timestamp: new Date().toISOString() }));
    }
  }

  getSnapshot(sagaId: string): SagaObservabilitySnapshot | undefined {
    return this.snapshots.get(sagaId);
  }

  onSagaStarted(sagaId: string, sagaType: string, traceId: string): void {
    console.log(JSON.stringify({ type: 'SAGA_STARTED', sagaId, sagaType, traceId, timestamp: new Date().toISOString() }));
  }

  onSagaCompleted(sagaId: string, sagaType: string, traceId: string): void {
    console.log(JSON.stringify({ type: 'SAGA_COMPLETED', sagaId, sagaType, traceId, timestamp: new Date().toISOString() }));
  }

  onSagaResumed(sagaId: string, sagaType: string, traceId: string): void {
    console.log(JSON.stringify({ type: 'SAGA_RESUMED', sagaId, sagaType, traceId, timestamp: new Date().toISOString() }));
  }
}
