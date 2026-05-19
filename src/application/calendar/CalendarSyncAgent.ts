import { DomainEvent } from '../../domain/shared/events/DomainEvent.js';
import { ExecutionContext } from '../../composition/context/ExecutionContext.js';
import { CalendarProjectionMongoRepository } from '../../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js';
import { CalendarEventProjection, CalendarSyncState } from '../../domain/calendar/CalendarEventProjection.js';
import { Queue } from 'bullmq';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { randomUUID } from 'crypto';

export class CalendarSyncAgent {
  constructor(
    private projectionRepository: CalendarProjectionMongoRepository,
    private syncJobQueue: Queue
  ) {}

  public async processDomainEvent(event: DomainEvent, context: ExecutionContext): Promise<void> {
    if (context.executionMode === 'REPLAY') {
      console.log(`[CalendarSyncAgent] Dropping replayed event ${event.eventId} (Replays do not trigger external sync unless explicitly forced)`);
      return;
    }

    try {
      switch (event.eventType) {
        case 'Task.Created':
          await this.handleTaskCreated(event, context);
          break;
        case 'Reminder.Acknowledged':
          await this.handleReminderAcknowledged(event, context);
          break;
        case 'Task.Updated':
          // Future: handle task updates
          break;
        case 'Task.Cancelled':
          // Future: handle task cancellation
          break;
        case 'Reminder.Escalated':
          // Future: update calendar if needed upon escalation
          break;
        default:
          break;
      }
    } catch (err: any) {
      RuntimeEventBus.log('CALENDAR_SYNC_AGENT_ERROR', 'ERROR',
        `Failed to process domain event ${event.eventType}: ${err.message}`,
        context.traceId
      );
      throw err;
    }
  }

  private async handleTaskCreated(event: DomainEvent, context: ExecutionContext): Promise<void> {
    const internalTaskId = event.aggregateId;
    
    // Check if projection already exists to ensure idempotency
    const existing = await this.projectionRepository.findByInternalTaskId(internalTaskId);
    if (existing) {
      return; // Already processed
    }

    const startTime = event.payload.expiresAt ? new Date(event.payload.expiresAt) : new Date();
    // Default duration: 30 minutes
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

    const projection: CalendarEventProjection = {
      internalTaskId,
      calendarId: 'primary',
      title: event.payload.title || 'Karen Task',
      startTime,
      endTime,
      timezone: 'Asia/Kolkata', // Should be pulled from payload if available
      syncState: CalendarSyncState.PENDING_CREATE,
      lastInternalMutationAt: new Date(),
      replaySafe: false,
      version: 1,
      createdBy: 'system',
      updatedBy: 'system'
    };

    // 1. Save shadow state
    await this.projectionRepository.save(projection);

    // 2. Enqueue sync job asynchronously
    await this.syncJobQueue.add('sync_create', {
      internalTaskId,
      operation: 'CREATE',
      traceId: context.traceId
    }, {
      jobId: `sync-create-${internalTaskId}`, // BullMQ deduplication
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });

    RuntimeEventBus.log('CALENDAR_SYNC_ENQUEUED', 'SYSTEM',
      `Enqueued Google Calendar creation for task ${internalTaskId}`,
      context.traceId
    );
  }

  private async handleReminderAcknowledged(event: DomainEvent, context: ExecutionContext): Promise<void> {
    const internalTaskId = event.aggregateId;
    
    const projection = await this.projectionRepository.findByInternalTaskId(internalTaskId);
    if (!projection) {
      return; // No projection to delete/complete
    }

    // 1. Update shadow state
    await this.projectionRepository.updateSyncState(internalTaskId, CalendarSyncState.PENDING_DELETE);

    // 2. Enqueue sync job
    await this.syncJobQueue.add('sync_delete', {
      internalTaskId,
      operation: 'DELETE',
      traceId: context.traceId
    }, {
      jobId: `sync-delete-${internalTaskId}-${projection.version}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
    
    RuntimeEventBus.log('CALENDAR_SYNC_ENQUEUED', 'SYSTEM',
      `Enqueued Google Calendar deletion for acknowledged task ${internalTaskId}`,
      context.traceId
    );
  }
}
