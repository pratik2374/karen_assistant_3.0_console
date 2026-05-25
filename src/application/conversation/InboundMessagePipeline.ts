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
  public static vaultRepoInstance?: DocumentVaultMongoRepository;

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

  public timerService?: any;

  public async process(
    userId: string,
    messageText: string,
    messageId: string,
    traceId: string,
    parentMessageId?: string,
    mediaDetails?: any
  ): Promise<void> {
    RuntimeEventBus.log('PIPELINE_PROCESS_START', 'TRANSPORT',
      `Pipeline process started for message "${messageText || ''}". Reply to: ${parentMessageId || 'none'} | Media: ${mediaDetails ? mediaDetails.type : 'none'}`,
      traceId
    );

    const db = this.persistence?.db;
    const urlMasks: Record<string, string> = {};
    let finalQueryText = messageText || '';

    // A. INCOMING STAGED MEDIA REPLY CORRELATION
    if (parentMessageId && db) {
      // FIX QUERY: search by messageId, NOT mediaId
      const staged = await db.collection('staged_media').findOne({ messageId: parentMessageId });
      if (staged) {
        RuntimeEventBus.log('PIPELINE_REPLY_MATCH', 'TRANSPORT', `Incoming message correlates to staged media ID: ${staged.mediaId} | Status: ${staged.status}`, traceId);

        const tenMinutesMs = 10 * 60 * 1000;
        const isExpired = staged.status === 'EXPIRED' || (Date.now() - staged.createdAt.getTime() > tenMinutesMs);

        if (isExpired) {
          RuntimeEventBus.log('PIPELINE_REPLY_EXPIRED', 'TRANSPORT', `Correlated staged media has expired. Sending Scenario 2 response.`, traceId);
          await this.sendReply(userId, "Sorry Sir, I am punctual not like you, I deleted it after 10 minutes sharp.", messageId);
          return;
        }

        // Active staged media: Catalog permanently in vault
        const vaultRepo = this.vaultRepo || InboundMessagePipeline.vaultRepoInstance;
        if (vaultRepo) {
          const docId = randomUUID();
          const docName = messageText || staged.filename || `Document-${Date.now()}`;
          const secureLink = staged.driveLink;

          await vaultRepo.save({
            docId,
            name: docName,
            aliases: [docName.toLowerCase()],
            link: secureLink
          });

          await db.collection('staged_media').updateOne(
            { mediaId: staged.mediaId },
            { $set: { status: 'PROCESSED' } }
          );

          RuntimeEventBus.log('PIPELINE_REPLY_SAVED', 'TRANSPORT', `Staged media successfully cataloged in Vault. docId: ${docId}`, traceId);

          const vaultPlaceholder = `{{VAULT_DOC:${docId}}}`;
          await this.sendReply(userId, `Successfully registered! Secured inside your Vault:\n- Name: *${docName}*\n- Vault ID: *${docId}*\n- Shareable Link: ${vaultPlaceholder}`, messageId);
          return;
        } else {
          throw new Error('DocumentVaultRepository instance not available to store permanent record!');
        }
      }
    }

    // B. MEDIA INGRESS STAGING / CAPTION FLOW
    if (mediaDetails && db) {
      try {
        const { buffer, mimeType } = await this.downloadWhatsAppMedia(mediaDetails.mediaId, traceId);
        
        const { fileId, viewLink } = await this.uploadToGoogleDrive(
          mediaDetails.filename || `WhatsApp-Media-${Date.now()}`,
          mimeType,
          buffer,
          traceId
        );

        if (!messageText || messageText.trim() === '') {
          // Standard temporary staging (Scenario 1)
          const stagedRecord = {
            mediaId: mediaDetails.mediaId,
            userId,
            messageId,
            type: mediaDetails.type,
            mimeType,
            filename: mediaDetails.filename,
            driveFileId: fileId,
            driveLink: viewLink,
            status: 'PENDING',
            createdAt: new Date()
          };
          await db.collection('staged_media').insertOne(stagedRecord);

          const timerService = this.timerService || (this as any).timerService;
          if (timerService) {
            const timerId = randomUUID();
            await timerService.schedule({
              timerId,
              sagaId: mediaDetails.mediaId,
              sagaType: 'StagedMediaCleanup',
              actionIntent: 'TEMP_MEDIA_CLEANUP',
              payload: { type: 'STAGED_MEDIA', driveFileId: fileId, mediaId: mediaDetails.mediaId },
              targetWakeTime: new Date(Date.now() + 10 * 60 * 1000),
              status: 'PENDING',
              traceId,
              correlationId: randomUUID()
            });
            RuntimeEventBus.log('PIPELINE_MEDIA_TIMER_SCHEDULED', 'TRANSPORT', `Temporary staging 10-minute cleanup timer scheduled. ID: ${timerId}`, traceId);
          }

          const mediaWord = mediaDetails.type === 'image' ? 'image' : 'file';
          await this.sendReply(userId, `Sir, what should I do with this ${mediaWord}? After 10 minutes I will delete it.`, messageId);
          return;
        } else {
          // Direct permanent store via caption fast-track!
          const maskKey = `{{MASKED_URL_99}}`;
          urlMasks[maskKey] = viewLink;
          finalQueryText = `${messageText} ${maskKey}`;
          RuntimeEventBus.log('PIPELINE_CAPTION_FAST_TRACK', 'TRANSPORT', `Fast-tracking caption flow with temporary Drive URL: ${viewLink}`, traceId);
        }
      } catch (err: any) {
        console.error('[InboundPipeline] Media staging flow failed:', err);
        await this.sendReply(userId, `Failed to stage attachment: ${err.message}`, messageId);
        return;
      }
    }

    // ZERO-LLM INBOUND URL MASKING
    let maskedMessageText = finalQueryText;
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

    let finalBody = body;
    const activeVaultRepo = this.vaultRepo || InboundMessagePipeline.vaultRepoInstance;
    
    if (activeVaultRepo && finalBody.includes('{{VAULT_DOC:')) {
      const docRegex = /\{\{VAULT_DOC:([a-zA-Z0-9_-]+)\}\}/g;
      const matches = Array.from(finalBody.matchAll(docRegex));
      
      for (const match of matches) {
        const docId = match[1];
        try {
          const doc = await activeVaultRepo.findById(docId);
          if (doc) {
            finalBody = finalBody.replace(match[0], doc.link);
          } else {
            finalBody = finalBody.replace(match[0], '[Document Link Not Found]');
          }
        } catch (err) {
          console.error('[INBOUND PIPELINE] Error fetching vault doc:', err);
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

  private async downloadWhatsAppMedia(mediaId: string, traceId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const token = process.env.WHATSAPP_PHONE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
      throw new Error('Meta Graph API WhatsApp Access Token (WHATSAPP_PHONE_ACCESS_TOKEN or WHATSAPP_ACCESS_TOKEN) is missing!');
    }

    RuntimeEventBus.log('MEDIA_DOWNLOAD_START', 'TRANSPORT', `Fetching media metadata for: ${mediaId}`, traceId);
    
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!metaRes.ok) {
      const errBody = await metaRes.text().catch(() => '');
      throw new Error(`Meta Graph API media metadata fetch failed: HTTP ${metaRes.status} | ${errBody}`);
    }

    const metadata: any = await metaRes.json();
    const downloadUrl = metadata.url;
    const mimeType = metadata.mime_type || 'application/octet-stream';

    if (!downloadUrl) {
      throw new Error(`Meta Graph API returned no download URL for mediaId: ${mediaId}`);
    }

    RuntimeEventBus.log('MEDIA_DOWNLOAD_URL_RETRIEVED', 'TRANSPORT', `Downloading media from CDN URL`, traceId);

    const fileRes = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!fileRes.ok) {
      throw new Error(`Meta Graph API media binary download failed: HTTP ${fileRes.status}`);
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    RuntimeEventBus.log('MEDIA_DOWNLOAD_SUCCESS', 'TRANSPORT', `Successfully downloaded media buffer. Size: ${buffer.length} bytes`, traceId);
    
    return { buffer, mimeType };
  }

  private async uploadToGoogleDrive(
    filename: string,
    mimeType: string,
    buffer: Buffer,
    traceId: string
  ): Promise<{ fileId: string; viewLink: string }> {
    const { google } = await import('googleapis');
    
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Google OAuth credentials (ID, Secret, or Refresh Token) are missing from your .env file!');
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000');
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    RuntimeEventBus.log('DRIVE_UPLOAD_START', 'TRANSPORT', `Uploading file "${filename}" to Google Drive`, traceId);

    const { Readable } = await import('stream');
    const mediaStream = new Readable();
    mediaStream.push(buffer);
    mediaStream.push(null);

    const fileMetadata: any = {
      name: filename
    };
    if (folderId) {
      fileMetadata.parents = [folderId];
    }

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: mimeType,
        body: mediaStream
      },
      fields: 'id, name, webViewLink'
    });

    const fileId = response.data.id;
    if (!fileId) {
      throw new Error('Google Drive upload response did not contain a file ID.');
    }

    try {
      await drive.permissions.create({
        fileId: fileId,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });
      RuntimeEventBus.log('DRIVE_PERMISSIONS_SUCCESS', 'TRANSPORT', `Shareable permissions configured for Drive File ID: ${fileId}`, traceId);
    } catch (permErr: any) {
      console.warn(`[DriveUpload] Failed to set permissions (non-fatal): ${permErr.message}`);
    }

    const viewLink = `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`;
    RuntimeEventBus.log('DRIVE_UPLOAD_SUCCESS', 'TRANSPORT', `File uploaded successfully. ID: ${fileId} | Link: ${viewLink}`, traceId);

    return { fileId, viewLink };
  }
}
