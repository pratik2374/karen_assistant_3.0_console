// @ts-nocheck
import { Worker, Job } from 'bullmq';
import chalk from 'chalk';
import { Redis } from 'ioredis';
import { SagaDispatcher, TimerWakeupResult } from '../../../application/sagas/SagaDispatcher.js';
import { MongoTimerStore } from '../../persistence/mongodb/MongoTimerStore.js';
import { MongoSagaRepository } from '../../persistence/mongodb/MongoSagaRepository.js';
import { TaskMongoRepository } from '../../persistence/mongo/repositories/TaskMongoRepository.js';
import { WhatsAppAdapter } from '../../external/whatsapp/WhatsAppAdapter.js';
import { RedisIdempotencyStore } from '../consumer/RedisIdempotencyStore.js';
import { ExecutionContext } from '../../../composition/context/ExecutionContext.js';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';
import { DomainEvent } from '../../../domain/shared/events/DomainEvent.js';
import { MessageEnvelope } from '../contracts/MessageEnvelope.js';
import { CalendarSyncAgent } from '../../../application/calendar/CalendarSyncAgent.js';

export class BullMQConsumerRegistry {
  private workers: Worker[] = [];

  constructor(
    private redisConnection: Redis,
    private sagaDispatcher: SagaDispatcher,
    private timerStore: MongoTimerStore,
    private sagaRepository: MongoSagaRepository,
    private taskRepository: TaskMongoRepository,
    private whatsappAdapter: WhatsAppAdapter,
    private idempotencyStore: RedisIdempotencyStore,
    private calendarSyncAgent?: CalendarSyncAgent
  ) {}

