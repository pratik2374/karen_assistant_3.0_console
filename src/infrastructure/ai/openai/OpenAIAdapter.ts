import OpenAI from 'openai';
import { IOpenAIAdapter, OpenAICompletionRequest } from '../../../application/ports/IOpenAIAdapter';

export class OpenAIAdapter implements IOpenAIAdapter {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  public async generateStructuredOutput(request: OpenAICompletionRequest): Promise<any> {
    try {
      const response = await this.client.chat.completions.create({
        model: request.model || 'gpt-4o', // Default to 4o for structured outputs
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
}
