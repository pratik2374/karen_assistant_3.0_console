import { AggregateRoot } from '../shared/core/AggregateRoot';
import { DomainEvent } from '../shared/events/DomainEvent';
import { EventFactory } from '../shared/events/EventFactory';
import { DomainInvariantError } from '../shared/errors/DomainErrors';

export interface ContextProvenance {
  source: string;
  retrievedAt: Date;
  confidence: number;
  retrievalReason: string;
}

export class MemoryAggregate extends AggregateRoot {
  private isProtected!: boolean;
  private expired!: boolean;

  private constructor(id: string) {
    super(id);
  }

  static store(id: string, isProtected: boolean, traceId: string, correlationId: string): MemoryAggregate {
    const memory = new MemoryAggregate(id);
    memory.applyChange(
      EventFactory.create(
        'Memory.Stored',
        id,
        'MemoryAggregate',
        memory.version + 1,
        { isProtected, expired: false },
        traceId,
        correlationId
      )
    );
    return memory;
  }

  // --- INVARIANTS ---
  private canExpire(): void {
    if (this.isProtected) {
      throw new DomainInvariantError('Protected memories cannot auto-expire.');
    }
    if (this.expired) {
      throw new DomainInvariantError('Memory is already expired.');
    }
  }

  // --- COMMAND HANDLERS ---
  public expire(traceId: string, correlationId: string): void {
    this.canExpire();

    this.applyChange(
      EventFactory.create(
        'Memory.Expired',
        this.id,
        'MemoryAggregate',
        this.version + 1,
        { expired: true },
        traceId,
        correlationId
      )
    );
  }

  // Context retrieval strictly requires attaching provenance
  public retrieveContext(reason: string, confidence: number, clockTime: Date): ContextProvenance {
    return {
      source: `MemoryAggregate:${this.id}`,
      retrievedAt: clockTime,
      confidence,
      retrievalReason: reason
    };
  }

  // --- MUTATORS ---
  protected mutate(event: DomainEvent): void {
    switch (event.eventType) {
      case 'Memory.Stored':
        this.isProtected = event.payload.isProtected;
        this.expired = event.payload.expired;
        this.incrementVersion();
        break;
      case 'Memory.Expired':
        this.expired = event.payload.expired;
        this.incrementVersion();
        break;
    }
  }
}
