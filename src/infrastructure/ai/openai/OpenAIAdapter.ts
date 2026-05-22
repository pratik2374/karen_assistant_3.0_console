import OpenAI from 'openai';
import { IOpenAIAdapter, OpenAICompletionRequest } from '../../../application/ports/IOpenAIAdapter.js';

export class OpenAIAdapter implements IOpenAIAdapter {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  public async generateStructuredOutput(request: OpenAICompletionRequest): Promise<any> {
    try {
      let activeModel = request.model;
      activeModel = 'gpt-5.4';

      console.log(`[OPENAI ADAPTER] Sending request with schema: ${request.schemaConfig?.name}`);
      console.log(JSON.stringify({
        type: 'OPENAI_PAYLOAD_SENT',
        model: request.model || 'gpt-4o',
        resolvedModel: activeModel,
        temperature: request.temperature ?? 0.0,
        schemaName: request.schemaConfig?.name,
        schemaConfig: request.schemaConfig,
        messages: [
          { role: 'system', content: request.systemPrompt.systemPrompt.substring(0, 100) + '...' },
          { role: 'user', content: `CONTEXT:\n${request.contextString.substring(0, 100)}...\n\nUSER INTENT:\n${request.userQuery}` }
        ],
        timestamp: new Date().toISOString()
      }, null, 2));

      const response = await this.client.chat.completions.create({
        model: activeModel,
        temperature: request.temperature ?? 0.0, // Strictly deterministic by default
        response_format: {
          type: 'json_schema',
          json_schema: request.schemaConfig as any
        },
        messages: [
          { role: 'system', content: request.systemPrompt.systemPrompt },
          { role: 'user', content: `CONTEXT:\n${request.contextString}\n\nUSER INTENT:\n${request.userQuery}` }
        ]
      });

      const rawJson = response.choices[0]?.message?.content;
      if (!rawJson) {
        throw new Error('OpenAI returned an empty response');
      }

      return JSON.parse(rawJson);
    } catch (error: any) {
      if (error.status === 429) {
        throw new Error('OpenAI Rate Limit Exceeded');
      }
      throw new Error(`OpenAI API Failure: ${error.message}`);
    }
  }

  public async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
      });
      return response.data[0].embedding;
    } catch (error: any) {
      throw new Error(`OpenAI Embedding Failure: ${error.message}`);
    }
  }
}
