import chalk from 'chalk';
import { RuntimeEvent, RuntimeEventBus } from './RuntimeEventBus.js';
import { RuntimeHUD } from './RuntimeHUD.js';

const CATEGORY_COLOR: Record<RuntimeEvent['category'], (s: string) => string> = {
  TRANSPORT: chalk.cyan,
  AI:        chalk.magenta,
  COMMAND:   chalk.blue,
  SAGA:      chalk.yellow,
  TIMER:     chalk.green,
  SYSTEM:    chalk.gray,
  OUTBOUND:  chalk.greenBright,
  ERROR:     chalk.red,
};

const CATEGORY_TAG: Record<RuntimeEvent['category'], string> = {
  TRANSPORT: 'Transport',
  AI:        'AI       ',
  COMMAND:   'Command  ',
  SAGA:      'Saga     ',
  TIMER:     'Timer    ',
  SYSTEM:    'System   ',
  OUTBOUND:  'Outbound ',
  ERROR:     'ERROR    ',
};

export class EventStreamConsoleAdapter {
  private unsubscribe: (() => void) | null = null;

  constructor(private hud: RuntimeHUD) {}

  public start(): void {
    this.unsubscribe = RuntimeEventBus.subscribe((event) => {
      this.render(event);
    });
  }

  public stop(): void {
    this.unsubscribe?.();
  }

  private render(event: RuntimeEvent): void {
    // Clear the HUD line first so the event log is clean
    this.hud.clearLine();

    const ts = event.timestamp.toTimeString().split(' ')[0];
    const colorFn = CATEGORY_COLOR[event.category];
    const tag = CATEGORY_TAG[event.category];
    const traceStr = event.traceId ? chalk.gray(` [${event.traceId.substring(0, 8)}]`) : '';
    
    const line = `${chalk.gray(ts)} ${colorFn(`[${tag}]`)}${traceStr} ${event.message}`;
    console.log(line);
  }
}
