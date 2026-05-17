import { TaskAggregate } from '../../src/domain/task/TaskAggregate';
import { TimeContext } from '../../src/domain/shared/value-objects/TimeContext';
import { TemporalValidityError } from '../../src/domain/shared/errors/DomainErrors';
import * as crypto from 'crypto';

describe('TaskAggregate', () => {
  it('should reject creation if temporal validity expired', () => {
    const now = new Date();
    const pastExpiry = new Date(now.getTime() - 1000); // 1 second ago

    const timeContext = new TimeContext('UTC', 0, now, now, false);

    expect(() => {
      TaskAggregate.create(crypto.randomUUID(), 'HIGH', {
        traceId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        expiresAt: pastExpiry,
        timeContext
      });
    }).toThrow(TemporalValidityError);
  });

  it('should complete task successfully if valid', () => {
    const now = new Date();
    const futureExpiry = new Date(now.getTime() + 10000);
    const timeContext = new TimeContext('UTC', 0, now, now, false);

    const task = TaskAggregate.create(crypto.randomUUID(), 'HIGH', {
      traceId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      expiresAt: futureExpiry,
      timeContext
    });

    task.complete({
      traceId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      expiresAt: futureExpiry,
      timeContext
    });

    const uncommittedEvents = task.uncommittedEvents;
    expect(uncommittedEvents.length).toBe(2);
    expect(uncommittedEvents[1].eventType).toBe('Task.Completed');
  });
});
