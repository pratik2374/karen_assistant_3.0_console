import { AggregateRoot } from '../shared/core/AggregateRoot.js';
import { DomainEvent } from '../shared/events/DomainEvent.js';
import { EventFactory } from '../shared/events/EventFactory.js';
import { BoundedAutonomyConfigs } from '../shared/core/KarenPrinciples.js';
import { DomainInvariantError } from '../shared/errors/DomainErrors.js';

export class BehaviorAggregate extends AggregateRoot {
  private roastLevel!: number;
  private aggressionLevel!: number;

  private constructor(id: string) {
    super(id);
  }

  static initialize(id: string, traceId: string, correlationId: string): BehaviorAggregate {
    const agg = new BehaviorAggregate(id);
    agg.applyChange(
      EventFactory.create(
        'Behavior.Initialized',
        id,
        'BehaviorAggregate',
        agg.version + 1,
        { roastLevel: 0, aggressionLevel: 0 },
        traceId,
        correlationId
      )
    );
    return agg;
  }

  // --- INVARIANTS ---
  private canIncreaseAggression(): void {
    if (this.aggressionLevel >= BoundedAutonomyConfigs.MAX_ESCALATION_LEVEL) {
      throw new DomainInvariantError('Aggression level cannot exceed safe limits.');
    }
  }

  // --- COMMAND HANDLERS ---
  public increaseAggression(traceId: string, correlationId: string): void {
    this.canIncreaseAggression();

    this.applyChange(
      EventFactory.create(
        'Behavior.AggressionIncreased',
        this.id,
        'BehaviorAggregate',
        this.version + 1,
        { aggressionLevel: this.aggressionLevel + 1 },
        traceId,
        correlationId
      )
    );
  }

  // --- MUTATORS ---
  protected mutate(event: DomainEvent): void {
    switch (event.eventType) {
      case 'Behavior.Initialized':
        this.roastLevel = event.payload.roastLevel;
        this.aggressionLevel = event.payload.aggressionLevel;
        this.incrementVersion();
        break;
      case 'Behavior.AggressionIncreased':
        this.aggressionLevel = event.payload.aggressionLevel;
        this.incrementVersion();
        break;
    }
  }
}
