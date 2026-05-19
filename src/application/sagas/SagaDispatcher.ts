import { ISagaRepository } from '../ports/ISagaRepository';
import { HybridTimerService } from '../../infrastructure/temporal/HybridTimerService';
import { DomainEvent } from '../../domain/shared/events/DomainEvent';
import { ReminderEscalationSaga } from './ReminderEscalationSaga';
import { ICommandExecutor } from '../executor/IExecutor';
import { EscalationCommand } from '../../domain/reminder/ReminderAggregate';
import { ExecutionContext } from '../../composition/context/ExecutionContext';
import { SagaObservabilityHook } from '../../infrastructure/observability/metrics/SagaObservabilityHook';
import { RuntimeEventBus } from '../../console/RuntimeEventBus';

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

      const dueAt = event.payload.expiresAt ? new Date(event.payload.expiresAt) : null;
      const offsetMs = dueAt ? Math.max(dueAt.getTime() - Date.now(), 0) : 60 * 60 * 1000;
      const userId = event.payload.userId || context.userId || '917439707352';

      const saga = new ReminderEscalationSaga(
        sagaId,
        event.aggregateId,
        event.correlationId,
        event.traceId,
        {
          taskId: event.aggregateId,
          escalationCount: 0,
          userTimezone: 'Asia/Kolkata',
          userId,
          taskTitle: event.payload.title || 'Reminder'
        }
      );

      this.sagaHook.onSagaStarted(sagaId, 'ReminderEscalationSaga', event.traceId);
      
      RuntimeEventBus.log('SAGA_STARTED', 'SAGA',
        `ReminderEscalationSaga started for task ${event.aggregateId} (due in ${Math.round(offsetMs / 1000)}s)`,
        event.traceId,
        { sagaId, taskId: event.aggregateId, userId, offsetMs }
      );

      await saga.onTaskCreated(this.timerService, isReplay, offsetMs);
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
