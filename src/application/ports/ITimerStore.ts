export interface TimerRecord {
  timerId: string;
  sagaId: string;
  sagaType: string;
  actionIntent: string; // What should happen when it wakes up
  payload: any;
  targetWakeTime: Date;
  status: 'PENDING' | 'EXECUTED' | 'CANCELLED';
  traceId: string;
  correlationId: string;
}

export interface ITimerStore {
  save(timer: TimerRecord): Promise<void>;
  cancel(timerId: string): Promise<void>;
  cancelBySaga(sagaId: string): Promise<void>;
  markExecuted(timerId: string): Promise<void>;
  getPendingTimers(upToTime?: Date): Promise<TimerRecord[]>;
}
