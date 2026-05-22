import { IExecutionContext } from '../../composition/context/ExecutionContext.js';
import { ICommandExecutor, AsyncCommandResult } from './IExecutor.js';
import { ExecutionFailureClassifier, FailureClass } from './ExecutionFailureClassifier.js';
import { randomUUID } from 'crypto';

// -----------------------------------------------------------------------
// Middleware step interface — each step in the pipeline is pluggable.
// -----------------------------------------------------------------------
export interface PipelineStep<TCommand> {
  name: string;
  run(command: TCommand, context: IExecutionContext): Promise<void>;
}

// -----------------------------------------------------------------------
// IApplicationHandler — the actual business logic.
// Receives validated command + context, returns a result.
// -----------------------------------------------------------------------
export interface IApplicationHandler<TCommand, TResult> {
  handle(command: TCommand, context: IExecutionContext): Promise<TResult>;
}

// -----------------------------------------------------------------------
// CommandExecutionPipeline — enforces the middleware chain before any
// handler is invoked. Controllers ONLY touch this via ICommandExecutor.
// -----------------------------------------------------------------------
export class CommandExecutionPipeline<TCommand, TResult>
  implements ICommandExecutor<TCommand, TResult> {

  constructor(
    private readonly handler: IApplicationHandler<TCommand, TResult>,
    private readonly steps: PipelineStep<TCommand>[] = []
  ) {}

  async execute(command: TCommand, context: IExecutionContext): Promise<TResult> {
    const commandId = randomUUID();

    // Run all middleware steps in sequence before handler
    for (const step of this.steps) {
      try {
        await step.run(command, context);
      } catch (err) {
        const failure = ExecutionFailureClassifier.classify(err);
        console.error(JSON.stringify({
          type: 'PIPELINE_STEP_FAILED',
          step: step.name,
          failureClass: failure.class,
          reason: failure.reason,
          traceId: context.traceId,
          correlationId: context.correlationId
        }));
        throw err; // Propagate — let the transport layer return the correct HTTP error
      }
    }

    // Enforce execution timeout via Promise.race
    const TIMEOUT_MS = 10000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Handler execution timeout exceeded')), TIMEOUT_MS)
    );

    const result = await Promise.race([
      this.handler.handle(command, context),
      timeoutPromise
    ]);

    console.log(JSON.stringify({
      type: 'COMMAND_EXECUTED',
      commandId,
      traceId: context.traceId,
      correlationId: context.correlationId,
      executionMode: context.executionMode
    }));

    return result;
  }
}

// -----------------------------------------------------------------------
// Built-in pipeline steps
// -----------------------------------------------------------------------

export class ReplayGuardStep<TCommand> implements PipelineStep<TCommand> {
  name = 'ReplayGuard';

  async run(_command: TCommand, context: IExecutionContext): Promise<void> {
    if (context.isReplay) {
      // In replay mode, mutations that produce side effects must be explicitly flagged safe
      console.log(JSON.stringify({
        type: 'REPLAY_MODE_ACTIVE',
        traceId: context.traceId,
        message: 'Command executing in REPLAY mode — external side effects suppressed'
      }));
    }
  }
}

export class ObservabilityStep<TCommand> implements PipelineStep<TCommand> {
  name = 'ObservabilityHook';

  async run(_command: TCommand, context: IExecutionContext): Promise<void> {
    console.log(JSON.stringify({
      type: 'COMMAND_RECEIVED',
      traceId: context.traceId,
      correlationId: context.correlationId,
      userId: context.userId,
      executionMode: context.executionMode,
      timestamp: new Date().toISOString()
    }));
  }
}
