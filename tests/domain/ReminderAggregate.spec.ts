import { ReminderAggregate } from '../../src/domain/reminder/ReminderAggregate';
import { TimeContext } from '../../src/domain/shared/value-objects/TimeContext';
import { DndViolationError, DomainInvariantError } from '../../src/domain/shared/errors/DomainErrors';
import * as crypto from 'crypto';

describe('ReminderAggregate', () => {
  let traceId: string;
  let correlationId: string;
  let taskId: string;

  beforeEach(() => {
    traceId = crypto.randomUUID();
    correlationId = crypto.randomUUID();
    taskId = crypto.randomUUID();
  });

  const createSafeTimeContext = () => new TimeContext('UTC', 0, new Date(), new Date(), false);
  const createDndTimeContext = () => new TimeContext('UTC', 0, new Date(), new Date(), true);

  it('should escalate reminder through proper states', () => {
    const reminder = ReminderAggregate.initialize(crypto.randomUUID(), taskId, traceId, correlationId);
    
    // Escalate 1: PENDING -> SENT
    reminder.escalate({ taskId, timeContext: createSafeTimeContext(), traceId, correlationId });
    // Escalate 2: SENT -> FOLLOWUP_1
    reminder.escalate({ taskId, timeContext: createSafeTimeContext(), traceId, correlationId });
    // Escalate 3: FOLLOWUP_1 -> FOLLOWUP_2
    reminder.escalate({ taskId, timeContext: createSafeTimeContext(), traceId, correlationId });
    
    // Escalate 4: Should throw DomainInvariantError (Max Escalation Reached)
    expect(() => {
      reminder.escalate({ taskId, timeContext: createSafeTimeContext(), traceId, correlationId });
    }).toThrow(DomainInvariantError);
  });

  it('should throw DndViolationError if escalated during DND', () => {
    const reminder = ReminderAggregate.initialize(crypto.randomUUID(), taskId, traceId, correlationId);
    
    expect(() => {
      reminder.escalate({ taskId, timeContext: createDndTimeContext(), traceId, correlationId });
    }).toThrow(DndViolationError);
  });

  it('should not allow escalation after acknowledgment', () => {
    const reminder = ReminderAggregate.initialize(crypto.randomUUID(), taskId, traceId, correlationId);
    reminder.escalate({ taskId, timeContext: createSafeTimeContext(), traceId, correlationId });
    
    reminder.acknowledge(traceId, correlationId);

    expect(() => {
      reminder.escalate({ taskId, timeContext: createSafeTimeContext(), traceId, correlationId });
    }).toThrow(DomainInvariantError);
  });
});
