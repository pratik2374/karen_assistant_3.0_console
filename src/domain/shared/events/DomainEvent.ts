export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly timestamp: Date;
  
  // Aggregate Metadata
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateVersion: number;

  // Provenance & Tracing
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string;

  readonly payload: any;
}
