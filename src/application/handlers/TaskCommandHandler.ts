import { IApplicationHandler } from '../executor/CommandExecutionPipeline.js';
import { IExecutionContext } from '../../composition/context/ExecutionContext.js';
import { IRepository } from '../ports/IRepository.js';
import { IOutboxStore, OutboxMessage } from '../ports/IOutboxStore.js';
import { IUnitOfWork } from '../ports/IUnitOfWork.js';
import { TaskAggregate } from '../../domain/task/TaskAggregate.js';
import { TimeContext } from '../../domain/shared/value-objects/TimeContext.js';
import { randomUUID } from 'crypto';

export interface CreateTaskCommand {
  commandId: string;
  commandDeduplicationKey: string;
  title: string;
  priority: string;
  dueAt: Date;
  timezone: string;
  userId?: string;
}

export interface CreateTaskResult {
  taskId: string;
}

// -----------------------------------------------------------------------
// TaskCommandHandler — canonical production-safe handler.
//
// Pattern: UoW.start → Aggregate.create → Outbox.save → UoW.commit
// ALL atomic. If outbox.save fails, aggregate write is also rolled back.
// -----------------------------------------------------------------------
export class TaskCommandHandler
  implements IApplicationHandler<CreateTaskCommand, CreateTaskResult> {

  constructor(
    private taskRepository: IRepository<TaskAggregate>,
    private outboxStore: IOutboxStore,
    private buildUnitOfWork: () => IUnitOfWork
  ) {}

  async handle(command: CreateTaskCommand, context: IExecutionContext): Promise<CreateTaskResult> {
    const uow = this.buildUnitOfWork();
    await uow.start();

    try {
      const taskId = randomUUID();
      const now = new Date();

      // Build minimal TimeContext for aggregate invariant evaluation
      const timeContext = TimeContext.create(
        command.timezone,
        0,
        now,
        now,
        false
      );

      // 1. Create the aggregate — invariants enforced internally
      const task = TaskAggregate.create(
        taskId,
        command.priority,
        command.title,
        command.dueAt,
        command.userId || context.userId,
        {
          traceId: context.traceId,
          correlationId: context.correlationId,
          expiresAt: command.dueAt,
          timeContext
        }
      );

      // 2. Save with optimistic concurrency (version 0 = new entity)
      await this.taskRepository.saveWithVersion(task, 0);

      // 3. Build outbox messages from uncommitted domain events
      const outboxMessages: OutboxMessage[] = task.uncommittedEvents.map((event: any) => ({
        messageId: randomUUID(),
        eventType: event.eventType,
        payload: event,
        createdAt: now,
        processedAt: null,
        idempotencyKey: `${command.commandDeduplicationKey}:${event.eventType}`,
        deduplicationKey: `${taskId}:${event.eventType}:${event.aggregateVersion}`,
        replaySafe: false,
        sideEffectFree: false,
        traceId: context.traceId,
        correlationId: context.correlationId,
        causationId: command.commandId
      }));

      await this.outboxStore.saveBulk(outboxMessages);

      // 4. Commit atomically
      await uow.commit();

      console.log(JSON.stringify({
        type: 'TASK_CREATED',
        taskId,
        traceId: context.traceId,
        correlationId: context.correlationId,
        executionMode: context.executionMode,
        eventsEmitted: outboxMessages.length
      }));

      return { taskId };
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}
