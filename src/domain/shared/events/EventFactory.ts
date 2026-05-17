import { DomainEvent } from './DomainEvent';
import * as crypto from 'crypto';

export class EventFactory {
  static create(
    eventType: string,
    aggregateId: string,
    aggregateType: string,
    aggregateVersion: number,
    payload: any,
    traceId: string,
    correlationId: string,
    causationId?: string
  ): DomainEvent {
    return {
      eventId: crypto.randomUUID(),
      eventType,
      eventVersion: 1,
      timestamp: new Date(),
      aggregateId,
      aggregateType,
      aggregateVersion,
      traceId,
      correlationId,
      causationId,
      payload
    };
  }
}
