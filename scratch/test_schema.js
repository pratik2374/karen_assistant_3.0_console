import { z } from 'zod';

const ProposalType = {
  COMMAND_PROPOSAL: 'COMMAND_PROPOSAL',
  CLARIFICATION_REQUEST: 'CLARIFICATION_REQUEST',
  TOOL_REQUEST: 'TOOL_REQUEST',
  INFORMATION_RESPONSE: 'INFORMATION_RESPONSE'
};

const BaseProposalSchema = z.object({
  proposalId: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const CommandProposalSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.COMMAND_PROPOSAL),
  actionIntent: z.string(),
  rawPayload: z.record(z.string(), z.any())
});

const ClarificationRequestSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.CLARIFICATION_REQUEST),
  missingInformation: z.array(z.string()),
  clarificationPrompt: z.string()
});

const ToolRequestSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.TOOL_REQUEST),
  toolName: z.string(),
  toolArguments: z.record(z.string(), z.any())
});

const InformationResponseSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.INFORMATION_RESPONSE),
  responseText: z.string()
});

const AIProposalSchema = z.discriminatedUnion('proposalType', [
  CommandProposalSchema,
  ClarificationRequestSchema,
  ToolRequestSchema,
  InformationResponseSchema
]);

const AIProposalRootSchema = z.object({
  proposal: AIProposalSchema
});

function enforceStrictConstraints(schema) {
  if (!schema || typeof schema !== 'object') return;
  
  if (schema.oneOf) {
    schema.anyOf = schema.oneOf;
    delete schema.oneOf;
  }

  if (schema.type === 'object') {
    schema.additionalProperties = false;
    
    if (schema.properties) {
      schema.required = Object.keys(schema.properties);
      for (const key of Object.keys(schema.properties)) {
        if (key === 'rawPayload' || key === 'toolArguments') {
          schema.properties[key] = {
            type: 'string',
            description: 'Serialized JSON string containing key-value pairs'
          };
        } else {
          enforceStrictConstraints(schema.properties[key]);
        }
      }
    }
  } else if (schema.type === 'array') {
    enforceStrictConstraints(schema.items);
  } else if (schema.anyOf || schema.oneOf) {
    const arr = schema.anyOf || schema.oneOf;
    for (const item of arr) {
      enforceStrictConstraints(item);
    }
  }
}

console.log("PROCESSED ROOT SCHEMA:");
try {
  const schema = (AIProposalRootSchema).toJSONSchema();
  enforceStrictConstraints(schema);
  console.log(JSON.stringify(schema, null, 2));
} catch (e) {
  console.log("Failed:", e.message);
}
