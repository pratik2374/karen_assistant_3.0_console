import { ITracer, ISpan, SpanContext } from './ITracer.js';
import { randomUUID } from 'crypto';

class ConsoleSpan implements ISpan {
  public spanId: string;
  private attributes: Record<string, any> = {};

  constructor(
    private operationName: string,
    private traceId: string,
    private startTime: number
  ) {
    this.spanId = randomUUID();
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  setStatus(status: 'OK' | 'ERROR', message?: string): void {
    this.attributes['_status'] = status;
    if (message) this.attributes['_statusMessage'] = message;
  }

  end(): void {
    const durationMs = Date.now() - this.startTime;
    // Structured span output — compatible with log ingestion pipelines
    console.log(JSON.stringify({
      type: 'SPAN',
      operation: this.operationName,
      traceId: this.traceId,
      spanId: this.spanId,
      durationMs,
      ...this.attributes,
      timestamp: new Date().toISOString()
    }));
  }
}

export class ConsoleTracer implements ITracer {
  startSpan(operationName: string, parentContext?: SpanContext): ISpan {
    const traceId = parentContext?.traceId ?? randomUUID();
    return new ConsoleSpan(operationName, traceId, Date.now());
  }

  injectContext(span: ISpan): SpanContext {
    return {
      traceId: randomUUID(), // Would extract from real OTEL span in production
      spanId: span.spanId,
      correlationId: randomUUID()
    };
  }
}
