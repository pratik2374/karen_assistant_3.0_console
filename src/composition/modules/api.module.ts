import { ApplicationModule } from './application.module';
import { MessagingModule } from './messaging.module';
import { AIModule } from './ai.module';
import { PersistenceModule } from './persistence.module';
import { TaskController } from '../../api/v1/controllers/TaskController';
import { WhatsAppWebhookController } from '../../api/v1/controllers/WhatsAppWebhookController';
import { WebhookIdempotencyGuard } from '../../api/v1/middleware/idempotency/WebhookIdempotencyGuard';
import { InboundMessagePipeline } from '../../application/conversation/InboundMessagePipeline';
import { ConversationSessionRepository } from '../../domain/conversation/ConversationSession';
import { MessageRenderer } from '../../application/conversation/MessageRenderer';
import { WhatsAppAdapter } from '../../infrastructure/external/whatsapp/WhatsAppAdapter';
import { AIProposalRuntime } from '../../application/ai/runtime/AIProposalRuntime';
import { PromptRegistry } from '../../application/ai/prompts/PromptRegistry';
import { SchemaRegistry } from '../../application/ai/schemas/SchemaRegistry';
import { ClarificationEngine } from '../../application/ai/runtime/ClarificationEngine';
import { HeuristicFallbackEstimator } from '../../infrastructure/ai/governance/HeuristicFallbackEstimator';
import { TokenBudgetManager } from '../../application/ai/governance/TokenBudgetManager';
import { DeterministicContextSanitizer } from '../../infrastructure/ai/security/ContextSanitizer';
import { ContextObservabilityHook } from '../../infrastructure/observability/metrics/ContextObservabilityHook';
import { AIObservabilityHook } from '../../infrastructure/observability/metrics/AIObservabilityHook';
import { ContextEngine } from '../../application/ai/ContextEngine';
import { createApp } from '../../api/v1/app';
import { ReminderSubAgent } from '../../application/ai/agents/ReminderSubAgent';
import { MainKarenOrchestrator } from '../../application/ai/agents/MainKarenOrchestrator';
import { MemoryService } from '../../application/ai/memory/MemoryService';
import express from 'express';

import { RuntimeConfig } from '../config/RuntimeConfig.js';

// Timer and Saga Orchestration Imports
import { MongoSagaRepository } from '../../infrastructure/persistence/mongodb/MongoSagaRepository';
import { MongoTimerStore } from '../../infrastructure/persistence/mongodb/MongoTimerStore';
import { HybridTimerService } from '../../infrastructure/temporal/HybridTimerService';
import { ReminderCommandHandler } from '../../application/handlers/ReminderCommandHandler';
import { CommandExecutionPipeline, ObservabilityStep, ReplayGuardStep } from '../../application/executor/CommandExecutionPipeline';
import { SagaDispatcher } from '../../application/sagas/SagaDispatcher';
import { SagaObservabilityHook } from '../../infrastructure/observability/metrics/SagaObservabilityHook';
import { BullMQConsumerRegistry } from '../../infrastructure/messaging/bullmq/BullMQConsumerRegistry';
import { Queue } from 'bullmq';

// Calendar Sync Imports
import { CalendarProjectionMongoRepository } from '../../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js';
import { CalendarSyncAgent } from '../../application/calendar/CalendarSyncAgent.js';
import { CalendarSyncWorker } from '../../infrastructure/workers/CalendarSyncWorker.js';
import { CalendarReconciliationWorker } from '../../infrastructure/workers/CalendarReconciliationWorker.js';
import { CircuitBreaker } from '../../infrastructure/resiliency/CircuitBreaker.js';
import { BootSyncCoordinator } from '../../console/BootSyncCoordinator.js';

// New Multi-Agent Architecture
import { ComposioClient } from '../../infrastructure/composio/ComposioClient.js';
import { CalendarTool } from '../../tools/calendar/CalendarTool.js';
import { CalendarAgent } from '../../agents/calendar/CalendarAgent.js';
import { SystemOpsAgent } from '../../agents/system/SystemOpsAgent.js';
import { AgentRouter } from '../../application/agents/AgentRouter.js';

export interface ApiModule {
  app: express.Application;
  timerService?: HybridTimerService;
  sagaDispatcher?: SagaDispatcher;
  consumerRegistry?: BullMQConsumerRegistry;
  bootSyncCoordinator?: BootSyncCoordinator;
}

