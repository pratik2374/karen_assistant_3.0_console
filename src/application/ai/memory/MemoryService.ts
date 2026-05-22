// @ts-nocheck
import { Db } from 'mongodb';
import { IOpenAIAdapter } from '../../ports/IOpenAIAdapter.js';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';
import { randomUUID } from 'crypto';

export class MemoryService {
  constructor(
    private db: Db,
    private openai: IOpenAIAdapter
  ) {}

  /**
   * Helper to get local date boundaries for Asia/Kolkata
   */
  public getLocalDayBoundaries(): { start: Date; end: Date; dateStr: string } {
    const tzOffset = 5.5 * 60 * 60 * 1000; // +5:30 in ms
    const localNow = new Date(Date.now() + tzOffset);
    const start = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 0, 0, 0, 0) - tzOffset);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    const dateStr = `${localNow.getUTCFullYear()}-${String(localNow.getUTCMonth() + 1).padStart(2, '0')}-${String(localNow.getUTCDate()).padStart(2, '0')}`;
    return { start, end, dateStr };
  }

  /**
   * Logs a message, vectorizes it, queries previous chats for top 2 similar exchanges,
   * and appends them to today's memory cache.
   */
  public async saveMessageAndRetrievedPastContext(
    userId: string,
    role: 'user' | 'assistant',
    messageText: string,
    messageId: string,
    traceId: string
  ): Promise<void> {
    try {
      const { start, dateStr } = this.getLocalDayBoundaries();

      // 1. Save plain message log
      await this.db.collection('chat_messages').insertOne({
        messageId,
        userId,
        role,
        messageText,
        timestamp: new Date(),
        traceId
      });

      // 2. Generate vector embedding
      const embedding = await this.openai.generateEmbedding(messageText);

      // 3. Save message vector embedding
      await this.db.collection('chat_message_embeddings').insertOne({
        messageId,
        userId,
        role,
        messageText,
        timestamp: new Date(),
        embedding,
        traceId
      });

      // 4. Perform local vector cosine similarity search against PAST days' messages (strictly before start of today)
      const pastEmbeddings = await this.db.collection('chat_message_embeddings')
        .find({ userId, timestamp: { $lt: start } })
        .toArray();

      if (pastEmbeddings.length > 0) {
        // Calculate similarity for all past messages
        const matches = pastEmbeddings.map(doc => {
          const sim = this.cosineSimilarity(embedding, doc.embedding);
          return { doc, similarity: sim };
        });

        // Sort descending by similarity
        matches.sort((a, b) => b.similarity - a.similarity);

        // Take top 2 matches
        const topMatches = matches.slice(0, 2);

        // Reconstruct conversation exchanges using traceId for coherent user-assistant contexts
        const contextExchanges: string[] = [];
        for (const match of topMatches) {
          if (!match.doc.traceId) continue;
          
          // Reconstruct the dialog exchange for this traceId
          const exchange = await this.db.collection('chat_messages')
            .find({ traceId: match.doc.traceId })
            .sort({ timestamp: 1 })
            .toArray();

          if (exchange.length > 0) {
            const exchangeText = exchange.map(m => 
              `${m.role === 'user' ? 'User' : 'Karen'}: "${m.messageText}"`
            ).join('\n');

            const exchangeDate = new Date(exchange[0].timestamp).toLocaleDateString('en-IN', {
              timeZone: 'Asia/Kolkata',
              day: 'numeric',
              month: 'short',
              year: 'numeric'
            });

            contextExchanges.push(`[Conversation Date: ${exchangeDate}]\n${exchangeText}`);
          }
        }

        // 5. Cache retrieved memory exchange strings for today
        if (contextExchanges.length > 0) {
          await this.db.collection('chat_today_cache').updateOne(
            { userId, dateStr },
            { $addToSet: { retrievedPastContext: { $each: contextExchanges } } },
            { upsert: true }
          );

          RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
            `Vector search complete. Retained ${contextExchanges.length} past dialogue contexts for today's active cache.`,
            traceId
          );
        }
      }
    } catch (err: any) {
      console.error('[MemoryService] Error saving message or performing vector search:', err);
    }
  }

  /**
   * Fetches today's chat history, retrieved past contexts, and ciphered memory insights.
   */
  public async getCompleteContextString(userId: string): Promise<string> {
    try {
      const { start, end, dateStr } = this.getLocalDayBoundaries();

      // 1. Get today's complete chat history (midnight to 11:59 PM same day)
      const todayMessages = await this.db.collection('chat_messages')
        .find({ userId, timestamp: { $gte: start, $lte: end } })
        .sort({ timestamp: 1 })
        .toArray();

      const historyString = todayMessages.map(m => 
        `${m.role === 'user' ? 'User' : 'Karen'}: "${m.messageText}"`
      ).join('\n');

      // 2. Get today's cached retrieved past memories
      const todayCache = await this.db.collection('chat_today_cache').findOne({ userId, dateStr });
      const pastContextArray = todayCache?.retrievedPastContext || [];
      const pastMemoriesString = pastContextArray.map((ctx: string) => `• ${ctx.replace(/\n/g, '\n  ')}`).join('\n\n');

      // 3. Get cipherized insights
      const cipheredRecord = await this.db.collection('cipherized_memories').findOne({ userId });
      const cipheredFactsArray = cipheredRecord?.facts || [];
      const cipheredString = cipheredFactsArray.map((fact: string) => `💡 ${fact}`).join('\n');

      // Construct a glorious, clean context block
      return [
        `### Current Local Date: ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        `### Today's Chat History (12:00 AM Midnight to 11:59 PM Local Time)\n${historyString || "_No conversations yet today._"}`,
        `### Retrieved Relevant Past Conversations\n${pastMemoriesString || "_No relevant past dialogues retrieved yet._"}`,
        `### Karen's Memory Bank (Ciphered Insights)\n${cipheredString || "_No ciphered facts recorded yet._"}`
      ].join('\n\n');
    } catch (err) {
      console.error('[MemoryService] Failed to compile complete context string:', err);
      return '';
    }
  }

  /**
   * Background LLM task: Summarizes and cipherizes today's chats alongside past facts.
   */
  public async cipherizeConversation(userId: string, traceId: string): Promise<void> {
    try {
      const { start, end } = this.getLocalDayBoundaries();

      // 1. Fetch today's chats
      const todayMessages = await this.db.collection('chat_messages')
        .find({ userId, timestamp: { $gte: start, $lte: end } })
        .sort({ timestamp: 1 })
        .toArray();

      if (todayMessages.length === 0) return;

      const historyString = todayMessages.map(m => 
        `${m.role === 'user' ? 'User' : 'Karen'}: "${m.messageText}"`
      ).join('\n');

      // 2. Fetch existing facts
      const existingRecord = await this.db.collection('cipherized_memories').findOne({ userId });
      const existingFacts = existingRecord?.facts || [];

      // 3. Trigger OpenAI completion using gpt-5.4-mini to cipherize facts
      const response = await this.openai.generateStructuredOutput({
        systemPrompt: {
          versionId: '1.0.0',
          executionMode: 'PLANNING',
          createdAt: new Date(),
          systemPrompt: `
You are Karen's memory cipherizer sub-agent.
Your goal is to maintain a highly synthesized, up-to-date list of key personal facts, preferences, habits, relationship details, and insights about the user.
You will receive:
1. The user's existing memory bank (current facts).
2. Today's complete chat history between the user and Karen.

Your job:
- Analyze today's chat and consolidate/merge it into the existing memory bank.
- Add new relevant facts (e.g. personal preferences, significant life statements, emotional states, patterns).
- Update or retire any facts that are outdated or conflict with new messages.
- Keep each fact short, clear, precise, and highly meaningful (e.g., "User's dad passed away / user feels close connection with father figures", "User prefers tea over water").
- Keep the list highly condensed. Under no circumstances exceed 15 facts in total.
`.trim()
        },
        contextString: `EXISTING MEMORIES:\n${existingFacts.map((f: string) => `- ${f}`).join('\n') || "No memories yet."}`,
        userQuery: `TODAY'S CONVERSATION HISTORY:\n${historyString}`,
        schemaConfig: {
          name: "ciphered_memories_schema",
          schema: {
            type: "object",
            properties: {
              facts: {
                type: "array",
                items: {
                  type: "string"
                },
                description: "The consolidated up-to-date list of key personal insights/facts about the user."
              }
            },
            required: ["facts"],
            additionalProperties: false
          },
          strict: true
        },
        model: 'gpt-5.4-mini',
        temperature: 0.1
      });

      if (response && Array.isArray(response.facts)) {
        await this.db.collection('cipherized_memories').updateOne(
          { userId },
          { $set: { facts: response.facts, updatedAt: new Date() } },
          { upsert: true }
        );

        RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
          `Memory Cipherizer successfully integrated. Consolidated ${response.facts.length} core user facts in long-term memory.`,
          traceId
        );
      }
    } catch (err: any) {
      console.error('[MemoryService] Error running background memory cipherizer:', err);
    }
  }

  /**
   * Helper to calculate vector cosine similarity
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
