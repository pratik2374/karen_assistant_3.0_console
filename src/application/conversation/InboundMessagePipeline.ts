import { AIProposalRuntime } from '../ai/runtime/AIProposalRuntime.js';
import { ConversationSessionRepository } from '../../domain/conversation/ConversationSession.js';
import { MessageRenderer } from './MessageRenderer.js';
import { WhatsAppAdapter, WhatsAppMessage } from '../../infrastructure/external/whatsapp/WhatsAppAdapter.js';
import { ICommandExecutor } from '../executor/IExecutor.js';
import { ProposalType } from '../commands/CommandStandard.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { ReminderAggregate } from '../../domain/reminder/ReminderAggregate.js';
import { MemoryTier } from '../../domain/memory/MemoryTiers.js';
import { MainKarenOrchestrator } from '../ai/agents/MainKarenOrchestrator.js';
import { MemoryService } from '../ai/memory/MemoryService.js';
import { randomUUID } from 'crypto';

export class InboundMessagePipeline {
  constructor(
    private aiRuntime: AIProposalRuntime,
    private sessionRepo: ConversationSessionRepository,
    private renderer: MessageRenderer,
    private whatsapp: WhatsAppAdapter,
    private commandExecutor: ICommandExecutor<any, any>, // Generalized for this phase
    private persistence?: any,
    private orchestrator?: MainKarenOrchestrator,
    private memoryService?: MemoryService
  ) {}

  public async process(
    userId: string,
    messageText: string,
    messageId: string,
    traceId: string
  ): Promise<void> {
    RuntimeEventBus.log('PIPELINE_PROCESS_START', 'TRANSPORT',
      `Pipeline process started for message "${messageText}"`,
      traceId
    );

    const session = await this.sessionRepo.getSession(userId);

    // Save user message and fetch/cache its retrieved past dialogue matches
    if (this.memoryService) {
      await this.memoryService.saveMessageAndRetrievedPastContext(
        userId,
        'user',
        messageText,
        messageId,
        traceId
      ).catch(err => console.error('[MemoryService] Failed to save user message:', err));
    }

    if (this.orchestrator) {
      const orchestratorResult = await this.orchestrator.orchestrate(userId, messageText, messageId, traceId);
      if (!orchestratorResult.shouldExecuteDirectly) {
        await this.sendReply(userId, orchestratorResult.responseText, messageId);
        return;
      }
    }

    let queryToProcess = messageText;

    // Resolve Clarification State
    if (session.isWaitingForClarification()) {
      // Append original query to the user's reply so the AI has full context of the correction
      queryToProcess = `Original Request: "${session.activeClarification!.originalQuery}"\nUser Clarification: "${messageText}"`;
      session.clearClarification();
    }

    RuntimeEventBus.log('PIPELINE_AI_COGNITION_START', 'AI',
      `AI cognition starting with query: "${queryToProcess.substring(0, 50)}..."`,
      traceId
    );

    // Fetch user's active tasks/reminders from MongoDB to inject as context!
    let memories: any[] = [];
    if (this.persistence && this.persistence.db) {
      try {
        const docs = await this.persistence.db.collection('saga_states')
          .find({
            'payloadData.userId': userId,
            currentState: { $nin: ['COMPLETED', 'CANCELLED', 'FAILED'] }
          })
          .toArray();

        memories = docs.map((d: any) => ({
          memoryId: `active-task-${d.payloadData.taskId}`,
          content: `Active Schedule/Reminder: "${d.payloadData.taskTitle || 'Reminder'}" | State: ${d.currentState} | ID: ${d.payloadData.taskId}`,
          tags: ['active_task', 'reminder', 'schedule'],
          createdAt: d.startedAt || new Date(),
          tier: MemoryTier.ACTIVE_TASK
        }));

        RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
          `Injected ${memories.length} active tasks into AI context.`,
          traceId
        );
      } catch (err) {
        console.error('[INBOUND PIPELINE] Failed to query active tasks:', err);
      }
    }

