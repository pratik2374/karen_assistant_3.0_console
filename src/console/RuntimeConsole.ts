// =========================================================================
// RuntimeConsole — boots Karen, starts the HUD, event stream, and CLI.
// This is the main entry point for the developer experience layer.
// =========================================================================
import 'dotenv/config';
import chalk from 'chalk';
import ora from 'ora';
import { RuntimeHUD } from './RuntimeHUD.js';
import { EventStreamConsoleAdapter } from './EventStreamConsoleAdapter.js';
import { KarenCLI } from './KarenCLI.js';
import { RuntimeStore } from './RuntimeStore.js';
import { RuntimeEventBus } from './RuntimeEventBus.js';

import { loadRuntimeConfig } from '../composition/config/RuntimeConfig.js';
import { buildPersistenceModule } from '../composition/modules/persistence.module.js';
import { buildMessagingModule } from '../composition/modules/messaging.module.js';
import { buildApplicationModule } from '../composition/modules/application.module.js';
import { buildAIModule } from '../composition/modules/ai.module.js';
import { buildApiModule } from '../composition/modules/api.module.js';
import { StartupValidator } from '../composition/lifecycle/StartupValidator.js';
import { GracefulShutdown } from '../composition/lifecycle/GracefulShutdown.js';

async function bootConsole(): Promise<void> {
  console.clear();

  // ── Banner ──────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════╗
║           KAREN  ·  Runtime Console             ║
║        Deterministic Orchestration Platform     ║
╚══════════════════════════════════════════════════╝
`));

  const spinner = ora({ text: 'Loading configuration...', color: 'cyan' }).start();

  // ── Config ──────────────────────────────────────────────────────────────
  let config: ReturnType<typeof loadRuntimeConfig>;
  try {
    config = loadRuntimeConfig();
    spinner.succeed(chalk.gray('Configuration loaded'));
  } catch (e: any) {
    spinner.fail(chalk.red(`Config error: ${e.message}`));
    process.exit(1);
  }

  // ── Infrastructure ───────────────────────────────────────────────────────
  spinner.start('Connecting to MongoDB...');
  const persistence = await buildPersistenceModule(config).catch(e => {
    spinner.fail(chalk.red(`MongoDB failed: ${e.message}`));
    RuntimeStore.infra.mongo = 'DEGRADED';
    return null;
  });
  if (persistence) {
    spinner.succeed(chalk.gray('MongoDB connected ✓'));
    RuntimeStore.infra.mongo = 'HEALTHY';
  }

  spinner.start('Connecting to Redis...');
  let messaging: ReturnType<typeof buildMessagingModule>;
  try {
    messaging = buildMessagingModule(config);
    // Quick ping
    await (messaging.redis as any).ping();
    spinner.succeed(chalk.gray('Redis connected ✓'));
    RuntimeStore.infra.redis = 'HEALTHY';
  } catch (e: any) {
    spinner.fail(chalk.red(`Redis failed: ${e.message}`));
    RuntimeStore.infra.redis = 'DEGRADED';
    process.exit(1);
  }

  spinner.start('Wiring application layer...');
  const ai = buildAIModule(config);
  const application = buildApplicationModule(persistence!);
  const api = buildApiModule(application, messaging!, ai);

  // Startup validation
  const validator = new StartupValidator(config, persistence!.client, messaging!.redis);
  await validator.validate().catch(() => {});

  spinner.succeed(chalk.gray('Application layer wired ✓'));

  // OpenAI check (we just mark it based on key presence)
  RuntimeStore.infra.openai = config.OPENAI_API_KEY && config.OPENAI_API_KEY !== 'your_openai_key'
    ? 'HEALTHY' : 'DEGRADED';

  // ── Outbox Dispatcher ────────────────────────────────────────────────────
  const outboxDispatcher = messaging!.startOutboxDispatcher(persistence!.outboxStore);

  // ── Graceful Shutdown ────────────────────────────────────────────────────
  const graceful = new GracefulShutdown({ mongoClient: persistence!.client, redis: messaging!.redis, outboxDispatcher });
  graceful.register();

  // ── HTTP Server ───────────────────────────────────────────────────────────
  spinner.start(`Starting HTTP server on port ${config.PORT}...`);
  api.app.listen(config.PORT, () => {
    spinner.succeed(chalk.gray(`HTTP server listening on :${config.PORT} ✓`));
  });

  // ── Console Layer ─────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.green('  Karen Runtime Online'));
  console.log(chalk.gray(`  Mode: ${config.EXECUTION_MODE} | Port: ${config.PORT} | Env: ${config.NODE_ENV}`));
  console.log(chalk.gray(`  WhatsApp Phone ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'NOT SET'}`));
  console.log('');

  RuntimeEventBus.log('RUNTIME_ONLINE', 'SYSTEM', `Karen runtime online on :${config.PORT}`);

  const hud = new RuntimeHUD();
  const stream = new EventStreamConsoleAdapter(hud);
  const cli = new KarenCLI(hud);

  stream.start();
  hud.start();
  cli.start();
}

bootConsole().catch(err => {
  console.error(chalk.red('[CONSOLE] Fatal boot error:'), err);
  process.exit(1);
});
