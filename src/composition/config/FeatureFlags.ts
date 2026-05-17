import { RuntimeConfig } from '../config/RuntimeConfig';

// Runtime feature flags — checked at execution time, not boot time.
// Allows toggling behavior without redeploying the service.
export class FeatureFlags {
  constructor(private config: RuntimeConfig) {}

  get proactiveModeEnabled(): boolean {
    return this.config.FEATURE_PROACTIVE_MODE;
  }

  get reflectionAgentEnabled(): boolean {
    return this.config.FEATURE_REFLECTION_AGENT;
  }

  get adaptiveBehaviorEnabled(): boolean {
    return this.config.FEATURE_ADAPTIVE_BEHAVIOR;
  }

  get replayToolingEnabled(): boolean {
    return this.config.FEATURE_REPLAY_TOOLING;
  }
}
