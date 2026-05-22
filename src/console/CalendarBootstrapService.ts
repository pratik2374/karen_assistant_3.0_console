// @ts-nocheck
import { CalendarTool } from '../tools/calendar/CalendarTool.js';
import { CalendarProjectionMongoRepository } from '../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js';
import { MemoryService } from '../application/ai/memory/MemoryService.js';
import { CalendarSyncState } from '../domain/calendar/CalendarEventProjection.js';
import { TaskMongoRepository } from '../infrastructure/persistence/mongo/repositories/TaskMongoRepository.js';
import { IOutboxStore } from '../application/ports/IOutboxStore.js';
import { TaskAggregate } from '../domain/task/TaskAggregate.js';
import { TimeContext } from '../domain/shared/value-objects/TimeContext.js';
import { randomUUID } from 'crypto';
import { RuntimeEventBus } from './RuntimeEventBus.js';
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// CalendarBootstrapService
//
// Responsibilities:
//  1. On startup: fetch TODAY's Google Calendar events, create Tasks + sagas
//     for any event that doesn't already have one (idempotent).
//  2. Every 15 minutes: poll for new events added during the day.
//  3. At 12:01 AM midnight every night: fetch next day's events automatically.
//
// Detection of already-scheduled events: checks `calendar_event_projection`
// for existing googleEventId. If found → skip. Otherwise → create Task +
// emit Task.Created with sourceType='calendar_sync'.
// ─────────────────────────────────────────────────────────────────────────────

