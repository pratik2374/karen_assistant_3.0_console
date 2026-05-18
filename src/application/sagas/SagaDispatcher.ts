import { ISagaRepository } from '../ports/ISagaRepository';
import { HybridTimerService } from '../../infrastructure/temporal/HybridTimerService';
import { DomainEvent } from '../../domain/shared/events/DomainEvent';
import { ReminderEscalationSaga } from './ReminderEscalationSaga';
import { ICommandExecutor } from '../executor/IExecutor';
import { EscalationCommand } from '../../domain/reminder/ReminderAggregate';
import { ExecutionContext } from '../../composition/context/ExecutionContext';
import { SagaObservabilityHook } from '../../infrastructure/observability/metrics/SagaObservabilityHook';

export class SagaDispatcher {
  constructor(
    private sagaRepository: ISagaRepository,
    private timerService: HybridTimerService,
    private commandExecutor: ICommandExecutor<EscalationCommand, void>,
    private sagaHook: SagaObservabilityHook
  ) {}

  public async dispatchEvent(event: DomainEvent, context: ExecutionContext): Promise<void> {
    const isReplay = context.executionMode === 'REPLAY';

    // 1. Task.Created -> Starts ReminderEscalationSaga
    if (event.eventType === 'Task.Created') {
      const sagaId = `saga-reminder-${event.aggregateId}`;
      
      const existing = await this.sagaRepository.findById(sagaId);
      if (existing) return; // Idempotency check

      const saga = new ReminderEscalationSaga(
        sagaId,
        event.aggregateId, // Assuming ReminderAggregate shares ID with Task for simplicity here
        event.correlationId,
        event.traceId,
        {
          taskId: event.aggregateId,
          escalationCount: 0,
          userTimezone: 'UTC' // In production, fetch from user profile
        }
      );

      this.sagaHook.onSagaStarted(sagaId, 'ReminderEscalationSaga', event.traceId);
      
      await saga.onTaskCreated(this.timerService, isReplay);
      await this.sagaRepository.save(saga.createSnapshot(), 0);
    }

    // 2. Reminder.Acknowledged -> Interrupts Saga
    if (event.eventType === 'Reminder.Acknowledged') {
      const sagaId = `saga-reminder-${event.payload.taskId}`; // Using taskId as correlation
      const snapshot = await this.sagaRepository.findById(sagaId);
      
      if (snapshot) {
        const saga = new ReminderEscalationSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
        saga.restoreFromSnapshot(snapshot);
        
        await saga.onReminderAcknowledged(this.timerService);
        await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);
        
        this.sagaHook.onSagaCompleted(sagaId, 'ReminderEscalationSaga', event.traceId);
      }
    }
  }

  // 3. Timer Wakeup -> Resumes Saga
  public async dispatchTimerWakeup(timerId: string, sagaId: string, context: ExecutionContext): Promise<void> {
    const snapshot = await this.sagaRepository.findById(sagaId);
    if (!snapshot) return; // Saga not found or already completed/deleted

    if (snapshot.sagaType === 'ReminderEscalation') {
      const saga = new ReminderEscalationSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
      saga.restoreFromSnapshot(snapshot);

      this.sagaHook.onSagaResumed(sagaId, 'ReminderEscalationSaga', context.traceId);

      await saga.onTimerWakeup(this.timerService, this.commandExecutor, context);
      
      await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);
    }
  }
}
