import { IStructuredLogger, StructuredLogEntry, ExecutionMode, LogLevel } from './IStructuredLogger.js';
import { TelemetryBackpressure } from '../telemetry/TelemetryBackpressure.js';

export class ConsoleStructuredLogger implements IStructuredLogger {
  private backpressure = new TelemetryBackpressure({ maxEventsPerSecond: 500, sampleRateIfThrottled: 0.01 });

  constructor(private defaultMode: ExecutionMode = 'PRODUCTION') {}

  private emit(level: LogLevel, message: string, context: Partial<StructuredLogEntry>): void {
    // Drop logs safely if we are exceeding I/O budget (except ERROR/SECURITY)
    if (level !== 'ERROR' && level !== 'SECURITY' && !this.backpressure.shouldEmit()) {
      return;
    }

    const entry: StructuredLogEntry = {
      traceId: context.traceId ?? 'untraced',
      correlationId: context.correlationId ?? 'uncorrelated',
      level,
      message,
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      executionMode: context.executionMode ?? this.defaultMode,
      ...context
    };
    console.log(JSON.stringify(entry));
  }

  info(message: string, context: Partial<StructuredLogEntry>): void {
    this.emit('INFO', message, context);
  }

  warn(message: string, context: Partial<StructuredLogEntry>): void {
    this.emit('WARN', message, context);
  }

  error(message: string, context: Partial<StructuredLogEntry>): void {
    this.emit('ERROR', message, context);
  }

  security(message: string, context: Partial<StructuredLogEntry>): void {
    this.emit('SECURITY', message, context);
  }
}
