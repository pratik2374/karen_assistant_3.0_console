// =========================================================================
// RuntimeEventBus — a lightweight in-process pub/sub for console events.
// The API layer, AI runtime, and infrastructure emit here.
// The CLI subscribes and renders events. No persistence, no orchestration.
// =========================================================================

export interface RuntimeEvent {
  type: string;
  category: 'TRANSPORT' | 'AI' | 'COMMAND' | 'SAGA' | 'TIMER' | 'SYSTEM' | 'OUTBOUND' | 'ERROR';
  message: string;
  traceId?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

type EventHandler = (event: RuntimeEvent) => void;

class RuntimeEventBusClass {
  private handlers: EventHandler[] = [];

  public emit(event: RuntimeEvent): void {
    for (const handler of this.handlers) {
      try { handler(event); } catch { /* never crash the runtime for a console error */ }
    }
  }

  public subscribe(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter(h => h !== handler); };
  }

  public log(
    type: string,
    category: RuntimeEvent['category'],
    message: string,
    traceId?: string,
    metadata?: Record<string, any>
  ): void {
    this.emit({ type, category, message, traceId, metadata, timestamp: new Date() });
  }
}

// Singleton exported for use across the entire process
export const RuntimeEventBus = new RuntimeEventBusClass();
