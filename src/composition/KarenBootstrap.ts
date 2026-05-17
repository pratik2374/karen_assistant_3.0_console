import { loadRuntimeConfig } from './config/RuntimeConfig';
import { FeatureFlags } from './config/FeatureFlags';
import { buildPersistenceModule } from './modules/persistence.module';
import { buildMessagingModule } from './modules/messaging.module';
import { buildObservabilityModule } from './modules/observability.module';
import { buildAIModule } from './modules/ai.module';
import { StartupValidator } from './lifecycle/StartupValidator';
import { GracefulShutdown } from './lifecycle/GracefulShutdown';
import { createApp } from '../api/v1/app';

// =====================================================================
// KarenBootstrap — THE ONLY PLACE concrete implementations are assembled.
// No other module may call new MongoClient(), new Redis(), etc.
// =====================================================================
export async function bootstrap(): Promise<void> {
  // 1. Load and validate all environment configuration
  const config = loadRuntimeConfig();
  const flags = new FeatureFlags(config);

  console.log(`[BOOTSTRAP] Booting Karen in ${config.EXECUTION_MODE} mode...`);

  // 2. Build observability first — we need a logger before anything else
  const observability = buildObservabilityModule(config);

  // 3. Build infrastructure modules (singletons)
  const persistence = await buildPersistenceModule(config);
  const messaging = buildMessagingModule(config);
  const ai = buildAIModule(config);

  // 4. Startup validation — fail fast before accepting traffic
  const validator = new StartupValidator(config, persistence.client, messaging.redis);
  await validator.validate();

  // 5. Start the Outbox Dispatcher (links persistence → messaging)
  const outboxDispatcher = messaging.startOutboxDispatcher(persistence.outboxStore);

  // 6. Wire graceful shutdown
  const graceful = new GracefulShutdown({
    mongoClient: persistence.client,
    redis: messaging.redis,
    outboxDispatcher
  });
  graceful.register();

  // 7. Create and start the Express application
  const app = createApp();
  app.listen(config.PORT, () => {
    console.log(`[BOOTSTRAP] Karen is READY on port ${config.PORT}`);
    console.log(`[BOOTSTRAP] Mode: ${config.EXECUTION_MODE}`);
    console.log(`[BOOTSTRAP] Features: proactive=${flags.proactiveModeEnabled}, reflection=${flags.reflectionAgentEnabled}`);
  });
}

// Entry point
bootstrap().catch(err => {
  console.error('[BOOTSTRAP] Fatal boot error:', err);
  process.exit(1);
});
