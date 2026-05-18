import chalk from 'chalk';
import { RuntimeStore } from './RuntimeStore.js';

const INFRA_ICON = (s: string) => {
  if (s === 'HEALTHY') return chalk.green('✓');
  if (s === 'DEGRADED') return chalk.yellow('⚠');
  return chalk.gray('?');
};

export class RuntimeHUD {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastLine = '';

  public start(): void {
    // Print HUD every 2 seconds, updating in-place
    this.intervalId = setInterval(() => this.render(), 2000);
    this.render();
  }

  public stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private render(): void {
    const s = RuntimeStore;
    const totalQ = Object.values(s.queueDepth).reduce((a, b) => a + b, 0);

    const line = [
      chalk.bold.cyan('[KAREN]'),
      chalk.green('LIVE'),
      chalk.gray('|'),
      `Redis ${INFRA_ICON(s.infra.redis)}`,
      `Mongo ${INFRA_ICON(s.infra.mongo)}`,
      `OpenAI ${INFRA_ICON(s.infra.openai)}`,
      chalk.gray('|'),
      `Q:${chalk.yellow(totalQ)}`,
      `Timers:${chalk.yellow(s.activeTimers)}`,
      `Sessions:${chalk.yellow(s.activeSessions)}`,
      chalk.gray('|'),
      `AI:${chalk.cyan(s.ai.lastLatencyMs)}ms`,
      `Tokens:${chalk.magenta(this.formatTokens(s.ai.tokensToday))}`,
      `Proposals:${chalk.blue(s.ai.proposalsGenerated)}`,
      chalk.gray('|'),
      `Webhooks:${chalk.white(s.webhookCount)}`,
      s.isReplayMode ? chalk.red('REPLAY:ON') : chalk.gray('Replay:OFF'),
      chalk.gray('|'),
      `Up:${chalk.white(s.uptimeString)}`
    ].join(' ');

    // Overwrite the current HUD line in-place
    if (this.lastLine) {
      process.stdout.write('\r' + ' '.repeat(this.lastLine.length) + '\r');
    }
    process.stdout.write(line);
    this.lastLine = line.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for length calc
  }

  public clearLine(): void {
    if (this.lastLine) {
      process.stdout.write('\r' + ' '.repeat(this.lastLine.length) + '\r');
      this.lastLine = '';
    }
  }

  private formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }
}
