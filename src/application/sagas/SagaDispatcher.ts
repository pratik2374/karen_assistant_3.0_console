import { ISagaRepository } from '../ports/ISagaRepository.js';
import { HybridTimerService } from '../../infrastructure/temporal/HybridTimerService.js';
import { DomainEvent } from '../../domain/shared/events/DomainEvent.js';
import { ReminderEscalationSaga } from './ReminderEscalationSaga.js';
import { CalendarReminderSaga } from './CalendarReminderSaga.js';
import { ICommandExecutor } from '../executor/IExecutor.js';
import { EscalationCommand } from '../../domain/reminder/ReminderAggregate.js';
import { ExecutionContext } from '../../composition/context/ExecutionContext.js';
import { SagaObservabilityHook } from '../../infrastructure/observability/metrics/SagaObservabilityHook.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';

export interface TimerWakeupResult {
  messageStage?: number;   // 0=PRE_ALERT, 1=WAITING_START, 2=EMOTIONAL_NUDGE
  taskTitle?: string;
  userId?: string;
  sagaType?: string;
}

export class SagaDispatcher {
  constructor(
    private sagaRepository: ISagaRepository,
    private timerService: HybridTimerService,
    private commandExecutor: ICommandExecutor<EscalationCommand, void>,
    private sagaHook: SagaObservabilityHook
  ) {}

  public async dispatchEvent(event: DomainEvent, context: ExecutionContext): Promise<void> {
    const isReplay = context.executionMode === 'REPLAY';

    // --- Task.Created → Start appropriate saga based on sourceType ---
    if (event.eventType === 'Task.Created') {
      const isCalendarEvent = event.payload.sourceType === 'calendar_sync';
      const sagaId = isCalendarEvent
        ? `saga-calendar-${event.aggregateId}`
        : `saga-reminder-${event.aggregateId}`;

      const existing = await this.sagaRepository.findById(sagaId);
      if (existing) return; // Idempotency

      const dueAt = event.payload.expiresAt ? new Date(event.payload.expiresAt) : null;
      const userId = event.payload.userId || context.userId || '917439707352';

      if (isCalendarEvent) {
        const saga = new CalendarReminderSaga(
          sagaId,
          event.aggregateId,
          event.correlationId,
          event.traceId,
          {
            taskId: event.aggregateId,
            escalationStage: 0,
            userTimezone: 'Asia/Kolkata',
            userId,
            taskTitle: event.payload.title || 'Calendar Event',
            eventStartTime: dueAt?.toISOString() || new Date().toISOString(),
            googleEventId: event.payload.googleEventId
          }
        );

        this.sagaHook.onSagaStarted(sagaId, 'CalendarReminderSaga', event.traceId);
        RuntimeEventBus.log('SAGA_STARTED', 'SAGA',
          `CalendarReminderSaga started for "${event.payload.title}" (starts at ${dueAt?.toISOString()})`,
          event.traceId, { sagaId, taskId: event.aggregateId, userId }
        );

        await saga.onTaskCreated(this.timerService, isReplay, dueAt || new Date());
        await this.sagaRepository.save(saga.createSnapshot(), 0);
      } else {
        // Manual reminder — existing ReminderEscalationSaga
        const offsetMs = dueAt ? Math.max(dueAt.getTime() - Date.now(), 0) : 60 * 60 * 1000;
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
          event.traceId, { sagaId, taskId: event.aggregateId, userId, offsetMs }
        );

        await saga.onTaskCreated(this.timerService, isReplay, offsetMs);
        await this.sagaRepository.save(saga.createSnapshot(), 0);
      }
    }

    // --- Reminder.Acknowledged → Stop saga (handles both types) ---
    if (event.eventType === 'Reminder.Acknowledged') {
      const taskId = event.payload.taskId || event.aggregateId;
      const sagaIds = [
        `saga-reminder-${taskId}`,
        `saga-calendar-${taskId}`
      ];

      for (const sagaId of sagaIds) {
        const snapshot = await this.sagaRepository.findById(sagaId);
        if (!snapshot) continue;

        if (snapshot.sagaType === 'CalendarReminder') {
          const saga = new CalendarReminderSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
          saga.restoreFromSnapshot(snapshot);
          await saga.onAcknowledged(this.timerService);
          await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);
        } else {
          const saga = new ReminderEscalationSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
          saga.restoreFromSnapshot(snapshot);
          await saga.onReminderAcknowledged(this.timerService);
          await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);
        }
        this.sagaHook.onSagaCompleted(sagaId, snapshot.sagaType || 'Unknown', event.traceId);
      }
    }

    // --- Task.Snoozed → Reschedule both the saga and Google Calendar event ---
    if (event.eventType === 'Task.Snoozed') {
      const taskId = event.payload.taskId;
      const snoozeMinutes = event.payload.snoozeMinutes || 15;
      const sagaId = `saga-calendar-${taskId}`;
      const snapshot = await this.sagaRepository.findById(sagaId);
      if (!snapshot) return;

      const saga = new CalendarReminderSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
      saga.restoreFromSnapshot(snapshot);
      await saga.onSnooze(this.timerService, snoozeMinutes, isReplay);
      await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);

      RuntimeEventBus.log('SAGA_SNOOZED', 'SAGA',
        `CalendarReminderSaga snoozed ${snoozeMinutes}min for task ${taskId}`,
        event.traceId
      );
    }
  }

  // Timer Wakeup → Resume the correct saga type
  public async dispatchTimerWakeup(timerId: string, sagaId: string, context: ExecutionContext): Promise<TimerWakeupResult | undefined> {
    const snapshot = await this.sagaRepository.findById(sagaId);
    if (!snapshot) return;

    if (snapshot.sagaType === 'CalendarReminder') {
      const saga = new CalendarReminderSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
      saga.restoreFromSnapshot(snapshot);
      this.sagaHook.onSagaResumed(sagaId, 'CalendarReminderSaga', context.traceId);

      const result = await saga.onTimerWakeup(this.timerService, false);
      await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);

      if (result) {
        return { messageStage: result.stage, taskTitle: result.title, userId: result.userId, sagaType: 'CalendarReminder' };
      }
    } else if (snapshot.sagaType === 'ReminderEscalation') {
      const saga = new ReminderEscalationSaga(sagaId, snapshot.aggregateId, snapshot.correlationId, snapshot.traceId, snapshot.payloadData);
      saga.restoreFromSnapshot(snapshot);
      this.sagaHook.onSagaResumed(sagaId, 'ReminderEscalationSaga', context.traceId);

      await saga.onTimerWakeup(this.timerService, this.commandExecutor, context);
      await this.sagaRepository.save(saga.createSnapshot(), snapshot.version);
      return { sagaType: 'ReminderEscalation' };
    }
  }
}
