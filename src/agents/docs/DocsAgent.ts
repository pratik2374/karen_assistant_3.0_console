// @ts-nocheck
import { IAgent, AgentContext, AgentExecutionResult } from '../base/IAgent.js';
import { DocumentVaultMongoRepository, DocumentVaultEntry } from '../../infrastructure/persistence/mongo/repositories/DocumentVaultMongoRepository.js';
import { randomUUID } from 'crypto';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { OpenAI, OpenAIAgent } from '@llamaindex/openai';
import { FunctionTool } from 'llamaindex';
import * as dotenv from 'dotenv';
dotenv.config();

export class DocsAgent implements IAgent {
  readonly name = 'DocsAgent';
  readonly domain = 'System/Vault';
  readonly capabilities = ['document_storage', 'document_retrieval', 'secure_vault'];

  constructor(
    private vaultRepo: DocumentVaultMongoRepository,
    private db?: any
  ) {}

  public async execute(context: AgentContext): Promise<AgentExecutionResult> {
    const start = Date.now();
    let bgRemovedFileId: string | undefined = undefined;

    RuntimeEventBus.log('AGENT_STARTED', 'AI',
      `DocsAgent executing intent via LlamaIndex: ${context.intent}`,
      context.traceId
    );

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is missing from environment variables');
      }

      // Define Tools with Zero-LLM Privacy (Links strictly stripped)
      
      const listTool = FunctionTool.from(
        async () => {
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', 'Listing all vault documents (metadata only)', context.traceId);
          const docs = await this.vaultRepo.findAll();
          // Zero-LLM Privacy: Strip out raw link property
          return docs.map(d => ({
            docId: d.docId,
            name: d.name,
            aliases: d.aliases
          }));
        },
        {
          name: 'list_all_vault_documents',
          description: 'Get a list of all secure documents currently stored in the vault, with their document IDs, names, and aliases.',
          parameters: { type: 'object', properties: {} }
        }
      );

