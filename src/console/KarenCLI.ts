// =========================================================================
// KarenCLI.ts — the interactive developer CLI for Karen.
// Re-created as a standalone file with its own functionality.
// =========================================================================
import chalk from 'chalk';
import Table from 'cli-table3';
import * as readline from 'readline';
import { RuntimeStore } from './RuntimeStore.js';
import { RuntimeHUD } from './RuntimeHUD.js';

export class KarenCLI {
  private rl: readline.Interface;

  constructor(private hud: RuntimeHUD) {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  }

  public start(): void {
    this.printHelp();
    this.prompt();
    this.rl.on('line', (input) => {
      this.hud.clearLine();
      this.handleCommand(input.trim());
      this.prompt();
    });
    this.rl.on('close', () => {
      console.log(chalk.yellow('\n[CLI] Session closed.'));
      process.exit(0);
    });
  }

  private prompt(): void {
    process.stdout.write(chalk.cyan('\nkaren> '));
  }

  private printHelp(): void {
    console.log(chalk.bold('\n  Available Commands:'));
    console.log(chalk.gray('  status    ') + '— Runtime snapshot');
    console.log(chalk.gray('  queues    ') + '— BullMQ queue depths');
    console.log(chalk.gray('  ai        ') + '— AI metrics & cognition stats');
    console.log(chalk.gray('  metrics   ') + '— Transport & webhook metrics');
    console.log(chalk.gray('  health    ') + '— Infrastructure health');
    console.log(chalk.gray('  help      ') + '— Show this list');
    console.log(chalk.gray('  exit      ') + '— Shutdown\n');
  }

  private handleCommand(raw: string): void {
    const cmd = raw.split(' ')[0].toLowerCase();
    switch (cmd) {
      case 'help':    this.printHelp(); break;
      case 'status':  this.cmdStatus(); break;
      case 'queues':  this.cmdQueues(); break;
      case 'ai':      this.cmdAI(); break;
      case 'metrics': this.cmdMetrics(); break;
      case 'health':  this.cmdHealth(); break;
      case 'exit':
      case 'quit':    this.rl.close(); break;
      case '':        break;
      default:
        console.log(chalk.red(`Unknown command: "${cmd}". Type 'help'.`));
    }
  }

  private cmdStatus(): void {
    const s = RuntimeStore;
    const t = new Table({ style: { border: ['gray'] } });
    t.push(
      [chalk.gray('Uptime'),           chalk.white(s.uptimeString)],
      [chalk.gray('Replay Mode'),      s.isReplayMode ? chalk.red('ON') : chalk.green('OFF')],
      [chalk.gray('Active Timers'),    chalk.yellow(s.activeTimers)],
      [chalk.gray('Active Sessions'),  chalk.yellow(s.activeSessions)],
      [chalk.gray('Webhooks In'),      chalk.white(s.webhookCount)],
      [chalk.gray('Duplicates Dropped'), chalk.yellow(s.duplicateWebhooks)],
    );
    console.log(chalk.bold('\n  Runtime Status\n') + t.toString());
  }

  private cmdQueues(): void {
    const t = new Table({
      head: [chalk.cyan('Queue'), chalk.cyan('Depth')],
      colWidths: [14, 10], style: { border: ['gray'] }
    });
    for (const [name, depth] of Object.entries(RuntimeStore.queueDepth)) {
      const c = depth > 50 ? chalk.red : depth > 10 ? chalk.yellow : chalk.green;
      t.push([name, c(String(depth))]);
    }
    console.log(chalk.bold('\n  BullMQ Queues\n') + t.toString());
  }

  private cmdAI(): void {
    const ai = RuntimeStore.ai;
    const t = new Table({ style: { border: ['gray'] } });
    t.push(
      [chalk.gray('Model'),           chalk.white(ai.model)],
      [chalk.gray('Prompt Version'),  chalk.white(ai.promptVersion)],
      [chalk.gray('Tokens Today'),    chalk.magenta(ai.tokensToday.toLocaleString())],
      [chalk.gray('Last Latency'),    chalk.cyan(`${ai.lastLatencyMs}ms`)],
      [chalk.gray('Proposals'),       chalk.blue(ai.proposalsGenerated)],
      [chalk.gray('Clarifications'),  chalk.yellow(ai.clarificationsTriggered)],
      [chalk.gray('Hallucinations'),  chalk.red(ai.hallucinationsRejected)],
    );
    console.log(chalk.bold('\n  AI Metrics\n') + t.toString());
  }

  private cmdMetrics(): void {
    const s = RuntimeStore;
    const t = new Table({ style: { border: ['gray'] } });
    t.push(
      [chalk.gray('Webhooks Received'),   chalk.white(s.webhookCount)],
      [chalk.gray('Duplicates Dropped'),  chalk.yellow(s.duplicateWebhooks)],
    );
    console.log(chalk.bold('\n  Transport Metrics\n') + t.toString());
  }

  private cmdHealth(): void {
    const icon = (s: string) =>
      s === 'HEALTHY' ? chalk.green('● HEALTHY') :
      s === 'DEGRADED' ? chalk.yellow('⚠ DEGRADED') :
                         chalk.gray('? UNKNOWN');
    const t = new Table({ style: { border: ['gray'] } });
    const inf = RuntimeStore.infra;
    t.push(
      [chalk.gray('Redis'),  icon(inf.redis)],
      [chalk.gray('Mongo'),  icon(inf.mongo)],
      [chalk.gray('OpenAI'), icon(inf.openai)],
    );
    console.log(chalk.bold('\n  Infrastructure Health\n') + t.toString());
  }
}
