import { AggregateRoot } from '../shared/core/AggregateRoot.js';
import { DomainEvent } from '../shared/events/DomainEvent.js';
import { EventFactory } from '../shared/events/EventFactory.js';
import { TimeContext } from '../shared/value-objects/TimeContext.js';
import { ReminderState } from '../../contracts/StateMachines.js';
import { DndViolationError, DomainInvariantError } from '../shared/errors/DomainErrors.js';

export interface EscalationCommand {
  taskId: string;
  timeContext: TimeContext;
  traceId: string;
  correlationId: string;
}

export class ReminderAggregate extends AggregateRoot {
  private taskId!: string;
  private state!: ReminderState;
  private escalationCount!: number;

  static MAX_ESCALATIONS = 3;

  private constructor(id: string) {
    super(id);
  }

  static initialize(id: string, taskId: string, traceId: string, correlationId: string): ReminderAggregate {
    const aggregate = new ReminderAggregate(id);
    aggregate.applyChange(
      EventFactory.create(
        'Reminder.Initialized',
        id,
        'ReminderAggregate',
        aggregate.version + 1,
        { taskId, initialState: ReminderState.PENDING },
        traceId,
        correlationId
      )
    );
    return aggregate;
  }

  // --- INVARIANTS ---
  
  private canEscalate(): void {
    if (this.state === ReminderState.STOPPED) {
      throw new DomainInvariantError('Cannot escalate an acknowledged or stopped reminder.');
    }
    if (this.escalationCount >= ReminderAggregate.MAX_ESCALATIONS) {
      throw new DomainInvariantError('Max escalation count reached.');
    }
  }

  private enforceDndWindow(timeContext: TimeContext): void {
    if (timeContext.isDndWindow) {
      throw new DndViolationError(`Cannot fire reminder during DND. Local time: ${timeContext.localTime.toISOString()}`);
    }
  }

  // --- COMMAND HANDLERS ---

  public escalate(cmd: EscalationCommand): void {
    this.canEscalate();
    this.enforceDndWindow(cmd.timeContext);

    const nextState = this.calculateNextState();

    this.applyChange(
      EventFactory.create(
        'Reminder.Escalated',
        this.id,
        'ReminderAggregate',
        this.version + 1,
        { taskId: this.taskId, fromState: this.state, toState: nextState, escalationCount: this.escalationCount + 1 },
        cmd.traceId,
        cmd.correlationId
      )
    );
  }

  public acknowledge(traceId: string, correlationId: string): void {
    if (this.state === ReminderState.STOPPED) {
      throw new DomainInvariantError('Reminder is already stopped/acknowledged.');
    }

    this.applyChange(
      EventFactory.create(
        'Reminder.Acknowledged',
        this.id,
        'ReminderAggregate',
        this.version + 1,
        { taskId: this.taskId, state: ReminderState.STOPPED },
        traceId,
        correlationId
      )
    );
  }

  private calculateNextState(): ReminderState {
    switch (this.state) {
      case ReminderState.PENDING: return ReminderState.SENT;
      case ReminderState.SENT: return ReminderState.FOLLOWUP_1;
      case ReminderState.FOLLOWUP_1: return ReminderState.FOLLOWUP_2;
      case ReminderState.FOLLOWUP_2: return ReminderState.ESCALATED;
      default: return this.state;
    }
  }

  // --- MUTATORS (Applies events to state for replay compatibility) ---

  protected mutate(event: DomainEvent): void {
    switch (event.eventType) {
      case 'Reminder.Initialized':
        this.taskId = event.payload.taskId;
        this.state = event.payload.initialState;
        this.escalationCount = 0;
        this.incrementVersion();
        break;
      
      case 'Reminder.Escalated':
        this.state = event.payload.toState;
        this.escalationCount = event.payload.escalationCount;
        this.incrementVersion();
        break;

      case 'Reminder.Acknowledged':
        this.state = event.payload.state;
        this.incrementVersion();
        break;
    }
  }
}
