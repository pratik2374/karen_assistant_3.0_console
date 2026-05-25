// @ts-nocheck
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
import { AgentRouter } from '../agents/AgentRouter.js';
import { DocumentVaultMongoRepository } from '../../infrastructure/persistence/mongo/repositories/DocumentVaultMongoRepository.js';
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
    private memoryService?: MemoryService,
    private agentRouter?: AgentRouter,
    private vaultRepo?: DocumentVaultMongoRepository
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

    // ZERO-LLM INBOUND URL MASKING
    const urlMasks: Record<string, string> = {};
    let maskedMessageText = messageText;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    let matchCount = 0;
    maskedMessageText = maskedMessageText.replace(urlRegex, (match) => {
      matchCount++;
      const maskKey = `{{MASKED_URL_${matchCount}}}`;
      urlMasks[maskKey] = match;
      return maskKey;
    });

    if (matchCount > 0) {
      RuntimeEventBus.log('PIPELINE_URL_MASK', 'SECURITY', `Masked ${matchCount} inbound URLs from LLM.`, traceId);
    }

    const session = await this.sessionRepo.getSession(userId);

    // Save user message and fetch/cache its retrieved past dialogue matches
    if (this.memoryService) {
      await this.memoryService.saveMessageAndRetrievedPastContext(
        userId,
        'user',
        maskedMessageText,
        messageId,
        traceId
      ).catch(err => console.error('[MemoryService] Failed to save user message:', err));
    }

    if (this.orchestrator) {
      const orchestratorResult = await this.orchestrator.orchestrate(userId, maskedMessageText, messageId, traceId);
      if (!orchestratorResult.shouldExecuteDirectly) {
        await this.sendReply(userId, orchestratorResult.responseText, messageId);
        return;
      }
    }

    let queryToProcess = maskedMessageText;

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

        case ProposalType.TOOL_REQUEST:
        case ProposalType.COMMAND_PROPOSAL: {
          const isTool = proposal.proposalType === ProposalType.TOOL_REQUEST;
          const actionIntent = isTool ? (proposal as any).toolName : (proposal as any).actionIntent;
          const rawPayload = isTool ? (proposal as any).toolArguments : (proposal as any).rawPayload;

          RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'COMMAND',
            `Dispatching command/tool: ${actionIntent}`,
            traceId
          );

          let payloadObj: any = {};
          if (typeof rawPayload === 'string') {
            try {
              payloadObj = JSON.parse(rawPayload);
            } catch (e) {
              payloadObj = {};
            }
          } else {
            payloadObj = rawPayload || {};
          }

          // Log payloadObj keys and values for transparency
          RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'COMMAND',
            `Raw payload parsed keys: ${Object.keys(payloadObj).join(', ')} | Content: ${JSON.stringify(payloadObj)}`,
            traceId
          );

          const commandId = randomUUID();
          const correlationId = randomUUID();

          const intentAction = (actionIntent || '').toLowerCase();

          if (this.agentRouter && this.agentRouter.canRoute(intentAction)) {
            try {
              const agentContext = {
                intent: intentAction,
                payload: payloadObj,
                userId,
                traceId,
                correlationId,
                isReplay: false,
                isSandbox: false,
              };
              (agentContext as any).urlMasks = urlMasks; // Inject for DocsAgent unmasking

              const routerResult = await this.agentRouter.route(intentAction, agentContext);

              if (routerResult.routed) {
                const { result } = routerResult;
                await this.sendReply(userId, result.summaryReport, messageId);
              } else {
                await this.sendReply(userId, "I couldn't process that request right now. Please try rephrasing.", messageId);
              }
            } catch (err: any) {
              console.error('[AgentRouter] Dispatch failed:', err);
              await this.sendReply(userId, "I'm sorry, I encountered an error fulfilling your request.", messageId);
            }
          } else {
            RuntimeEventBus.log('UNROUTED_INTENT', 'ERROR',
              `No agent available to route intent: ${intentAction}`,
              traceId
            );
            await this.sendReply(userId, "I don't have an agent available to handle that request.", messageId);
          }
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
    if (!body || body.trim() === '') {
      console.warn('[INBOUND PIPELINE] Warning: Attempted to send empty reply. Skipping WhatsApp payload.');
      return;
    }

    // LATE-BINDING LINK INJECTION (OUTBOUND)
    let finalBody = body;
    if (this.vaultRepo && finalBody.includes('{{VAULT_DOC:')) {
      const docRegex = /\{\{VAULT_DOC:([a-zA-Z0-9_-]+)\}\}/g;
      const matches = Array.from(finalBody.matchAll(docRegex));
      
      for (const match of matches) {
        const docId = match[1];
        const doc = await this.vaultRepo.findById(docId);
        if (doc) {
          finalBody = finalBody.replace(match[0], doc.link);
        } else {
          finalBody = finalBody.replace(match[0], '[Document Link Not Found]');
        }
      }
      RuntimeEventBus.log('PIPELINE_LINK_INJECT', 'SECURITY', `Injected ${matches.length} secure document links for outbound message.`);
    }

    const msg: WhatsAppMessage = { to, body: finalBody, idempotencyKey: `reply-${idempotencyKey}` };
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
