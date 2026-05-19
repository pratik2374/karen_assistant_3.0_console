import { AggregateRoot } from '../shared/core/AggregateRoot';
import { DomainEvent } from '../shared/events/DomainEvent';
import { EventFactory } from '../shared/events/EventFactory';
import { TaskState } from '../../contracts/StateMachines';
import { DomainInvariantError, TemporalValidityError } from '../shared/errors/DomainErrors';
import { TimeContext } from '../shared/value-objects/TimeContext';

export interface CommandContext {
  traceId: string;
  correlationId: string;
  expiresAt: Date;
  timeContext: TimeContext;
}

export class TaskAggregate extends AggregateRoot {
  private state!: TaskState;
  private priority!: string;

  private constructor(id: string) {
    super(id);
  }

  static create(id: string, priority: string, title: string, expiresAt: Date, userId: string, ctx: CommandContext): TaskAggregate {
    TaskAggregate.enforceTemporalValidity(ctx);

    const aggregate = new TaskAggregate(id);
    aggregate.applyChange(
      EventFactory.create(
        'Task.Created',
        id,
        'TaskAggregate',
        aggregate.version + 1,
        { state: TaskState.CREATED, priority, title, expiresAt, userId },
        ctx.traceId,
        ctx.correlationId
      )
    );
    return aggregate;
  }

  // --- INVARIANTS ---

  static enforceTemporalValidity(ctx: CommandContext): void {
    if (ctx.timeContext.currentUtcTime > ctx.expiresAt) {
      throw new TemporalValidityError('Command execution rejected. Temporal validity has expired.');
    }
  }

  private canComplete(): void {
    if (this.state === TaskState.ARCHIVED) {
      throw new DomainInvariantError('Cannot complete an archived task.');
    }
    if (this.state === TaskState.COMPLETED) {
      throw new DomainInvariantError('Task is already completed.');
    }
  }

  // --- COMMAND HANDLERS ---

  public complete(ctx: CommandContext): void {
    TaskAggregate.enforceTemporalValidity(ctx);
    this.canComplete();

    this.applyChange(
      EventFactory.create(
        'Task.Completed',
        this.id,
        'TaskAggregate',
        this.version + 1,
        { state: TaskState.COMPLETED },
        ctx.traceId,
        ctx.correlationId
      )
    );
  }

  // --- MUTATORS ---

  protected mutate(event: DomainEvent): void {
    switch (event.eventType) {
      case 'Task.Created':
        this.state = event.payload.state;
        this.priority = event.payload.priority;
        this.incrementVersion();
        break;
      case 'Task.Completed':
        this.state = event.payload.state;
        this.incrementVersion();
        break;
    }
  }
}
