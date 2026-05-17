import { RuntimeConfig } from '../config/RuntimeConfig';
import { ConsoleStructuredLogger } from '../../infrastructure/observability/logging/ConsoleStructuredLogger';
import { ConsoleTracer } from '../../infrastructure/observability/tracing/ConsoleTracer';
import { InMemoryMetricsCollector } from '../../infrastructure/observability/metrics/InMemoryMetricsCollector';
import { HealthAggregator } from '../../infrastructure/observability/health/HealthAggregator';
import { HumanOverrideAuditLogger } from '../../infrastructure/observability/audit/HumanOverrideAuditLogger';
import { ReplayObservabilityTracker } from '../../infrastructure/observability/replay/ReplayObservabilityTracker';
import { SagaObservabilityHook } from '../../infrastructure/observability/metrics/SagaObservabilityHook';

export interface ObservabilityModule {
  logger: ConsoleStructuredLogger;
  tracer: ConsoleTracer;
  metrics: InMemoryMetricsCollector;
  health: HealthAggregator;
  auditLogger: HumanOverrideAuditLogger;
  replayTracker: ReplayObservabilityTracker;
  sagaHook: SagaObservabilityHook;
}

export function buildObservabilityModule(config: RuntimeConfig): ObservabilityModule {
  const executionMode = config.EXECUTION_MODE as any;

  // Singletons — one instance shared across the entire process
  const logger = new ConsoleStructuredLogger(executionMode);
  const tracer = new ConsoleTracer();
  const metrics = new InMemoryMetricsCollector();
  const health = new HealthAggregator([]); // Health probes added by other modules
  const auditLogger = new HumanOverrideAuditLogger();
  const replayTracker = new ReplayObservabilityTracker();
  const sagaHook = new SagaObservabilityHook();

  console.log('[OBSERVABILITY] Structured logger, tracer, and metrics wired.');
  return { logger, tracer, metrics, health, auditLogger, replayTracker, sagaHook };
}
