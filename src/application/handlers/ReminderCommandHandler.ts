import { IApplicationHandler } from '../executor/CommandExecutionPipeline';
import { IExecutionContext } from '../../composition/context/ExecutionContext';
import { IRepository } from '../ports/IRepository';
import { IOutboxStore, OutboxMessage } from '../ports/IOutboxStore';
import { IUnitOfWork } from '../ports/IUnitOfWork';
import { ReminderAggregate, EscalationCommand } from '../../domain/reminder/ReminderAggregate';
import { randomUUID } from 'crypto';

export class ReminderCommandHandler
  implements IApplicationHandler<EscalationCommand, void> {

  constructor(
    private reminderRepository: IRepository<ReminderAggregate>,
    private outboxStore: IOutboxStore,
    private buildUnitOfWork: () => IUnitOfWork
  ) {}

  async handle(command: EscalationCommand, context: IExecutionContext): Promise<void> {
    const uow = this.buildUnitOfWork();
    await uow.start();

    try {
      const now = new Date();
      // Try to find the reminder aggregate first
      const reminderId = `reminder-${command.taskId}`;
      let reminder = await this.reminderRepository.findById(reminderId);
      
      let expectedVersion = 0;
      if (!reminder) {
        // Initialize if not exists
        reminder = ReminderAggregate.initialize(reminderId, command.taskId, context.traceId, context.correlationId);
      } else {
        expectedVersion = reminder.version;
      }

      // Escalate
      reminder.escalate(command);

      // Save aggregate
      await this.reminderRepository.saveWithVersion(reminder, expectedVersion);

      // Save uncommitted events to Outbox
      const outboxMessages: OutboxMessage[] = reminder.uncommittedEvents.map((event: any) => ({
        messageId: randomUUID(),
        eventType: event.eventType,
        payload: event,
        createdAt: now,
        processedAt: null,
        idempotencyKey: `${context.correlationId}:${event.eventType}:${reminder.version}`,
        deduplicationKey: `${reminderId}:${event.eventType}:${reminder.version}`,
        replaySafe: false,
        sideEffectFree: false,
        traceId: context.traceId,
        correlationId: context.correlationId,
        causationId: context.causationId || command.taskId
      }));

      await this.outboxStore.saveBulk(outboxMessages);
      await uow.commit();

      console.log(JSON.stringify({
        type: 'REMINDER_ESCALATED',
        reminderId,
        traceId: context.traceId,
        correlationId: context.correlationId,
        eventsEmitted: outboxMessages.length
      }));
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}
