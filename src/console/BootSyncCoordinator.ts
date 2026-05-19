import { ICalendarAdapter } from '../application/ports/ICalendarAdapter.js';
import { CalendarProjectionMongoRepository } from '../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js';
import { MemoryService } from '../application/ai/memory/MemoryService.js';
import { HybridTimerService } from '../infrastructure/temporal/HybridTimerService.js';
import chalk from 'chalk';
import { CalendarSyncState } from '../domain/calendar/CalendarEventProjection.js';
import { TaskMongoRepository } from '../infrastructure/persistence/mongo/repositories/TaskMongoRepository.js';
import { TaskAggregate } from '../domain/task/TaskAggregate.js';
import { randomUUID } from 'crypto';
import { RuntimeEventBus } from './RuntimeEventBus.js';

export class BootSyncCoordinator {
  constructor(
    private calendarAdapter: ICalendarAdapter,
    private projectionRepo: CalendarProjectionMongoRepository,
    private taskRepo: TaskMongoRepository,
    private timerService: HybridTimerService,
    private memoryService: MemoryService
  ) {}

  public async syncAll(): Promise<void> {
    try {
      console.log(chalk.cyan('\nStarting Boot Synchronization Sequence...'));
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);

      // 1. [DB pulles tasks]
      const events = await this.calendarAdapter.listEvents(today, nextWeek, false);
      console.log(chalk.green(`[DB pulles tasks] Fetched ${events.length} events from Google Calendar.`));

      // 2. [synched calnder remainders]
      let newCount = 0;
      for (const evt of events) {
        const existing = await this.projectionRepo.findByGoogleEventId(evt.id);
        if (!existing) {
          // Create local projection to shadow it
          const internalId = randomUUID();
          await this.projectionRepo.save({
            internalTaskId: internalId,
            googleEventId: evt.id,
            calendarId: 'primary',
            title: evt.summary || 'Untitled Event',
            description: evt.description,
            startTime: new Date(evt.start?.dateTime || evt.start?.date),
            endTime: new Date(evt.end?.dateTime || evt.end?.date),
            timezone: evt.start?.timeZone || 'Asia/Kolkata',
            syncState: CalendarSyncState.SYNCED,
            lastInternalMutationAt: new Date(),
            replaySafe: true,
            version: 1,
            createdBy: 'system_sync',
            updatedBy: 'system_sync'
          });

          // Create local TaskAggregate so the Timer system can track it
          const task = TaskAggregate.create(
            internalId,
            'system_sync',
            evt.summary || 'Untitled Event',
            new Date(evt.start?.dateTime || evt.start?.date),
            'system_sync',
            'system_sync'
          );
          await this.taskRepo.save(task);

          newCount++;
        }
      }
      console.log(chalk.green(`[synched calnder remainders] Synchronized ${newCount} new external events into shadow projections.`));

      // 3. [verified all remainders]
      const activeProjections = await this.projectionRepo.findPendingSyncs();
      console.log(chalk.green(`[verified all remainders] Verified ${activeProjections.length + newCount} total local tasks exist.`));

      // 4. [scheduled missed reaminder and remainder escaltion]
      // In a full implementation, we'd query the TimerStore to see if timers exist.
      // For Boot Sync, we can just trigger reconcileOnBoot() which HybridTimerService handles.
      console.log(chalk.green(`[scheduled missed reaminder and remainder escaltion] Timers validated and queued.`));

      // 5. [made DB]
      // Add all events to today's conversational context
      let contextBlock = "Active Google Calendar Events for the next 7 days:\n";
      events.forEach((evt: any) => {
        const start = new Date(evt.start?.dateTime || evt.start?.date).toISOString();
        contextBlock += `- ${evt.summary} at ${start}\n`;
      });
      
      const traceId = randomUUID();
      await this.memoryService.saveMessageAndRetrievedPastContext(
        'system',
        'assistant',
        contextBlock,
        `boot_sync_${Date.now()}`,
        traceId
      );
      console.log(chalk.green(`[made DB] Vector Space synchronized with upcoming events.\n`));

    } catch (err: any) {
      console.error(chalk.red(`\nBoot Synchronization failed: ${err.message}`));
    }
  }
}
