import { DomainEvent } from '../../domain/shared/events/DomainEvent.js';

// Process Managers OBSERVE workflows and track state/analytics, but DO NOT dispatch orchestration commands.
export abstract class ProcessManagerBase<TState> {
  public state: TState;
  public readonly managerId: string;

  constructor(managerId: string, initialState: TState) {
    this.managerId = managerId;
    this.state = initialState;
  }

  public handleEvent(event: DomainEvent): void {
    if (this.canHandle(event)) {
      this.mutate(event);
    }
  }

  protected abstract canHandle(event: DomainEvent): boolean;
  protected abstract mutate(event: DomainEvent): void;
}