    if (this.memoryService) {
      try {
        const memoryString = await this.memoryService.getCompleteContextString(userId);
        memories.push({
          memoryId: 'daily-chat-memory-layer',
          content: memoryString,
          tags: ['daily_chat', 'vector_memories', 'ciphered_insights'],
          createdAt: new Date(),
          relevanceScore: 1.0,
          tier: MemoryTier.RECENT_EPISODIC
        });

        RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
          `Injected rich today & past vector/ciphered memories into AI context.`,
          traceId
        );
      } catch (err) {
        console.error('[INBOUND PIPELINE] Failed to load daily chat context:', err);
      }
    }

    try {
      // Execute AI Cognition
      const proposal = await this.aiRuntime.generateProposal(
        queryToProcess,
        [], 
        'PLANNING', // Mode
        traceId,
        memories
      );

      RuntimeEventBus.log('PIPELINE_AI_COGNITION_SUCCESS', 'AI',
        `AI generated proposal successfully: ${proposal.proposalType}`,
        traceId
      );

      // Route Proposal
      switch (proposal.proposalType) {
        case ProposalType.CLARIFICATION_REQUEST:
          RuntimeEventBus.log('CLARIFICATION_SENT', 'AI',
            `Clarification sent to ${userId}: "${(proposal as any).clarificationPrompt.substring(0, 60)}"`, traceId);
          session.setClarification({
            originalQuery: queryToProcess,
            clarificationPrompt: (proposal as any).clarificationPrompt,
            missingInformation: (proposal as any).missingInformation,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 min
          });
          
          await this.sendReply(
            userId,
            this.renderer.renderClarification((proposal as any).clarificationPrompt, (proposal as any).missingInformation),
            messageId
          );
          break;

        case ProposalType.INFORMATION_RESPONSE:
          await this.sendReply(
            userId,
            this.renderer.renderInformation((proposal as any).responseText),
            messageId
          );
          break;

        case ProposalType.COMMAND_PROPOSAL: {
          RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'COMMAND',
            `Dispatching command: ${(proposal as any).actionIntent}`,
            traceId
          );

          let payloadObj: any = {};
          if (typeof (proposal as any).rawPayload === 'string') {
            try {
              payloadObj = JSON.parse((proposal as any).rawPayload);
            } catch (e) {
              payloadObj = {};
            }
          } else {
            payloadObj = (proposal as any).rawPayload || {};
          }

          // Log payloadObj keys and values for transparency
          RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'COMMAND',
            `Raw payload parsed keys: ${Object.keys(payloadObj).join(', ')} | Content: ${JSON.stringify(payloadObj)}`,
            traceId
          );

          const commandId = randomUUID();
          const correlationId = randomUUID();

          const intentAction = ((proposal as any).actionIntent || '').toLowerCase();
          const isCompleteOrCancel = [
            'complete_task',
            'cancel_reminder',
            'remove_reminder',
            'remove_schedule',
            'cancel_schedule',
            'complete_schedule'
          ].includes(intentAction);

          if (isCompleteOrCancel && this.persistence) {
            const taskId = payloadObj.taskId || payloadObj.id;
            if (!taskId) {
              throw new Error('Task ID / Reminder ID is required to cancel or complete.');
            }

            // Execute cancellation/acknowledgment inside Unit of Work!
            const uow = this.persistence.buildUnitOfWork();
            await uow.start();

            try {
              const reminderId = `reminder-${taskId}`;
              let reminder = await this.persistence.reminderRepository.findById(reminderId);
              
              let expectedVersion = 0;
              if (!reminder) {
                reminder = ReminderAggregate.initialize(reminderId, taskId, traceId, correlationId);
              } else {
                expectedVersion = reminder.version;
              }

              reminder.acknowledge(traceId, correlationId);
              await this.persistence.reminderRepository.saveWithVersion(reminder, expectedVersion);

              const now = new Date();
              const outboxMessages = reminder.uncommittedEvents.map((event: any) => ({
                messageId: randomUUID(),
                eventType: event.eventType,
                payload: event,
                createdAt: now,
                processedAt: null,
                idempotencyKey: `${correlationId}:${event.eventType}:${reminder.version}`,
                deduplicationKey: `${reminderId}:${event.eventType}:${reminder.version}`,
                replaySafe: false,
                sideEffectFree: false,
                traceId,
                correlationId,
                causationId: messageId
              }));

              await this.persistence.outboxStore.saveBulk(outboxMessages);
              await uow.commit();

              RuntimeEventBus.log('COMMAND_EXECUTED', 'COMMAND',
                `Reminder acknowledgment command executed successfully for task ${taskId}`,
                traceId,
                { taskId }
              );

              // Render confirmation message to the user!
              await this.sendReply(
                userId,
                this.renderer.renderCancellation(taskId),
                messageId
              );

            } catch (err: any) {
              await uow.rollback();
              RuntimeEventBus.log('COMMAND_FAILED', 'ERROR',
                `Failed to execute acknowledgment for task ${taskId}: ${err.message}`,
                traceId
              );
              throw err;
            }
            break;
          }
          
          const title = payloadObj.title || 
                        payloadObj.task || 
                        payloadObj.action || 
                        payloadObj.content || 
                        payloadObj.text || 
                        payloadObj.reminder || 
                        payloadObj.memo || 
                        payloadObj.description || 
                        payloadObj.subject || 
                        payloadObj.message || 
                        messageText || 
                        'Reminder';
          const priority = payloadObj.priority || 'high';
          const timezone = payloadObj.timezone || 'Asia/Kolkata';

          // Resilient dueAt extraction
          let dueAt = new Date();
          if (payloadObj.dueAt) {
            dueAt = new Date(payloadObj.dueAt);
          } else {
            // Default to 2 minutes from now
            dueAt = new Date(Date.now() + 2 * 60 * 1000);
          }

          if (isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
            dueAt = new Date(Date.now() + 2 * 60 * 1000);
          }

          // Build Command
          const command = {
            commandId,
            commandDeduplicationKey: messageId,
            title,
            priority,
            dueAt,
            timezone,
            userId // Pass user's WhatsApp number directly
          };

          // Build Context
          const context = {
            traceId,
            correlationId,
            userId,
            sessionId: randomUUID(),
            scopes: ['tasks:write'],
            executionMode: 'PRODUCTION' as any, // Force production so reminders fire physically
            tokenBudgetRemaining: 500000,
            isReplay: false,
            isSandbox: false
          };

          // Execute Task creation command!
          const result = await this.commandExecutor.execute(command, context);

          RuntimeEventBus.log('COMMAND_EXECUTED', 'COMMAND',
            `Task creation command executed successfully: ${title}`,
            traceId,
            { commandId, taskId: result.taskId, dueAt: dueAt.toISOString() }
          );

          await this.sendReply(
            userId,
            this.renderer.renderConfirmation({
              commandId,
              commandDeduplicationKey: messageId,
              actionType: (proposal as any).actionIntent,
              payload: payloadObj,
              validatedAt: new Date(),
              traceId,
              correlationId,
              expiresAt: dueAt,
              isDryRun: false
            }),
            messageId
          );
          break;
        }

        default:
          RuntimeEventBus.log('UNHANDLED_PROPOSAL_TYPE', 'ERROR',
            `Unhandled proposal type: ${proposal.proposalType}`,
            traceId
          );
      }
    } catch (error: any) {
      RuntimeEventBus.log('PIPELINE_PROCESS_ERROR', 'ERROR',
        `Pipeline failed: ${error.message}`,
        traceId,
        { stack: error.stack }
      );
      await this.sendReply(
        userId,
        this.renderer.renderError('I encountered an internal error processing your request.'),
        messageId
      );
    } finally {
      await this.sessionRepo.saveSession(session);
    }
  }

  private async sendReply(to: string, body: string, idempotencyKey: string): Promise<void> {
    const msg: WhatsAppMessage = { to, body, idempotencyKey: `reply-${idempotencyKey}` };
    await this.whatsapp.sendMessage(msg, false, false);

    // Save assistant message to MemoryService and trigger background cipherizer
    if (this.memoryService) {
      const replyMessageId = `reply-${idempotencyKey}`;
      await this.memoryService.saveMessageAndRetrievedPastContext(
        to,
        'assistant',
        body,
        replyMessageId,
        idempotencyKey
      ).catch(err => console.error('[MemoryService] Failed to save assistant message:', err));

      // Asynchronously trigger background memory consolidation/cipherizing
      this.memoryService.cipherizeConversation(to, idempotencyKey).catch(err => {
        console.error('[MemoryService] Background cipherizer error:', err);
      });
    }
  }
}
