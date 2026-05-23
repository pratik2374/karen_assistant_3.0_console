import { SagaBase, SagaSnapshot } from './SagaBase.js';
import { HybridTimerService } from '../../infrastructure/temporal/HybridTimerService.js';
import { TemporalPolicyEngine, TemporalPolicy } from '../../domain/shared/temporal/TemporalPolicyEngine.js';
import { clock } from '../../domain/shared/temporal/SystemClock.js';
import { randomUUID } from 'crypto';

export type CalendarReminderState =
  | 'PENDING'
  | 'PRE_ALERT'
  | 'WAITING_START'
  | 'EMOTIONAL_NUDGE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'SNOOZED';

export interface CalendarReminderSagaData {
  taskId: string;
  escalationStage: number;  // 0=pre-alert, 1=waiting_start, 2=emotional_nudge
  userTimezone: string;
  userId: string;
  taskTitle: string;
  eventStartTime: string;   // ISO string — the current event start time
  googleEventId?: string;   // needed for snooze to update Google Calendar
}

export class CalendarReminderSaga extends SagaBase<CalendarReminderState> {
  private data: CalendarReminderSagaData;

  constructor(
    sagaId: string,
    aggregateId: string,
    correlationId: string,
    traceId: string,
    data: CalendarReminderSagaData
  ) {
    super(sagaId, 'CalendarReminder', 'PENDING', aggregateId, correlationId, traceId);
    this.data = data;
  }

  protected getSnapshotPayload(): any {
    return this.data;
  }

  public restoreFromSnapshot(snapshot: SagaSnapshot): void {
    this.sagaId = snapshot.sagaId;
    this.currentState = snapshot.currentState as CalendarReminderState;
    this.aggregateId = snapshot.aggregateId;
    this.correlationId = snapshot.correlationId;
    this.startedAt = snapshot.startedAt;
    this.updatedAt = snapshot.updatedAt;
    this.version = snapshot.version;
    this.data = snapshot.payloadData;
  }

  /** Called when first created from a calendar event. Schedules PRE_ALERT 10 min before event. */
  public async onTaskCreated(
    timerService: HybridTimerService,
    isReplay: boolean,
    eventStartTime: Date
  ): Promise<void> {
    if (this.currentState !== 'PENDING') return;
    this.transition('PRE_ALERT');

    const preAlertTime = new Date(eventStartTime.getTime() - 10 * 60 * 1000);
    const fireAt = preAlertTime > clock.now() ? preAlertTime : new Date(Date.now() + 1000);
    await this.scheduleWakeup(timerService, fireAt, isReplay, 0);
  }

  /** Called when a timer wakeup fires. Advances through stages and schedules next. */
  public async onTimerWakeup(
    timerService: HybridTimerService,
    isReplay: boolean
  ): Promise<{ stage: number; title: string; userId: string } | null> {
    if (this.currentState === 'COMPLETED' || this.currentState === 'CANCELLED') return null;

    const stage = this.data.escalationStage;
    const result = { stage, title: this.data.taskTitle, userId: this.data.userId };

    if (stage === 0) {
      // PRE_ALERT fired → schedule WAITING_START 15 min after event start
      this.data.escalationStage = 1;
      this.transition('WAITING_START');
      const eventStart = new Date(this.data.eventStartTime);
      const followUpTime = new Date(eventStart.getTime() + 15 * 60 * 1000);
      const fireAt = followUpTime > clock.now() ? followUpTime : new Date(Date.now() + 60000);
      await this.scheduleWakeup(timerService, fireAt, isReplay, 1);
    } else if (stage === 1) {
      // WAITING_START fired → schedule EMOTIONAL_NUDGE 10 min later
      this.data.escalationStage = 2;
      this.transition('EMOTIONAL_NUDGE');
      const nudgeTime = new Date(Date.now() + 10 * 60 * 1000);
      await this.scheduleWakeup(timerService, nudgeTime, isReplay, 2);
    } else {
      // EMOTIONAL_NUDGE fired → done
      this.transition('COMPLETED');
      this.markAsCompleted();
    }

    return result;
  }

  /** User said "I started" — stop all timers and complete. */
  public async onAcknowledged(timerService: HybridTimerService): Promise<void> {
    if (this.currentState === 'COMPLETED' || this.currentState === 'CANCELLED') return;
    this.transition('COMPLETED');
    this.markAsCompleted();
    await timerService.cancelBySaga(this.sagaId);
  }

  /** User said "snooze X minutes" — cancel timers, update start time, restart from PRE_ALERT. */
  public async onSnooze(
    timerService: HybridTimerService,
    snoozeMinutes: number,
    isReplay: boolean
  ): Promise<void> {
    if (this.currentState === 'COMPLETED' || this.currentState === 'CANCELLED') return;

    await timerService.cancelBySaga(this.sagaId);

    const newStartTime = new Date(Date.now() + snoozeMinutes * 60 * 1000);
    this.data.eventStartTime = newStartTime.toISOString();
    this.data.escalationStage = 0;
    this.transition('SNOOZED');

    const preAlertTime = new Date(newStartTime.getTime() - 10 * 60 * 1000);
    const fireAt = preAlertTime > clock.now() ? preAlertTime : new Date(Date.now() + 1000);
    await this.scheduleWakeup(timerService, fireAt, isReplay, 0);

    this.transition('PRE_ALERT');
  }

  private async scheduleWakeup(
    timerService: HybridTimerService,
    targetTime: Date,
    isReplay: boolean,
    stage: number
  ): Promise<void> {
    if (isReplay) return;

    const policy: TemporalPolicy = {
      timezone: this.data.userTimezone,
      dndStartHour: 0, // Disabled
      dndEndHour: 0
    };
    const safeWakeTime = TemporalPolicyEngine.calculateSafeWakeTime(targetTime, policy);

    await timerService.schedule({
      timerId: randomUUID(),
      sagaId: this.sagaId,
      sagaType: this.sagaType,
      actionIntent: 'CALENDAR_REMINDER_WAKEUP',
      payload: { stage },
      targetWakeTime: safeWakeTime,
      status: 'PENDING',
      traceId: this.traceId,
      correlationId: this.correlationId
    });
  }
}
