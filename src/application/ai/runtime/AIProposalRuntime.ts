import { ContextEngine, RetrievalIntent } from '../ContextEngine';
import { PromptRegistry } from '../prompts/PromptRegistry';
import { SchemaRegistry } from '../schemas/SchemaRegistry';
import { IOpenAIAdapter } from '../../ports/IOpenAIAdapter';
import { ClarificationEngine } from './ClarificationEngine';
import { AIProposal, ProposalType } from '../../commands/CommandStandard';
import { AIObservabilityHook } from '../../../infrastructure/observability/metrics/AIObservabilityHook';
import { IMemoryBlock } from '../../../domain/memory/MemoryTiers';

export class AIProposalRuntime {
  constructor(
    private contextEngine: ContextEngine,
    private promptRegistry: PromptRegistry,
    private schemaRegistry: SchemaRegistry,
    private openAiAdapter: IOpenAIAdapter,
    private clarificationEngine: ClarificationEngine,
    private observabilityHook: AIObservabilityHook
  ) {}

  public async generateProposal(
    query: string,
    intentTags: string[],
    mode: string,
    traceId: string,
    availableMemories: IMemoryBlock[]
  ): Promise<AIProposal> {
    
    // 1. Context Assembly (Retrieval, Budgeting, Sanitization)
    const intent: RetrievalIntent = { query, tags: intentTags, mode: mode as any, traceId };
    const assembledContext = await this.contextEngine.assembleContext(intent, availableMemories);

    // 2. Prompt Governance
    const prompt = this.promptRegistry.getPrompt('STANDARD_PROPOSAL');

    // 3. Schema Retrieval
    const schemaConfig = this.schemaRegistry.getOpenAiSchema('AIProposal_v1');

    // 4. Model Routing
    const model = mode === 'FAST' ? 'gpt-4o-mini' : 'gpt-4o';

    // 5. OpenAI Execution
    let rawResult: any;
    try {
      rawResult = await this.openAiAdapter.generateStructuredOutput({
        systemPrompt: prompt,
        contextString: JSON.stringify(assembledContext.blocks),
        userQuery: query,
        schemaConfig,
        model,
        temperature: 0.0
      });
    } catch (error: any) {
      this.observabilityHook.recordFailure('OPENAI_API_ERROR', error.message, traceId);
      throw error;
    }

    // 6. Local Validation
    let validatedProposal: AIProposal;
    try {
      validatedProposal = this.schemaRegistry.validateLocally<AIProposal>('AIProposal_v1', rawResult);
      this.observabilityHook.recordProposalGenerated(
        validatedProposal.proposalType,
        model,
        assembledContext.totalTokens,
        traceId
      );
    } catch (error: any) {
      this.observabilityHook.recordFailure('SCHEMA_VALIDATION_ERROR', error.message, traceId);
      // Fallback to clarification instead of crashing if possible
      return this.clarificationEngine.generateClarification('I encountered an internal error formatting my response. Could you please rephrase?', query);
    }

    // 7. Confidence Governance & Clarification
    if (validatedProposal.proposalType !== ProposalType.CLARIFICATION_REQUEST) {
      if (validatedProposal.confidence < 0.8) {
        this.observabilityHook.recordClarificationTriggered('LOW_CONFIDENCE', validatedProposal.confidence, traceId);
        return this.clarificationEngine.generateClarification(
          'I am not entirely sure what you want me to do. Could you clarify your intent?',
          query
        );
      }
    }

    return validatedProposal;
  }
}
