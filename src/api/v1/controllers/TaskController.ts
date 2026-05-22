import { Request, Response } from 'express';
import { CreateTaskRequestDTO, AsyncCommandResponseDTO } from '../../dtos/TransportDTOs.js';
import { HttpErrorMapper } from '../../errors/HttpErrorMapper.js';
import { ICommandExecutor } from '../../../application/executor/IExecutor.js';
import { CreateTaskCommand, CreateTaskResult } from '../../../application/handlers/TaskCommandHandler.js';
import { ExecutionContext } from '../../../composition/context/ExecutionContext.js';
import { randomUUID } from 'crypto';

// Controller is INTENTIONALLY thin — no domain logic, no repository access.
// Receives validated DTO → maps to Command → dispatches to Executor → returns 202 ACCEPTED.
export class TaskController {
  
  constructor(
    private readonly commandExecutor: ICommandExecutor<CreateTaskCommand, CreateTaskResult>
  ) {}

  async createTask(req: Request, res: Response): Promise<void> {
    try {
      const dto = req.body as CreateTaskRequestDTO;
      const { correlationId, traceId, identity } = req;

      const commandId = randomUUID();
      
      const command: CreateTaskCommand = {
        commandId,
        commandDeduplicationKey: dto.idempotencyKey,
        title: dto.title,
        priority: dto.priority,
        dueAt: new Date(dto.dueAt),
        timezone: dto.timezone
      };

      // Map Express request identity to Domain execution context
      const context = new ExecutionContext(
        traceId,
        correlationId,
        identity.userId,
        identity.sessionId,
        identity.scopes,
        identity.executionMode,
        500000 // In a real app, resolve from token budget service
      );

      // Dispatch to pipeline (middleware + handler)
      await this.commandExecutor.execute(command, context);

      const response: AsyncCommandResponseDTO = {
        status: 'ACCEPTED',
        correlationId,
        traceId,
        commandId,
        message: 'Task creation command accepted and queued for processing'
      };

      // 202 ACCEPTED — async command, never block HTTP on saga completion
      res.status(202).json(response);
    } catch (err) {
      HttpErrorMapper.toResponse(err, res, req.correlationId);
    }
  }
}

