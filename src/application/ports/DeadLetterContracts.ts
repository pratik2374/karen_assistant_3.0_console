export enum DeadLetterReason {
  INVALID_EVENT_ORDERING = 'INVALID_EVENT_ORDERING',
  MALFORMED_COMMAND = 'MALFORMED_COMMAND',
  IMPOSSIBLE_STATE_TRANSITION = 'IMPOSSIBLE_STATE_TRANSITION',
  STALE_REPLAY_EVENT = 'STALE_REPLAY_EVENT',
  UNHANDLED_EXCEPTION = 'UNHANDLED_EXCEPTION'
}

export enum DeadLetterPolicy {
  DROP = 'DROP',
  ALERT_ADMIN = 'ALERT_ADMIN',
  MANUAL_RETRY_QUEUE = 'MANUAL_RETRY_QUEUE'
}

export interface DeadLetterRecord {
  deadLetterId: string;
  originalPayload: any;
  reason: DeadLetterReason;
  policy: DeadLetterPolicy;
  failedAt: Date;
  traceId: string;
  errorMessage: string;
}

export interface IDeadLetterQueue {
  enqueue(record: DeadLetterRecord): Promise<void>;
}
