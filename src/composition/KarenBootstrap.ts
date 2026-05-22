import { loadRuntimeConfig } from './config/RuntimeConfig.js';
import { FeatureFlags } from './config/FeatureFlags.js';
import { buildPersistenceModule } from './modules/persistence.module.js';
import { buildMessagingModule } from './modules/messaging.module.js';
import { buildObservabilityModule } from './modules/observability.module.js';
import { buildAIModule } from './modules/ai.module.js';
import { StartupValidator } from './lifecycle/StartupValidator.js';
import { GracefulShutdown } from './lifecycle/GracefulShutdown.js';
import { buildApplicationModule } from './modules/application.module.js';
import { buildApiModule } from './modules/api.module.js';
import { CalendarBootstrapService } from '../console/CalendarBootstrapService.js';
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

  // 6. Build application layer and API layer
  const application = buildApplicationModule(persistence);
  const api = buildApiModule(application, messaging, ai, config, persistence);

  // 7. Wire graceful shutdown
  const graceful = new GracefulShutdown({
    mongoClient: persistence.client,
    redis: messaging.redis,
    outboxDispatcher,
    consumerRegistry: api.consumerRegistry
  });
  graceful.register();

  api.app.listen(config.PORT, async () => {
    console.log(`[BOOTSTRAP] Karen is READY on port ${config.PORT}`);
    console.log(`[BOOTSTRAP] Mode: ${config.EXECUTION_MODE}`);
    console.log(`[BOOTSTRAP] Features: proactive=${flags.proactiveModeEnabled}, reflection=${flags.reflectionAgentEnabled}`);

    // Boot BullMQ Consumers & Timer Reconciliation
    if (api.consumerRegistry) {
      await api.consumerRegistry.start();
      console.log('[BOOTSTRAP] BullMQ consumer registry started.');
    }

    if (api.timerService) {
      await api.timerService.reconcileOnBoot().catch(e => {
        console.error('[BOOTSTRAP] [HYBRID TIMER] Reconciliation failed:', e);
      });
      console.log('[BOOTSTRAP] Hybrid timer service reconciled.');
    }

    // Wire CalendarBootstrapService: startup sync + 15-min polling + midnight cron
    if (persistence.db && persistence.taskRepository && persistence.outboxStore) {
      try {
        // Dynamic imports — paths are relative to src/ (one level up from src/composition/)
        const { CalendarTool } = await import('../tools/calendar/CalendarTool.js');
        const { CalendarProjectionMongoRepository } = await import('../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js');
        const { CircuitBreaker } = await import('../infrastructure/resiliency/CircuitBreaker.js');
        const { ComposioClient } = await import('../infrastructure/composio/ComposioClient.js');

        const composio = new ComposioClient(
          process.env.COMPOSIO_API_KEY || '',
          process.env.COMPOSIO_USER_ID || 'karen'
        );
        const calCircuit = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 });
        const calProjRepo = new CalendarProjectionMongoRepository(persistence.db);
        const calTool = new CalendarTool(calCircuit, composio, calProjRepo);

        const calBootstrap = new CalendarBootstrapService(
          calTool,
          calProjRepo,
          persistence.taskRepository,
          persistence.outboxStore
        );

        const userId = process.env.WHATSAPP_PHONE_NUMBER_ID || '917439707352';
        await calBootstrap.initialize(userId);
        console.log('[BOOTSTRAP] CalendarBootstrapService active — syncing today\'s events.');
      } catch (err: any) {
        console.warn(`[BOOTSTRAP] CalendarBootstrapService failed to start (non-fatal): ${err.message}`);
      }
    }
  });
}

// Entry point
bootstrap().catch(err => {
  console.error('[BOOTSTRAP] Fatal boot error:', err);
  process.exit(1);
});
