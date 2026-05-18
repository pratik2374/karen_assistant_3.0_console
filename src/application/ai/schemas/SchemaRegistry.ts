import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AIProposalSchema } from '../../commands/CommandStandard';

export interface RegisteredSchema {
  version: string;
  zodSchema: z.ZodTypeAny;
  openAiSchema: Record<string, any>;
}

export class SchemaRegistry {
  private schemas: Map<string, RegisteredSchema> = new Map();

  constructor() {
    this.register('AIProposal_v1', AIProposalSchema);
  }

  public register(name: string, schema: z.ZodTypeAny): void {
    // Generate strict JSON schema for OpenAI
    const openAiSchema = zodToJsonSchema(schema as any, {
      $refStrategy: 'none',
      target: 'openApi3'
    });

    // OpenAI structured outputs require additional constraints for 'strict: true'
    // such as `additionalProperties: false` on all objects
    this.enforceStrictConstraints(openAiSchema);

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
    return s.zodSchema.parse(data) as T;
  }

  private enforceStrictConstraints(schema: any): void {
    if (!schema || typeof schema !== 'object') return;
    
    if (schema.type === 'object') {
      schema.additionalProperties = false;
      // OpenAI requires all properties to be required in strict mode
      if (schema.properties) {
        schema.required = Object.keys(schema.properties);
        for (const key of Object.keys(schema.properties)) {
          this.enforceStrictConstraints(schema.properties[key]);
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