export class CalendarBootstrapService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private midnightTimeout: NodeJS.Timeout | null = null;

  constructor(
    private calendarTool: CalendarTool,
    private projectionRepo: CalendarProjectionMongoRepository,
    private taskRepo: TaskMongoRepository,
    private outboxStore: IOutboxStore,
    private memoryService?: MemoryService
  ) {}

  /** Called once on startup. Syncs today's events and starts recurring jobs. */
  public async initialize(userId: string): Promise<void> {
    try {
      // 1. Sync today immediately on startup
      await this.syncDay(userId, new Date());

      // 2. Subscribe to system calendar mutations to trigger immediate sync
      RuntimeEventBus.subscribe((event) => {
        if (event.type === 'CALENDAR_MUTATION_COMPLETED') {
          RuntimeEventBus.log('CALENDAR_SYNC_TRIGGERED', 'SYSTEM',
            `System calendar mutation detected. Polling Google Calendar at 5s, 15s, and 30s for eventual consistency...`,
            event.traceId
          );
          
          [5000, 15000, 30000].forEach(delay => {
            setTimeout(async () => {
              await this.syncDay(userId, new Date()).catch(err => {
                console.error(`[SYNC ERROR] Immediate sync after mutation failed:`, err);
                RuntimeEventBus.log('CALENDAR_POLL_ERROR', 'ERROR', `Immediate sync after mutation failed: ${err.message}`, 'poll');
              });
            }, delay);
          });
        }

        // Handle manual fast-track event creation
        if (event.type === 'CALENDAR_EVENT_CREATED_MANUALLY') {
          const { title, start, end, userId } = event.metadata || {};
          if (title && start && userId) {
            this.createReminderForManualEvent(title, new Date(start), end ? new Date(end) : undefined, userId, event.traceId || randomUUID()).catch(err => {
              console.error(`[SYNC ERROR] Manual reminder creation failed:`, err);
            });
          }
        }
      });

      // 3. Poll every 15 minutes to catch newly added events
      this.pollingInterval = setInterval(async () => {
        await this.syncDay(userId, new Date()).catch(err =>
          RuntimeEventBus.log('CALENDAR_POLL_ERROR', 'ERROR', `15-min poll failed: ${err.message}`, 'poll')
        );
      }, 15 * 60 * 1000);

      // 4. Schedule midnight cron for next day sync
      this.scheduleMidnightSync(userId);

      RuntimeEventBus.log('CALENDAR_BOOTSTRAP_READY', 'SYSTEM',
        'CalendarBootstrapService initialized: startup sync done, polling active.', 'bootstrap'
      );
    } catch (err: any) {
      RuntimeEventBus.log('CALENDAR_BOOTSTRAP_ERROR', 'ERROR',
        `CalendarBootstrapService initialization failed: ${err.message}`, 'bootstrap'
      );
    }
  }

  /** Fetch and sync all events for a given calendar day. Idempotent. */
  public async syncDay(userId: string, date: Date): Promise<number> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const toolResult = await this.calendarTool.listEvents({
      userId: 'karen',
      payload: {},
      traceId: randomUUID(),
      correlationId: randomUUID(),
      isReplay: false,
      isSandbox: !process.env.COMPOSIO_API_KEY,
      idempotencyKey: `day-sync-${dayStart.toDateString()}`,
      timeMin: dayStart,
      timeMax: dayEnd,
    });

    const events = toolResult.success ? (toolResult.data ?? []) : [];
    let createdCount = 0;

    for (const evt of events) {
      if (!evt.id || !evt.start?.dateTime) continue;

      // Skip if already tracked AND a task exists
      const existing = await this.projectionRepo.findByGoogleEventId(evt.id);
      if (existing) {
        const taskExists = await this.taskRepo.findById(existing.internalTaskId);
        if (taskExists) {
          continue;
        }
      }

      // Try to resolve collisions for manually created tasks
      // Try to resolve collisions for manually created tasks
      const eventStart = new Date(evt.start.dateTime || evt.start.date || new Date().toISOString());
      const collision = await this.projectionRepo.findByTitleAndStartTime(evt.summary || 'Untitled', eventStart);
      if (collision && !collision.googleEventId) {
        console.log(`[SYNC] Collision resolved for "${evt.summary}"! Linking to googleEventId: ${evt.id}`);
        await this.projectionRepo.updateGoogleEventId(collision.internalTaskId, evt.id);
        continue;
      }

      // Skip events whose final escalation window (start + 25 mins) has already passed
      const obsoleteTime = new Date(eventStart.getTime() + 25 * 60 * 1000);
      if (obsoleteTime <= new Date()) {
        console.log(`[SYNC] Skipping obsolete event "${evt.summary}"`);
        RuntimeEventBus.log('CALENDAR_BOOTSTRAP_SKIP', 'SYSTEM',
          `Skipping obsolete event "${evt.summary}" (started ${eventStart.toISOString()})`, 'bootstrap'
        );
        continue;
      }

      console.log(`[SYNC] Tracking new event "${evt.summary}" starting at ${eventStart.toISOString()}`);
      
      const internalId = existing ? existing.internalTaskId : randomUUID();
      const traceId = randomUUID();
      const correlationId = randomUUID();

      // 1. Save projection (shadow state)
      const endTime = evt.end?.dateTime ? new Date(evt.end.dateTime) : new Date(eventStart.getTime() + 30 * 60 * 1000);
      await this.projectionRepo.save({
        internalTaskId: internalId,
        googleEventId: evt.id,
        calendarId: 'primary',
        title: evt.summary || 'Calendar Event',
        description: evt.description,
        startTime: eventStart,
        endTime,
        timezone: evt.start?.timeZone || 'Asia/Kolkata',
        syncState: CalendarSyncState.SYNCED,
        lastInternalMutationAt: new Date(),
        replaySafe: true,
        version: existing ? existing.version + 1 : 1,
        createdBy: 'calendar_bootstrap',
        updatedBy: 'calendar_bootstrap'
      });

      // 2. Create TaskAggregate
      try {
        const timeCtx = new TimeContext('Asia/Kolkata', 330, new Date(), new Date(), false);
        const task = TaskAggregate.create(
          internalId,
          'high',
          evt.summary || 'Calendar Event',
          eventStart,
          userId,
          { traceId, correlationId, expiresAt: eventStart, timeContext: timeCtx }
        );
        await this.taskRepo.save(task);

        // 3. Emit Task.Created with sourceType='calendar_sync'
        const createdEvent = task.uncommittedEvents[0];
        if (createdEvent) {
          const outboxMessage = {
            messageId: randomUUID(),
            eventType: 'Task.Created',
            payload: {
              ...createdEvent,
              payload: {
                ...createdEvent.payload,
                sourceType: 'calendar_sync',
                googleEventId: evt.id,
              }
            },
            createdAt: new Date(),
            processedAt: null,
            idempotencyKey: `calendar-bootstrap-${internalId}`,
            deduplicationKey: `${internalId}:Task.Created:1`,
            replaySafe: false,
            sideEffectFree: false,
            traceId,
            correlationId,
            causationId: 'calendar_bootstrap'
          };
          
          await this.outboxStore.saveBulk([outboxMessage]);
          createdCount++;

          const timeStr = eventStart.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
          console.log(`[CalendarBootstrap] 📅 Reminder scheduled for "${evt.summary}" at ${timeStr} IST — 3-stage escalation armed.`);
          
          RuntimeEventBus.log('CALENDAR_REMINDER_ARMED', 'SYSTEM',
            `New reminder scheduled for "${evt.summary}" at ${timeStr} IST — 3-stage escalation armed.`,
            traceId,
            { taskId: internalId, googleEventId: evt.id, summary: evt.summary, startTime: eventStart }
          );
        }
      } catch (error: any) {
        console.warn(`[SYNC WARNING] Failed to create TaskAggregate for "${evt.summary}": ${error.message}`);
        RuntimeEventBus.log('CALENDAR_TASK_CREATION_FAILED', 'ERROR',
          `Failed to create task for "${evt.summary}": ${error.message}`, traceId
        );
      }
    }

    if (createdCount > 0 || events.length > 0) {
      console.log(chalk.green(
        `[CalendarBootstrap] ${date.toDateString()}: ${events.length} events found, ${createdCount} new reminders created.`
      ));
    }
    
    RuntimeEventBus.log('CALENDAR_SYNC_COMPLETED', 'SYSTEM',
      `${date.toDateString()}: ${events.length} events found, ${createdCount} new reminders created.`,
      'bootstrap'
    );

    // Update memory context with today's events
    if (this.memoryService && events.length > 0) {
      const contextBlock = `Google Calendar Events for ${date.toDateString()}:\n` +
        events.map((e: any) => `- ${e.summary} at ${e.start?.dateTime || e.start?.date}`).join('\n');
      await this.memoryService.saveMessageAndRetrievedPastContext(
        'system', 'assistant', contextBlock, `calendar-sync-${Date.now()}`, randomUUID()
      ).catch(() => {});
    }

    return createdCount;
  }

  /** Schedules a one-shot timer that fires at 12:01 AM, then recurses. */
  private scheduleMidnightSync(userId: string): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 1, 0, 0); // 12:01 AM next day

    const msUntilMidnight = midnight.getTime() - now.getTime();

    this.midnightTimeout = setTimeout(async () => {
      RuntimeEventBus.log('CALENDAR_MIDNIGHT_SYNC', 'SYSTEM',
        `Midnight cron firing — syncing ${midnight.toDateString()}`, 'cron'
      );
      await this.syncDay(userId, midnight).catch(err =>
        RuntimeEventBus.log('CALENDAR_MIDNIGHT_ERROR', 'ERROR', `Midnight sync failed: ${err.message}`, 'cron')
      );
      // Schedule next midnight
      this.scheduleMidnightSync(userId);
    }, msUntilMidnight);

    RuntimeEventBus.log('CALENDAR_MIDNIGHT_SCHEDULED', 'SYSTEM',
      `Next midnight sync in ${Math.round(msUntilMidnight / 60000)} minutes`, 'bootstrap'
    );
  }

  // ── Manual Event Fast-Tracking ────────────────────────────────────────────

  public async createReminderForManualEvent(title: string, startTime: Date, endTime: Date | undefined, userId: string, traceId: string): Promise<void> {
    const existing = await this.projectionRepo.findByTitleAndStartTime(title, startTime);
    if (existing) {
      console.log(`[SYNC] Manual event fast-track skipped: projection already exists for "${title}"`);
      return;
    }

    console.log(`[SYNC] Fast-tracking manual reminder for "${title}" starting at ${startTime.toISOString()}`);

    const internalId = randomUUID();
    const correlationId = randomUUID();

    // 1. Save projection (shadow state) without googleEventId
    await this.projectionRepo.save({
      internalTaskId: internalId,
      googleEventId: null as any,
      calendarId: 'primary',
      title: title,
      description: undefined,
      startTime: startTime,
      endTime: endTime || new Date(startTime.getTime() + 60 * 60 * 1000),
      timezone: 'Asia/Kolkata',
      syncState: CalendarSyncState.SYNCED, // Marked as synced so it isn't picked up by old SyncWorkers
      replaySafe: true,
      createdBy: 'system_sync_manual',
      updatedBy: 'system_sync_manual'
    });

    // 2. Create TaskAggregate
    const timeCtx = new TimeContext('Asia/Kolkata', 330, new Date(), new Date(), false);
    const task = TaskAggregate.create(
      internalId,
      'high',
      title,
      startTime,
      userId,
      { traceId, correlationId, expiresAt: startTime, timeContext: timeCtx }
    );
    await this.taskRepo.save(task);

    // 3. Emit Task.Created with sourceType='calendar_sync'
    const createdEvent = task.uncommittedEvents[0];
    if (createdEvent) {
      const outboxMessage = {
        messageId: randomUUID(),
        eventType: 'Task.Created',
        payload: {
          ...createdEvent,
          payload: {
            ...createdEvent.payload,
            sourceType: 'calendar_sync',
            googleEventId: null,
          }
        },
        createdAt: new Date(),
        processedAt: null,
        idempotencyKey: `calendar-bootstrap-manual-${internalId}`,
        deduplicationKey: `${internalId}:Task.Created:1`,
        replaySafe: false,
        sideEffectFree: false,
        traceId,
        correlationId,
        causationId: 'calendar_bootstrap_manual'
      };
      await this.outboxStore.saveBulk([outboxMessage]);
    }

    const timeStr = startTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    console.log(`[CalendarBootstrap] 📅 Fast-track reminder scheduled for "${title}" at ${timeStr} IST — 3-stage escalation armed.`);

    RuntimeEventBus.log('CALENDAR_REMINDER_ARMED_MANUAL', 'SYSTEM',
      `Manual fast-track reminder scheduled for "${title}" at ${timeStr} IST — 3-stage escalation armed.`,
      traceId,
      { taskId: internalId, summary: title, startTime: startTime }
    );
  }

  public stop(): void {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    if (this.midnightTimeout) clearTimeout(this.midnightTimeout);
  }
}
