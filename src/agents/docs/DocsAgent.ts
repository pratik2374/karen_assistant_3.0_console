import { IAgent, AgentContext, AgentExecutionResult } from '../base/IAgent.js';
import { DocumentVaultMongoRepository, DocumentVaultEntry } from '../../infrastructure/persistence/mongo/repositories/DocumentVaultMongoRepository.js';
import { randomUUID } from 'crypto';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';

export interface DocsAgentPayload {
  action: 'RETRIEVE' | 'STORE';
  query?: string;
  name?: string;
  urlPlaceholder?: string;
}

export class DocsAgent implements IAgent {
  public name = 'DocsAgent';
  public domain = 'System/Vault';
  public capabilities = ['document_storage', 'document_retrieval', 'secure_vault'];

  constructor(private vaultRepo: DocumentVaultMongoRepository) {}

  public async execute(context: AgentContext & { intent: string; payload: DocsAgentPayload }): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    const { action } = context.payload;

    try {
      if (action === 'RETRIEVE') {
        const query = context.payload.query || '';
        RuntimeEventBus.log('DOCS_AGENT_RETRIEVE', 'SYSTEM', `Searching vault for: "${query}"`, context.traceId);
        
        let docs: DocumentVaultEntry[] = [];
        if (query.toLowerCase() === 'all') {
          docs = await this.vaultRepo.findAll();
        } else {
          docs = await this.vaultRepo.findByAlias(query);
        }

        if (docs.length === 0) {
          return {
            status: 'SUCCESS',
            summaryReport: `I could not find any documents matching "${query}" in the vault.`,
            data: { matched: 0 },
            mutationsCount: 0,
            latencyMs: Date.now() - startTime
          };
        }

        let responseText = docs.length === 1 
          ? `Found document: ${docs[0].name}. Here is the link: ` 
          : `Found ${docs.length} documents. Here are the links:\n`;

        docs.forEach(doc => {
          responseText += `${doc.name}: {{VAULT_DOC:${doc.docId}}}\n`;
        });

        return {
          status: 'SUCCESS',
          summaryReport: responseText.trim(),
          data: { docs },
          mutationsCount: 0,
          latencyMs: Date.now() - startTime
        };

      } else if (action === 'STORE') {
        const name = context.payload.name;
        const placeholder = context.payload.urlPlaceholder;

        if (!name || !placeholder) {
          return { 
            status: 'FAILED',
            summaryReport: 'Missing name or urlPlaceholder to store the document.',
            data: {},
            mutationsCount: 0,
            latencyMs: Date.now() - startTime
          };
        }

        // Unmask the URL
        const realUrl = (context as any).urlMasks?.[placeholder];

        if (!realUrl) {
          RuntimeEventBus.log('DOCS_AGENT_STORE_FAIL', 'ERROR', `Could not unmask placeholder: ${placeholder}`, context.traceId);
          return { 
            status: 'FAILED',
            summaryReport: `I failed to save the document. The link mask ${placeholder} was invalid.`,
            data: {},
            mutationsCount: 0,
            latencyMs: Date.now() - startTime
          };
        }

        const newDoc: DocumentVaultEntry = {
          docId: randomUUID(),
          name,
          aliases: [name.toLowerCase()],
          link: realUrl
        };

        await this.vaultRepo.save(newDoc);
        RuntimeEventBus.log('DOCS_AGENT_STORE', 'SYSTEM', `Saved new document to vault: "${name}"`, context.traceId);

        return {
          status: 'SUCCESS',
          summaryReport: `Successfully stored "${name}" securely in the vault.`,
          data: { docId: newDoc.docId },
          mutationsCount: 1,
          latencyMs: Date.now() - startTime
        };
      }

      return { 
        status: 'FAILED',
        summaryReport: 'Unknown DocsAgent action.',
        data: {},
        mutationsCount: 0,
        latencyMs: Date.now() - startTime
      };

    } catch (err: any) {
      RuntimeEventBus.log('DOCS_AGENT_ERROR', 'ERROR', err.message, context.traceId);
      return { 
        status: 'FAILED',
        summaryReport: `Failed to access the document vault: ${err.message}`,
        data: {},
        mutationsCount: 0,
        latencyMs: Date.now() - startTime
      };
    }
  }
}
