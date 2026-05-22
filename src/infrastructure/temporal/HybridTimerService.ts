import { ITimerStore, TimerRecord } from '../../application/ports/ITimerStore.js';
import { Queue } from 'bullmq';
import { clock } from '../../domain/shared/temporal/SystemClock.js';

export class HybridTimerService {
  constructor(
    private timerStore: ITimerStore,
    private bullmqQueue: Queue
  ) {}

  // 1. Schedules a timer in Mongo (Truth) AND BullMQ (Wakeup)
  public async schedule(timer: TimerRecord): Promise<void> {
    const delay = timer.targetWakeTime.getTime() - clock.now().getTime();
    
    // Save to Mongo first (durability)
    await this.timerStore.save(timer);

    // Push to BullMQ (accelerator)
    if (delay > 0) {
      await this.bullmqQueue.add('timer_wakeup', { timerId: timer.timerId }, {
        jobId: timer.timerId,
        delay
      });
    } else {
      // Immediate execution
      await this.bullmqQueue.add('timer_wakeup', { timerId: timer.timerId }, {
        jobId: timer.timerId
      });
    }
  }

  // 2. Cancels a timer across both systems
  public async cancel(timerId: string): Promise<void> {
    await this.timerStore.cancel(timerId);
    
    const job = await this.bullmqQueue.getJob(timerId);
    if (job) {
      await job.remove();
    }
  }

  // 3. Cancels all pending timers for a specific saga
  public async cancelBySaga(sagaId: string): Promise<void> {
    await this.timerStore.cancelBySaga(sagaId);
    // In BullMQ, we cannot easily query by sagaId. 
    // We rely on the worker to check Mongo status:
    // When the delayed job fires, the worker reads Mongo. If status is CANCELLED, it drops it safely.
  }

  // 4. Called on Application Boot — Reconcile missing BullMQ jobs
  public async reconcileOnBoot(): Promise<void> {
    // Find all timers that are PENDING and in the future
    // We use a distant future date (e.g. 1 year) to get all active timers
    const distantFuture = new Date(clock.now().getTime() + 31536000000);
    const pendingTimers = await this.timerStore.getPendingTimers(distantFuture);
    
    for (const timer of pendingTimers) {
      const job = await this.bullmqQueue.getJob(timer.timerId);
      if (!job) {
        console.log(`[HYBRID TIMER] Reconciling lost timer: ${timer.timerId}`);
        const delay = timer.targetWakeTime.getTime() - clock.now().getTime();
        await this.bullmqQueue.add('timer_wakeup', { timerId: timer.timerId }, {
          jobId: timer.timerId,
          delay: delay > 0 ? delay : 0
        });
      }
    }
  }
}
