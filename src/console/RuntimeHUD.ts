import chalk from 'chalk';
import readline from 'readline';
import { RuntimeStore } from './RuntimeStore.js';

const INFRA_ICON = (s: string) => {
  if (s === 'HEALTHY') return '✓';
  if (s === 'DEGRADED') return '⚠';
  return '?';
};

export class RuntimeHUD {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastLine = '';
  private isTTY = !!process.stdout.isTTY;

  public start(): void {
    if (!this.isTTY) {
      // Non-TTY mode: Disable active status redraws to prevent polluting the scrolling output log stream
      return;
    }
    // Print HUD every 2 seconds, updating in-place
    this.intervalId = setInterval(() => this.render(), 2000);
    this.render();
  }

  public stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  public render(): void {
    if (!this.isTTY) return;

    const s = RuntimeStore;
    const totalQ = Object.values(s.queueDepth).reduce((a, b) => a + b, 0);

    const redisStr = `R:${s.infra.redis === 'HEALTHY' ? chalk.green('✓') : chalk.red('✗')}`;
    const mongoStr = `M:${s.infra.mongo === 'HEALTHY' ? chalk.green('✓') : chalk.red('✗')}`;
    const openaiStr = `O:${s.infra.openai === 'HEALTHY' ? chalk.green('✓') : chalk.red('✗')}`;

    // Hyper-compact single-line status (<70 characters) that NEVER wraps on narrow sidebar/bottom panel terminals
    const line = [
      chalk.bold.cyan('[K]'),
      `${redisStr}${mongoStr}${openaiStr}`,
      `Q:${chalk.yellow(totalQ)}`,
      `T:${chalk.yellow(s.activeTimers)}`,
      `AI:${chalk.cyan(s.ai.lastLatencyMs)}ms`,
      `Tok:${chalk.magenta(this.formatTokens(s.ai.tokensToday))}`,
      `P:${chalk.blue(s.ai.proposalsGenerated)}`,
      `W:${chalk.white(s.webhookCount)}`,
      `Up:${chalk.white(this.formatUptime(s.uptimeSeconds))}`
    ].join('│');

    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(line);
    
    this.lastLine = line.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for length calc
  }

  public clearLine(): void {
    if (!this.isTTY) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    this.lastLine = '';
  }

  private formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private formatUptime(s: number): string {
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${m}m${sec}s`;
  }
}