  public async start(): Promise<void> {
    console.log('[BULLMQ CONSUMERS] Starting event consumers and timer workers...');

    // 1. Timer Wakeup Worker
    const timerWorker = new Worker(
      'timer_wakeup',
      async (job: Job) => {
        try {
          const { timerId } = job.data;
          const pendingTimers = await this.timerStore.getPendingTimers(new Date(Date.now() + 60000));
          const timer = pendingTimers.find(t => t.timerId === timerId);

          if (!timer) {
            // Timer not found or already cancelled/executed
            return;
          }

          if (timer.status !== 'PENDING') {
            return;
          }

          // Mark as executed
          await this.timerStore.markExecuted(timerId);

          RuntimeEventBus.log('TIMER_FIRED', 'TIMER',
            `Wakeup timer fired from BullMQ: timer-${timerId}`,
            timer.traceId,
            { timerId, sagaId: timer.sagaId }
          );

          // Build Execution Context
          const context = new ExecutionContext(
            timer.traceId,
            timer.correlationId,
            'system',
            'system-session',
            ['system:write'],
            'PRODUCTION',
            500000
          );

          // Dispatch wakeup to the correct saga and get stage info for message delivery
          const wakeupResult: TimerWakeupResult | undefined =
            await this.sagaDispatcher.dispatchTimerWakeup(timerId, timer.sagaId, context);

          // For CalendarReminder sagas: send stage-specific WhatsApp message here
          if (wakeupResult?.sagaType === 'CalendarReminder' && wakeupResult.userId && wakeupResult.taskTitle !== undefined) {
            
            const message = this.buildCalendarReminderMessage(wakeupResult);
            
            if (message) {
              console.log(chalk.cyan.bold(`\n==============================================`));
              console.log(chalk.cyan.bold(`🔔 REMINDER ESCALATION [STAGE ${wakeupResult.messageStage}]`));
              console.log(chalk.cyan(`   Task: ${wakeupResult.taskTitle}`));
              console.log(chalk.cyan(`   Message:`));
              console.log(chalk.cyan(`   ${message}`));
              console.log(chalk.cyan.bold(`==============================================\n`));
              
              await this.whatsappAdapter.sendMessage(
                { to: wakeupResult.userId, body: message, idempotencyKey: `cal-reminder-${timerId}` },
                false, false
              );
              RuntimeEventBus.log('CALENDAR_REMINDER_SENT', 'OUTBOUND',
                `Stage ${wakeupResult.messageStage} reminder sent to ${wakeupResult.userId}: "${wakeupResult.taskTitle}"`,
                timer.traceId
              );
            }
          }
        } catch (error: any) {
          console.error(chalk.red(`[BULLMQ TIMER WORKER] Silent crash detected: ${error.message}`), error);
          RuntimeEventBus.log('TIMER_EXECUTION_FAILED', 'ERROR', `Timer worker failed silently: ${error.message}`);
          throw error;
        }
      },
      { connection: this.redisConnection }
    );
    this.workers.push(timerWorker);

    // 2. Domain Events Workers for each Queue priority
    const QUEUE_NAMES = ['CRITICAL', 'HIGH', 'LOW', 'LOWEST'];
    for (const queueName of QUEUE_NAMES) {
      const eventWorker = new Worker(
        queueName,
        async (job: Job) => {
          const envelope = job.data as MessageEnvelope<any>;
          const event = envelope.payload as DomainEvent;

          if (!event || !event.eventType) return;

          // Check Idempotency Store
          const dedupKey = `${envelope.aggregateType}:${envelope.aggregateId}:${envelope.eventId}`;
          const isProcessed = await this.idempotencyStore.checkAndSetProcessing(dedupKey);
          
          // Replay check
          if (envelope.replayed && !envelope.replaySafe) {
            console.warn(`[BULLMQ CONSUMERS] Dropping replayed event: ${dedupKey}`);
            return;
          }

          try {
            // Build execution context
            const context = new ExecutionContext(
              envelope.traceId,
              envelope.correlationId,
              'system',
              'system-session',
              ['system:write'],
              'PRODUCTION',
              500000,
              envelope.causationId
            );

            // Handle domain-specific events
            if (event.eventType === 'Task.Created' || event.eventType === 'Reminder.Acknowledged') {
              await this.sagaDispatcher.dispatchEvent(event, context);
              if (this.calendarSyncAgent) {
                await this.calendarSyncAgent.processDomainEvent(event, context);
              }
            } else if (event.eventType === 'Reminder.Escalated') {
              // Manual reminder escalation (ReminderEscalationSaga)
              if (this.calendarSyncAgent) {
                await this.calendarSyncAgent.processDomainEvent(event, context);
              }
              const sagaId = `saga-reminder-${event.payload.taskId}`;
              const sagaSnapshot = await this.sagaRepository.findById(sagaId);

              const userId = sagaSnapshot?.payloadData?.userId || '917439707352';
              const taskTitle = sagaSnapshot?.payloadData?.taskTitle || 'Reminder';

              const escalationCount = event.payload.escalationCount || 1;
              let text = '';
              
              if (escalationCount === 1) {
                text = `🎙️ *Karen Alert*\n\nHey! Just a quick heads-up, it's time for: *${taskTitle}*.`;
              } else if (escalationCount === 2) {
                text = `🎙️ *Karen Alert*\n\nI'm back! Just checking if you started: *${taskTitle}*. No pressure, but just a friendly nudge.`;
              } else {
                text = `🎙️ *Karen Alert*\n\nFinal reminder for: *${taskTitle}*! Time to get moving!`;
              }

              RuntimeEventBus.log('REMINDER_OUTBOUND', 'OUTBOUND',
                `Delivering WhatsApp reminder to ${userId}: "${taskTitle}"`,
                event.traceId, { userId, taskId: event.payload.taskId }
              );
              await this.whatsappAdapter.sendMessage(
                { to: userId, body: text, idempotencyKey: `reminder-${event.eventId}` },
                false, false
              );

            } else if (event.eventType === 'Task.Snoozed') {
              // Route snooze to saga dispatcher
              await this.sagaDispatcher.dispatchEvent(event, context);
            }

            // Mark event as processed
            await this.idempotencyStore.markProcessed(dedupKey);
          } catch (error: any) {
            await this.idempotencyStore.markFailed(dedupKey);
            console.error(`[BULLMQ CONSUMERS] Event execution failed: ${error.message}`);
            throw error; // Propagate for retry
          }
        },
        { connection: this.redisConnection }
      );
      this.workers.push(eventWorker);
    }

    console.log('[BULLMQ CONSUMERS] Workers successfully listening to event and timer streams.');
  }

  public async stop(): Promise<void> {
    for (const worker of this.workers) {
      await worker.close();
    }
    this.workers = [];
  }

  private buildCalendarReminderMessage(result: TimerWakeupResult): string | null {
    const title = result.taskTitle || 'your event';
    switch (result.messageStage) {
      case 0: // PRE_ALERT
        return `🎙️ *Karen | Heads Up*\n\nHey — *${title}* starts in 10 minutes. Wrap up what you're doing!\n\n_Reply *started* when you begin, or *snooze 15* to push it back._`;
      case 1: // WAITING_START
        return `🎙️ *Karen | Check-in*\n\nHey, *${title}* was scheduled to start 15 minutes ago. Did you get going?\n\n_Reply *started* to mark it done, or *snooze 15* to reschedule._`;
      case 2: // EMOTIONAL_NUDGE
        return `🎙️ *Karen | Just between us*\n\nYou've been building something real. Don't let *${title}* quietly slip today.\n\nYour streak, your consistency, your future self — they're all watching.\n\n_Reply *started* whenever you're ready. I'll be here._`;
      default:
        return null;
    }
  }
}

