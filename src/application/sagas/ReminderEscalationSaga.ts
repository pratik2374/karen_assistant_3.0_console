import { SagaBase, SagaSnapshot } from './SagaBase.js';
import { HybridTimerService } from '../../infrastructure/temporal/HybridTimerService.js';
import { TemporalPolicyEngine, TemporalPolicy } from '../../domain/shared/temporal/TemporalPolicyEngine.js';
import { clock } from '../../domain/shared/temporal/SystemClock.js';
import { randomUUID } from 'crypto';
import { ICommandExecutor } from '../executor/IExecutor.js';
import { EscalationCommand } from '../../domain/reminder/ReminderAggregate.js';
import { ExecutionContext } from '../../composition/context/ExecutionContext.js';

export type ReminderEscalationState = 'PENDING' | 'WAITING_ACK_1' | 'WAITING_ACK_2' | 'ESCALATED' | 'COMPLETED' | 'CANCELLED';

interface ReminderSagaData {
  taskId: string;
  escalationCount: number;
  userTimezone: string;
  userId: string;
  taskTitle: string;
}

export class ReminderEscalationSaga extends SagaBase<ReminderEscalationState> {
  private data: ReminderSagaData;

  constructor(
    sagaId: string,
    aggregateId: string, // the ReminderAggregate ID
    correlationId: string,
    traceId: string,
    data: ReminderSagaData
  ) {
    super(sagaId, 'ReminderEscalation', 'PENDING', aggregateId, correlationId, traceId);
    this.data = data;
  }

  protected getSnapshotPayload(): any {
    return this.data;
  }

  public restoreFromSnapshot(snapshot: SagaSnapshot): void {
    this.sagaId = snapshot.sagaId;
    this.currentState = snapshot.currentState as ReminderEscalationState;
    this.aggregateId = snapshot.aggregateId;
    this.correlationId = snapshot.correlationId;
    this.startedAt = snapshot.startedAt;
    this.updatedAt = snapshot.updatedAt;
    this.version = snapshot.version;
    this.data = snapshot.payloadData;
  }

  // --- WORKFLOW HANDLERS ---

  public async onTaskCreated(
    timerService: HybridTimerService,
    isReplay: boolean,
    offsetMs?: number
  ): Promise<void> {
    if (this.currentState !== 'PENDING') return;

    // Schedule the first reminder
    this.transition('WAITING_ACK_1');
    
    await this.scheduleNextWakeup(timerService, offsetMs ?? 60 * 60 * 1000, isReplay);
  }

  public async onTimerWakeup(
    timerService: HybridTimerService,
    commandExecutor: ICommandExecutor<EscalationCommand, void>,
    context: ExecutionContext
  ): Promise<void> {
    this.data.escalationCount++;

    if (this.data.escalationCount === 1) {
      this.transition('WAITING_ACK_2');
      await this.scheduleNextWakeup(timerService, 10 * 60 * 1000, context.executionMode === 'REPLAY');
    } else if (this.data.escalationCount === 2) {
      this.transition('ESCALATED');
      await this.scheduleNextWakeup(timerService, 5 * 60 * 1000, context.executionMode === 'REPLAY');
    } else {
      this.transition('COMPLETED');
      this.markAsCompleted();
    }

    // Emit the command to the Aggregate to actually mutate state and send the physical reminder
    if (context.executionMode !== 'REPLAY') {
      const command: EscalationCommand = {
        taskId: this.data.taskId,
        traceId: this.traceId,
        correlationId: this.correlationId,
        timeContext: {
          timezone: this.data.userTimezone,
          utcOffsetMinutes: 0,
          currentUtcTime: clock.now(),
          localTime: clock.now(),
          isDndWindow: false // TemporalPolicyEngine handles this before wake up!
        }
      };

      try {
        await commandExecutor.execute(command, context);
      } catch (err: any) {
        // If it fails (e.g. DND invariant rejection or token exhausted), compensate
        this.markAsFailed(err.message, 'RETRY' as any);
      }
    }
  }

  public async onReminderAcknowledged(timerService: HybridTimerService): Promise<void> {
    if (this.currentState === 'COMPLETED' || this.currentState === 'CANCELLED') return;
    
    this.transition('COMPLETED');
    this.markAsCompleted();
    await timerService.cancelBySaga(this.sagaId); // Halt all pending timers
  }

  public async onHumanOverride(timerService: HybridTimerService): Promise<void> {
    if (this.currentState === 'COMPLETED' || this.currentState === 'CANCELLED') return;
    
    this.transition('CANCELLED');
    this.markAsCompleted();
    await timerService.cancelBySaga(this.sagaId);
  }

  // --- INTERNAL ---

  private async scheduleNextWakeup(timerService: HybridTimerService, offsetMs: number, isReplay: boolean): Promise<void> {
    if (isReplay) return; // REPLAY SAFETY: Never arm timers during replay

    const targetTime = new Date(clock.now().getTime() + offsetMs);
    const policy: TemporalPolicy = {
      timezone: this.data.userTimezone,
      dndStartHour: 0, // Disabled
      dndEndHour: 0
    };
    
    // Proactive DND forward calculation
    const safeWakeTime = TemporalPolicyEngine.calculateSafeWakeTime(targetTime, policy);

    await timerService.schedule({
      timerId: randomUUID(),
      sagaId: this.sagaId,
      sagaType: this.sagaType,
      actionIntent: 'ESCALATE_REMINDER',
      payload: { escalationLevel: this.data.escalationCount + 1 },
      targetWakeTime: safeWakeTime,
      status: 'PENDING',
      traceId: this.traceId,
      correlationId: this.correlationId
    });
  }
}
