import { PromptVersion } from '../ai/prompts/PromptRegistry';

export interface OpenAICompletionRequest {
  systemPrompt: PromptVersion;
  contextString: string;
  userQuery: string;
  schemaConfig: Record<string, any>; // The openAiSchema returned by SchemaRegistry
  model?: string;
  temperature?: number;
}

export interface IOpenAIAdapter {
  generateStructuredOutput(request: OpenAICompletionRequest): Promise<any>;
  generateEmbedding(text: string): Promise<number[]>;
}
