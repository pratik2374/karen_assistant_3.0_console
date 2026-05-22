import { IExecutionContext } from '../../composition/context/ExecutionContext.js';

// -----------------------------------------------------------------------
// ICommandExecutor — the ONLY way controllers invoke application handlers.
// Enforces the middleware pipeline before any handler is called.
// -----------------------------------------------------------------------
export interface ICommandExecutor<TCommand, TResult> {
  execute(command: TCommand, context: IExecutionContext): Promise<TResult>;
}

// -----------------------------------------------------------------------
// IQueryExecutor — strictly read-only. Never emits events or mutations.
// -----------------------------------------------------------------------
export interface IQueryExecutor<TQuery, TResult> {
  query(query: TQuery, context: IExecutionContext): Promise<TResult>;
}

// -----------------------------------------------------------------------
// AsyncCommandResult — what the transport layer receives back.
// Never exposes aggregates or domain internals.
// -----------------------------------------------------------------------
export interface AsyncCommandResult {
  accepted: true;
  correlationId: string;
  traceId: string;
  commandId: string;
}