      const searchTool = FunctionTool.from(
        async (args: { query: string }) => {
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Searching vault for: "${args.query}" (metadata only)`, context.traceId);
          let docs = await this.vaultRepo.findByAlias(args.query);
          
          // Fallback matching
          if (docs.length === 0) {
            const allDocs = await this.vaultRepo.findAll();
            const qLower = args.query.toLowerCase();
            docs = allDocs.filter(d => d.name.toLowerCase().includes(qLower) || qLower.includes(d.name.toLowerCase()));
          }
          // Zero-LLM Privacy: Strip out raw link property
          return docs.map(d => ({
            docId: d.docId,
            name: d.name,
            aliases: d.aliases
          }));
        },
        {
          name: 'search_vault_documents',
          description: 'Search for secure documents in the vault by name or alias. Returns metadata only.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The document name, alias, or search term.' }
            },
            required: ['query']
          }
        }
      );

      const storeTool = FunctionTool.from(
        async (args: { name: string; urlPlaceholder: string; existingDocId?: string }) => {
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Store/Update document: name="${args.name}", placeholder="${args.urlPlaceholder}", existingDocId="${args.existingDocId || ''}"`, context.traceId);
          
          // Unmask the URL or fallback to the raw plain text value
          let realUrl = (context as any).urlMasks?.[args.urlPlaceholder];
          if (!realUrl) {
            if (args.urlPlaceholder.startsWith('{{MASKED_URL_')) {
              throw new Error(`Failed to store document. The URL placeholder "${args.urlPlaceholder}" was not found or is invalid.`);
            }
            realUrl = args.urlPlaceholder;
          }

          // Programmatic Smart-Matching & Updating
          let matchedDoc: DocumentVaultEntry | null = null;

          if (args.existingDocId) {
            matchedDoc = await this.vaultRepo.findById(args.existingDocId);
          }

          if (!matchedDoc) {
            // Attempt automatic lookup by name or alias
            const allDocs = await this.vaultRepo.findAll();
            const targetNameLower = args.name.toLowerCase();
            matchedDoc = allDocs.find(d => 
              d.name.toLowerCase() === targetNameLower || 
              d.aliases.some(a => a.toLowerCase() === targetNameLower)
            ) || null;
          }

          if (matchedDoc) {
            // Smart update existing document link, preserving its docId and aliases!
            matchedDoc.link = realUrl;
            await this.vaultRepo.save(matchedDoc);
            RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Smart updated existing document "${matchedDoc.name}" with new link.`, context.traceId);
            return {
              status: 'UPDATED',
              message: `Successfully updated the document "${matchedDoc.name}" with the new link.`,
              docId: matchedDoc.docId,
              name: matchedDoc.name
            };
          } else {
            // Store new document
            const newDoc: DocumentVaultEntry = {
              docId: randomUUID(),
              name: args.name,
              aliases: [args.name.toLowerCase()],
              link: realUrl
            };
            await this.vaultRepo.save(newDoc);
            RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Stored new document "${args.name}" with ID: ${newDoc.docId}`, context.traceId);
            return {
              status: 'CREATED',
              message: `Successfully stored new document "${args.name}" securely.`,
              docId: newDoc.docId,
              name: args.name
            };
          }
        },
        {
          name: 'store_vault_document',
          description: 'Store a new document or update an existing document link. Use this tool whenever the user asks to save, upload, or update a document link.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The name of the document or credential.' },
              urlPlaceholder: { type: 'string', description: 'The exact {{MASKED_URL_x}} placeholder representing the URL, or the raw plain text secret/password/link if it was not masked.' },
              existingDocId: { type: 'string', description: 'Optional. The exact docId of an existing document if updating a specific one.' }
            },
            required: ['name', 'urlPlaceholder']
          }
        }
      );

      const deleteTool = FunctionTool.from(
        async (args: { docId: string }) => {
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Deleting document: ID="${args.docId}"`, context.traceId);
          const existing = await this.vaultRepo.findById(args.docId);
          if (!existing) {
            throw new Error(`No document found in vault with ID: "${args.docId}"`);
          }
          await this.vaultRepo.delete(args.docId);
          return {
            status: 'DELETED',
            message: `Successfully deleted document "${existing.name}" from the vault.`
          };
        },
        {
          name: 'delete_vault_document',
          description: 'Delete a document from the secure vault by its unique docId.',
          parameters: {
            type: 'object',
            properties: {
              docId: { type: 'string', description: 'The unique docId of the document to delete.' }
            },
            required: ['docId']
          }
        }
      );

      const removeBgTool = FunctionTool.from(
        async (args: { imageUrlPlaceholder: string; format?: string }) => {
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Remove background tool called for URL: ${args.imageUrlPlaceholder} | Format: ${args.format || 'png'}`, context.traceId);
          
          const realUrl = (context as any).urlMasks?.[args.imageUrlPlaceholder] || args.imageUrlPlaceholder;
          if (!realUrl) {
            throw new Error(`Failed to process image. URL placeholder "${args.imageUrlPlaceholder}" is invalid.`);
          }

          const apiKey = process.env.REMOVE_BG_API_KEY;
          if (!apiKey) {
            throw new Error('REMOVE_BG_API_KEY is missing from your environment variables.');
          }

          const clientId = process.env.GOOGLE_CLIENT_ID;
          const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
          const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
          const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

          if (!clientId || !clientSecret || !refreshToken) {
            throw new Error('Google OAuth credentials are missing from your .env file!');
          }

          // 1. Download source image
          let imageBuffer: Buffer;
          const driveIdMatch = realUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
          
          if (driveIdMatch) {
            const fileId = driveIdMatch[1];
            RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Downloading source image directly from Google Drive API. File ID: ${fileId}`, context.traceId);
            
            const { google } = await import('googleapis');
            const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000');
            oauth2Client.setCredentials({ refresh_token: refreshToken });
            const drive = google.drive({ version: 'v3', auth: oauth2Client });
            
            const driveRes = await drive.files.get(
              { fileId, alt: 'media' },
              { responseType: 'arraybuffer' }
            );
            imageBuffer = Buffer.from(driveRes.data as ArrayBuffer);
          } else {
            RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Downloading source image from external URL: ${realUrl}`, context.traceId);
            const dlRes = await fetch(realUrl);
            if (!dlRes.ok) {
              throw new Error(`Failed to download source image from URL: HTTP ${dlRes.status}`);
            }
            imageBuffer = Buffer.from(await dlRes.arrayBuffer());
          }

          // 2. Call remove.bg API
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Calling remove.bg API to process image`, context.traceId);
          const formData = new FormData();
          formData.append('size', 'auto');
          formData.append('image_file', new Blob([imageBuffer]));
          if (args.format) {
            formData.append('format', args.format.toLowerCase()); // png, jpg, webp, zip
          }

          const removeRes = await fetch('https://api.remove.bg/v1.0/removebg', {
            method: 'POST',
            headers: {
              'X-Api-Key': apiKey
            },
            body: formData
          });

          if (!removeRes.ok) {
            const errText = await removeRes.text().catch(() => '');
            throw new Error(`remove.bg API call failed: HTTP ${removeRes.status} | ${errText}`);
          }

          const processedBuffer = Buffer.from(await removeRes.arrayBuffer());
          RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Background removed successfully. Processed buffer size: ${processedBuffer.length} bytes`, context.traceId);

          // 3. Upload background-removed image to temporary folder in Google Drive
          const ext = (args.format || 'png').toLowerCase();
          const filename = `no-bg-${Date.now()}.${ext === 'zip' ? 'zip' : ext}`;
          const mimeType = ext === 'zip' ? 'application/zip' : `image/${ext}`;
          
          const { google } = await import('googleapis');
          const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000');
          oauth2Client.setCredentials({ refresh_token: refreshToken });
          const drive = google.drive({ version: 'v3', auth: oauth2Client });

          const { Readable } = await import('stream');
          const mediaStream = new Readable();
          mediaStream.push(processedBuffer);
          mediaStream.push(null);

          const fileMetadata: any = { name: filename };
          if (folderId) {
            fileMetadata.parents = [folderId];
          }

          const uploadResponse = await drive.files.create({
            requestBody: fileMetadata,
            media: {
              mimeType,
              body: mediaStream
            },
            fields: 'id, name, webViewLink'
          });

          const fileId = uploadResponse.data.id;
          if (!fileId) {
            throw new Error('Google Drive upload response did not return a file ID.');
          }

          // Make publicly readable
          try {
            await drive.permissions.create({
              fileId: fileId,
              requestBody: {
                role: 'reader',
                type: 'anyone'
              }
            });
          } catch (permErr: any) {
            console.warn(`[RemoveBgTool] Failed to configure Drive permission: ${permErr.message}`);
          }

          const viewLink = `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`;

          // 4. Schedule standard 10-minute cleanup timer using HybridTimerService
          const timerService = (this as any).timerService;
          if (timerService) {
            await timerService.schedule({
              timerId: randomUUID(),
              sagaId: fileId,
              sagaType: 'BgRemovedCleanup',
              actionIntent: 'TEMP_MEDIA_CLEANUP',
              payload: { type: 'BG_REMOVED_FILE', driveFileId: fileId },
              targetWakeTime: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
              status: 'PENDING',
              traceId: context.traceId,
              correlationId: randomUUID()
            });
            RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Scheduled 10-minute temporary file cleanup timer for Drive file: ${fileId}`, context.traceId);
          }

          // 4b. Also store it in staged_media collection so replies can correlate!
          const activeDb = this.db;
          if (activeDb) {
            await activeDb.collection('staged_media').insertOne({
              mediaId: `bg-removed-${fileId}`,
              userId: context.userId,
              messageId: `bg-removed-msg-${fileId}`,
              assistantReplyMessageId: `pending-${fileId}`, // We will update this later in the pipeline!
              type: 'image',
              mimeType,
              filename,
              driveFileId: fileId,
              driveLink: viewLink,
              status: 'PENDING',
              createdAt: new Date()
            });
            RuntimeEventBus.log('DOCS_AGENT_TOOL', 'SYSTEM', `Staged background-removed image in staged_media for reply correlation: bg-removed-${fileId}`, context.traceId);
          }

          bgRemovedFileId = fileId;

          // 5. Store metadata in permanent Vault repository
          const docId = randomUUID();
          await this.vaultRepo.save({
            docId,
            name: `Processed Background-Removed Image (${filename})`,
            aliases: [`no-bg-${fileId}`, filename.toLowerCase()],
            link: viewLink
          });

          const placeholder = `{{VAULT_DOC:${docId}}}`;
          return {
            status: 'SUCCESS',
            message: 'Background successfully removed! Saved in Google Drive staging.',
            driveLink: viewLink,
            vaultPlaceholder: placeholder,
            docId: docId
          };
        },
        {
          name: 'remove_image_background',
          description: 'Remove the background of an image. Returns a secure vault link placeholder to the background-removed image, which will be automatically deleted from Google Drive after 10 minutes.',
          parameters: {
            type: 'object',
            properties: {
              imageUrlPlaceholder: { type: 'string', description: 'The {{MASKED_URL_x}} placeholder representing the image URL, or the raw image URL.' },
              format: { type: 'string', enum: ['PNG', 'JPG', 'WebP', 'ZIP'], description: 'Optional. Output image format. Defaults to PNG.' }
            },
            required: ['imageUrlPlaceholder']
          }
        }
      );

      // Initialize LlamaIndex LLM & Agent
      const llm = new OpenAI({
        apiKey,
        model: 'gpt-4o-mini',
        temperature: 0,
      });

      const agent = new OpenAIAgent({
        tools: [listTool, searchTool, storeTool, deleteTool, removeBgTool],
        llm,
        verbose: true,
      });

      const userQuery = context.payload?.userQuery || context.payload?.query || context.intent || '';
      const conversationContext = context.payload?.conversationContext || '';

      const query = `
You are the Karen Secure Document Vault Agent.
Your job is to manage the user's personal documents (such as Aadhar, PAN, Passports, etc.) in the secure vault.
You have access to tools to list all documents, search documents, store/update a document, delete a document, and remove image backgrounds.

${conversationContext ? `Here is the recent context of this conversation to help resolve pronouns like "it", "that", "hairstyle", etc.:\n${conversationContext}\n` : ''}

PRONOUN RESOLUTION RULE:
- If the user's query is highly generic (like "link?", "link of it", "show me that", "what is the link", "retrieve it"), and the recent conversation history context shows that a document was just stored, uploaded, updated, or discussed in the last few turns (for example, "bhaat" or "dhoni"), you MUST assume "it" or "link" refers to that specific document!
- In that case, you must search or retrieve that specific document (e.g. search for "bhaat") instead of searching for the literal word "link" or picking a document that literally has "link" in its name.
- NEVER search for the literal string "link" if it's obvious they mean the recently uploaded/discussed document.

CRITICAL PRIVACY RULE:
- Document links are 100% hidden from you. The database tools will only return document metadata (ID, name, and aliases) and will never return the raw link.
- When retrieving or referring to a document, you MUST NEVER attempt to guess or output a raw URL link. Instead, you MUST output a secure placeholder in the exact format: {{VAULT_DOC:docId}} where "docId" is the exact ID of the document (e.g. {{VAULT_DOC:123-456}}).
- The outbound messaging pipeline will automatically intercept this placeholder and safely inject the actual URL.
- When saving or updating a document/credential, if the user sent a raw URL link, it has been masked as a placeholder like {{MASKED_URL_1}}. You must pass this exact placeholder as the "urlPlaceholder" argument.
- If the user sent a plain text secret, a password, a contact number, or a text link (e.g. pratikgond.tech or MySecretPassword) which did NOT get masked, you must pass that raw plain text directly as the "urlPlaceholder" argument to the store_vault_document tool.

BACKGROUND REMOVAL INSTRUCTIONS:
- If the user asks to remove the background of an image or a URL, call the remove_image_background tool.
- It will automatically process the image and return a secure Vault placeholder like {{VAULT_DOC:docId}}. You must report this placeholder to the user in your final message so they can download it. Mention that the temporary file will be automatically deleted from Google Drive after 10 minutes.

SMART UPDATE BEHAVIOR:
- If the user asks to save, upload, or update a document (e.g. "update my aadhar link to https://..."), first search or list the vault documents to check if a document with a matching name or alias (e.g., "Aadhar" or "aadhar") already exists.
- If an existing document matches, call the store_vault_document tool. You can pass the matched document's ID as the "existingDocId" parameter to update the existing entry. Alternatively, the tool itself can perform smart-matching based on the name.
- Be conversational and professional.

Original User Query: "${userQuery}"
`;

      const response = await agent.chat({
        message: query,
      });

      const summaryReport = response.toString();

      RuntimeEventBus.log('AGENT_COMPLETED', 'AI',
        `DocsAgent SUCCESS | ${Date.now() - start}ms | intent: ${context.intent}`,
        context.traceId
      );

      return {
        status: 'SUCCESS',
        data: { bgRemovedFileId },
        summaryReport,
        mutationsCount: 1,
        latencyMs: Date.now() - start,
      };

    } catch (err: any) {
      RuntimeEventBus.log('AGENT_FAILED', 'ERROR',
        `DocsAgent failed: ${err.message}`,
        context.traceId
      );
      const safeErrorMessage = err.message.length > 1000 ? err.message.substring(0, 1000) + '... [truncated]' : err.message;
      return {
        status: 'FAILED',
        data: {},
        summaryReport: `Vault operation failed: ${safeErrorMessage}`,
        mutationsCount: 0,
        latencyMs: Date.now() - start,
        errorCode: 'AGENT_EXECUTION_ERROR',
      };
    }
  }
}
