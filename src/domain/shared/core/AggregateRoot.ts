import { DomainEvent } from '../events/DomainEvent';

export abstract class AggregateRoot {
  protected _id: string;
  protected _version: number;
  protected _lastUpdatedAt: Date;
  
  private _uncommittedEvents: DomainEvent[] = [];

  constructor(id: string) {
    this._id = id;
    this._version = 0;
    this._lastUpdatedAt = new Date();
  }

  get id(): string {
    return this._id;
  }

  get version(): number {
    return this._version;
  }

  get uncommittedEvents(): DomainEvent[] {
    return [...this._uncommittedEvents];
  }

  clearEvents(): void {
    this._uncommittedEvents = [];
  }

  protected applyChange(event: DomainEvent, isNew: boolean = true): void {
    this.mutate(event);
    if (isNew) {
      this._uncommittedEvents.push(event);
    }
  }

  protected incrementVersion(): void {
    this._version += 1;
    this._lastUpdatedAt = new Date();
  }

  // Each concrete aggregate must implement how it mutates state given an event
  protected abstract mutate(event: DomainEvent): void;

  // Rehydrate the aggregate from historical events
  public loadFromHistory(events: DomainEvent[]): void {
    for (const event of events) {
      this.mutate(event);
      this._version = event.aggregateVersion;
    }
  }
}
