import { ValidatedCommand } from '../commands/CommandStandard.js';

// Untrusted external payload (e.g. from WhatsApp, API Gateway)
export interface ExternalDTO {
  source: string;
  rawPayload: any;
  receivedAt: Date;
  headers: Record<string, string>;
}

// The ACL strips dangerous payloads, validates structure, and translates to a Domain-safe Command
export interface IAntiCorruptionLayer<TExternal extends ExternalDTO, TCommand extends ValidatedCommand> {
  translate(external: TExternal): TCommand;
}
