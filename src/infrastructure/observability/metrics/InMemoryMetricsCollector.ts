import { IMetricsCollector, ICounter, IGauge, IHistogram } from './IMetricsCollector.js';

class InMemoryCounter implements ICounter {
  private counts: Map<string, number> = new Map();

  increment(labels?: Record<string, string>): void {
    const key = JSON.stringify(labels ?? {});
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  getCount(labels?: Record<string, string>): number {
    return this.counts.get(JSON.stringify(labels ?? {})) ?? 0;
  }
}

class InMemoryGauge implements IGauge {
  private value: number = 0;

  set(value: number): void {
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }
}

class InMemoryHistogram implements IHistogram {
  private observations: number[] = [];

  observe(value: number): void {
    this.observations.push(value);
  }

  getAverage(): number {
    if (this.observations.length === 0) return 0;
    return this.observations.reduce((a, b) => a + b, 0) / this.observations.length;
  }
}

export class InMemoryMetricsCollector implements IMetricsCollector {
  aiTokensUsed = new InMemoryCounter();
  aiRequestLatency = new InMemoryHistogram();
  aiHallucinationRejections = new InMemoryCounter();
  aiSchemaFailures = new InMemoryCounter();
  aiFallbackActivations = new InMemoryCounter();
  queueDepth = new InMemoryGauge();
  deadLetterGrowth = new InMemoryCounter();
  duplicateDetections = new InMemoryCounter();
  consumerLag = new InMemoryGauge();
  circuitBreakerOpenTransitions = new InMemoryCounter();
  circuitBreakerResets = new InMemoryCounter();
  sagaCompensations = new InMemoryCounter();
  sagaTimeouts = new InMemoryCounter();
  permissionDenials = new InMemoryCounter();
  sanitizationRejections = new InMemoryCounter();
  replaySuppressions = new InMemoryCounter();
  aiEstimatedCostUsd = new InMemoryCounter();
}
