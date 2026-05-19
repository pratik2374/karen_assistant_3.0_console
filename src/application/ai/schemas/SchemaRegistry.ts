import { z } from 'zod';
import { AIProposalSchema } from '../../commands/CommandStandard';

// Wrap union in a root object to bypass OpenAI's root-level union constraint
export const AIProposalRootSchema = z.object({
  proposal: AIProposalSchema
});

export interface RegisteredSchema {
  version: string;
  zodSchema: z.ZodTypeAny;
  openAiSchema: Record<string, any>;
}

export class SchemaRegistry {
  private schemas: Map<string, RegisteredSchema> = new Map();

  constructor() {
    this.register('AIProposal_v1', AIProposalRootSchema);
  }

  public register(name: string, schema: z.ZodTypeAny): void {
    // Generate strict JSON schema natively from Zod v4
    const openAiSchema = (schema as any).toJSONSchema();

    // OpenAI structured outputs require additional constraints for 'strict: true'
    // such as `additionalProperties: false` on all objects
    this.enforceStrictConstraints(openAiSchema);

    // Explicitly add top-level required fields for OpenAPI strict schema spec
    if (openAiSchema.properties) {
      openAiSchema.required = Object.keys(openAiSchema.properties);
    }

    console.log(`[SCHEMA REGISTRY] Registering schema: ${name}`);
    console.log(JSON.stringify(openAiSchema, null, 2));

    this.schemas.set(name, {
      version: '1.0',
      zodSchema: schema,
      openAiSchema: {
        name,
        strict: true,
        schema: openAiSchema
      }
    });
  }

  public getOpenAiSchema(name: string): Record<string, any> {
    const s = this.schemas.get(name);
    if (!s) throw new Error(`Schema ${name} not found in registry`);
    return s.openAiSchema;
  }

  public validateLocally<T>(name: string, data: any): T {
    const s = this.schemas.get(name);
    if (!s) throw new Error(`Schema ${name} not found in registry`);

    // Transparently parse rawPayload and toolArguments back to objects if they were serialized as strings
    const proposal = data?.proposal;
    if (proposal) {
      if (typeof proposal.rawPayload === 'string') {
        try {
          proposal.rawPayload = JSON.parse(proposal.rawPayload);
        } catch {
          proposal.rawPayload = {};
        }
      }
      if (typeof proposal.toolArguments === 'string') {
        try {
          proposal.toolArguments = JSON.parse(proposal.toolArguments);
        } catch {
          proposal.toolArguments = {};
        }
      }
    }

    // Parse the wrapped root schema
    const parsed = s.zodSchema.parse(data) as any;

    // Return the unwrapped proposal object so the rest of the application is unaffected
    return parsed.proposal as T;
  }

  private enforceStrictConstraints(schema: any): void {
    if (!schema || typeof schema !== 'object') return;
    
    // OpenAI structured outputs do not support oneOf, but support anyOf nested
    if (schema.oneOf) {
      schema.anyOf = schema.oneOf;
      delete schema.oneOf;
    }

    if (schema.type === 'object') {
      schema.additionalProperties = false;
      
      // OpenAI requires all properties to be required in strict mode
      if (schema.properties) {
        schema.required = Object.keys(schema.properties);
        for (const key of Object.keys(schema.properties)) {
          if (key === 'rawPayload' || key === 'toolArguments') {
            // Overwrite record schemas with strict string schema to support dynamic payloads in strict mode
            schema.properties[key] = {
              type: 'string',
              description: 'Serialized JSON string containing key-value pairs'
            };
          } else {
            this.enforceStrictConstraints(schema.properties[key]);
          }
        }
      }
    } else if (schema.type === 'array') {
      this.enforceStrictConstraints(schema.items);
    } else if (schema.anyOf || schema.oneOf) {
      const arr = schema.anyOf || schema.oneOf;
      for (const item of arr) {
        this.enforceStrictConstraints(item);
      }
    }
  }
}
