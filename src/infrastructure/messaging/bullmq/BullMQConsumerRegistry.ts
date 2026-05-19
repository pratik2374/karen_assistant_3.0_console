import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { SagaDispatcher } from '../../../application/sagas/SagaDispatcher';
import { MongoTimerStore } from '../persistence/mongodb/MongoTimerStore';
import { MongoSagaRepository } from '../persistence/mongodb/MongoSagaRepository';
import { TaskMongoRepository } from '../persistence/mongo/repositories/TaskMongoRepository';
import { WhatsAppAdapter } from '../../external/whatsapp/WhatsAppAdapter';
import { RedisIdempotencyStore } from '../messaging/consumer/RedisIdempotencyStore';
import { ExecutionContext } from '../../../composition/context/ExecutionContext';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus';
import { DomainEvent } from '../../../domain/shared/events/DomainEvent';
import { MessageEnvelope } from '../contracts/MessageEnvelope';

export class BullMQConsumerRegistry {
  private workers: Worker[] = [];

  constructor(
    private redisConnection: Redis,
    private sagaDispatcher: SagaDispatcher,
    private timerStore: MongoTimerStore,
    private sagaRepository: MongoSagaRepository,
    private taskRepository: TaskMongoRepository,
    private whatsappAdapter: WhatsAppAdapter,
    private idempotencyStore: RedisIdempotencyStore
  ) {}

  public async start(): Promise<void> {
    console.log('[BULLMQ CONSUMERS] Starting event consumers and timer workers...');

    // 1. Timer Wakeup Worker
    const timerWorker = new Worker(
      'timer_wakeup',
      async (job: Job) => {
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

        // Dispatch wakeup to the saga!
        await this.sagaDispatcher.dispatchTimerWakeup(timerId, timer.sagaId, context);
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
            } else if (event.eventType === 'Reminder.Escalated') {
              // Physical Outbound Send Integration!
              const sagaId = `saga-reminder-${event.payload.taskId}`;
              const sagaSnapshot = await this.sagaRepository.findById(sagaId);
              
              const userId = sagaSnapshot?.payloadData?.userId || '917439707352';
              const taskTitle = sagaSnapshot?.payloadData?.taskTitle || 'Reminder';

              const wakePhrases = [
                `"Hey! Just a quick heads-up, it's time for: *${taskTitle}*."`,
                `"Pardon the interruption, but you asked me to remind you to: *${taskTitle}*."`,
                `"Time to get moving! It's time for: *${taskTitle}*."`,
                `"Hey, don't pretend you forgot—it's time to: *${taskTitle}*!"`
              ];
              const text = `🎙️ *Karen Alert*\n\n${wakePhrases[Math.floor(Math.random() * wakePhrases.length)]}`;

              RuntimeEventBus.log('REMINDER_OUTBOUND', 'OUTBOUND',
                `Delivering physical WhatsApp reminder to ${userId}: "${taskTitle}"`,
                event.traceId,
                { userId, taskId: event.payload.taskId }
              );

              // Physically deliver through the overhauled Graph API WhatsAppAdapter!
              const msg = {
                to: userId,
                body: text,
                idempotencyKey: `reminder-${event.eventId}`
              };
              await this.whatsappAdapter.sendMessage(msg, false, false);
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
}