export function buildApiModule(
  application: ApplicationModule,
  messaging: MessagingModule,
  ai: AIModule,
  config?: RuntimeConfig,
  persistence?: PersistenceModule
): ApiModule {
  const taskController = new TaskController(application.taskCommandExecutor);

  // Build AI cognition substrate
  const estimator = new HeuristicFallbackEstimator();
  const budgetManager = new TokenBudgetManager(estimator);
  const sanitizer = new DeterministicContextSanitizer();
  const ctxHook = new ContextObservabilityHook();
  const contextEngine = new ContextEngine(budgetManager, sanitizer, ctxHook);
  const promptRegistry = new PromptRegistry();
  const schemaRegistry = new SchemaRegistry();
  const clarificationEngine = new ClarificationEngine();
  const aiHook = new AIObservabilityHook();

  const aiRuntime = new AIProposalRuntime(
    contextEngine,
    promptRegistry,
    schemaRegistry,
    ai.openAIAdapter,
    clarificationEngine,
    aiHook
  );

  // Build transport layer
  const whatsappAdapter = new WhatsAppAdapter(ai.circuitBreaker, config);
  const sessionRepo = new ConversationSessionRepository();
  const renderer = new MessageRenderer();

  // Instantiate Multi-Agent Substrate!
  const reminderSubAgent = new ReminderSubAgent(ai.openAIAdapter);
  const orchestrator = new MainKarenOrchestrator(
    ai.openAIAdapter,
    reminderSubAgent,
    sessionRepo,
    persistence
  );

  // Instantiate Memory Layer!
  let memoryService: MemoryService | undefined;
  if (persistence && persistence.db) {
    memoryService = new MemoryService(persistence.db, ai.openAIAdapter);
  }

  const pipeline = new InboundMessagePipeline(
    aiRuntime,
    sessionRepo,
    renderer,
    whatsappAdapter,
    application.taskCommandExecutor,
    persistence,
    orchestrator,
    memoryService,
    undefined // CalendarAgent injected later when instantiated
  );

  const idempotencyGuard = new WebhookIdempotencyGuard(messaging.redis);
  const webhookController = new WhatsAppWebhookController(pipeline);

  const app = createApp(taskController, webhookController, idempotencyGuard);

  // Wire up the complete Orchestration and Timer pipeline if persistence is available
  let timerService: HybridTimerService | undefined;
  let sagaDispatcher: SagaDispatcher | undefined;
  let consumerRegistry: BullMQConsumerRegistry | undefined;
  
  let calendarSyncWorker: CalendarSyncWorker | undefined;
  let calendarReconciliationWorker: CalendarReconciliationWorker | undefined;
  
  let bootSyncCoordinator: BootSyncCoordinator | undefined;
  let agentRouter: AgentRouter | undefined;

  if (persistence) {
    const sagaRepository = new MongoSagaRepository(persistence.db);
    const timerStore = new MongoTimerStore(persistence.db);
    const timerQueue = new Queue('timer_wakeup', { connection: messaging.redis });
    
    timerService = new HybridTimerService(timerStore, timerQueue);

    const reminderCommandHandler = new ReminderCommandHandler(
      persistence.reminderRepository,
      persistence.outboxStore,
      persistence.buildUnitOfWork
    );

    const reminderCommandExecutor = new CommandExecutionPipeline(
      reminderCommandHandler,
      [
        new ObservabilityStep(),
        new ReplayGuardStep()
      ]
    );

    const sagaHook = new SagaObservabilityHook();
    sagaDispatcher = new SagaDispatcher(
      sagaRepository,
      timerService,
      reminderCommandExecutor,
      sagaHook
    );

    // Setup Calendar Sync Components
    const calendarProjectionRepo = new CalendarProjectionMongoRepository(persistence.db);
    const calendarCircuitBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 });

    // Composio-based transport (single auth, managed OAuth)
    const composioApiKey = process.env.COMPOSIO_API_KEY || '';
    const composioUserId = process.env.COMPOSIO_USER_ID || 'karen_default_user';
    const composioClient = new ComposioClient(composioApiKey, composioUserId);

    // CalendarTool — sole external calendar boundary
    const calendarTool = new CalendarTool(calendarCircuitBreaker, composioClient, calendarProjectionRepo);

    // New CalendarAgent domain coordinator
    const calendarAgentInstance = new CalendarAgent(calendarTool, calendarProjectionRepo);

    // New SystemOpsAgent meta-coordinator
    const systemOpsAgentInstance = new SystemOpsAgent(persistence, application.taskCommandExecutor);

    // AgentRouter — deterministic dispatcher wired to InboundMessagePipeline
    agentRouter = new AgentRouter(calendarAgentInstance, systemOpsAgentInstance);
    (pipeline as any).agentRouter = agentRouter;

    // Legacy CalendarSyncAgent still handles BullMQ-based outbound sync jobs
    // Uses GoogleCalendarAdapter temporarily until CalendarSyncWorker is migrated to CalendarTool
    const syncJobQueue = new Queue('calendar_sync_jobs', { connection: messaging.redis });
    const calendarSyncAgent = new CalendarSyncAgent(calendarProjectionRepo, syncJobQueue);

    // BootSyncCoordinator — reads Google Calendar at startup via CalendarTool
    bootSyncCoordinator = new BootSyncCoordinator(
      calendarTool,
      calendarProjectionRepo,
      persistence.taskRepository,
      timerService,
      memoryService!
    );

    consumerRegistry = new BullMQConsumerRegistry(
      messaging.redis,
      sagaDispatcher,
      timerStore,
      sagaRepository,
      persistence.taskRepository,
      whatsappAdapter,
      messaging.idempotencyStore,
      calendarSyncAgent
    );

    console.log('[API] Orchestration, Sagas, Timers, and BullMQ consumer singletons wired.');
  }

  console.log('[API] Express app wired with controllers and transport guards.');
  return { app, timerService, sagaDispatcher, consumerRegistry, bootSyncCoordinator };
}
