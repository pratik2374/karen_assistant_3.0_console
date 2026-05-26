// @ts-nocheck
import { IAgent, AgentContext, AgentExecutionResult } from '../base/IAgent.js';
import { randomUUID } from 'crypto';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { OpenAI as LlamaOpenAI, OpenAIAgent } from '@llamaindex/openai';
import OpenAI from 'openai';
import { FunctionTool } from 'llamaindex';
import * as dotenv from 'dotenv';
dotenv.config();

export interface UserListEntry {
  entryId: string;
  userId: string;
  listType: 'grocery' | 'coding_bucket' | 'movie_bucket';
  title: string;
  status: 'active' | 'completed';
  tags: string[];
  metadata?: {
    rawUrl?: string;
    originalTitle?: string;
    description?: string;
    summary?: string;
    notes?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export class ListAgent implements IAgent {
  readonly name = 'ListAgent';
  readonly domain = 'System/Lists';
  readonly capabilities = ['grocery_list', 'coding_bucket', 'movie_bucket'];

  constructor(private db: any) {}

  public async execute(context: AgentContext): Promise<AgentExecutionResult> {
    const start = Date.now();
    const activeDb = this.db;

    RuntimeEventBus.log('AGENT_STARTED', 'AI', `ListAgent executing intent: ${context.intent}`, context.traceId);

    if (!activeDb) {
      return {
        status: 'FAILED',
        data: {},
        summaryReport: 'Database connection is unavailable for list operations.',
        mutationsCount: 0,
        latencyMs: Date.now() - start,
        errorCode: 'DATABASE_UNAVAILABLE'
      };
    }

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is missing from environment variables');
      }

      // Helper function to scrape metadata from public HTML and keyless oEmbed APIs
      const scrapeMetadata = async (url: string): Promise<{ title: string; description: string }> => {
        const decodeHtmlEntities = (str: string): string => {
          if (!str) return '';
          return str
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
              try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return match; }
            })
            .replace(/&#([0-9]+);/g, (match, dec) => {
              try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return match; }
            });
        };

        try {
          // 1. YouTube oEmbed Integration
          let cleanedUrl = url;
          if (cleanedUrl.includes('/shorts/')) {
            cleanedUrl = cleanedUrl.replace('/shorts/', '/watch?v=');
          }
          if (cleanedUrl.includes('youtube.com') && !cleanedUrl.includes('www.youtube.com')) {
            cleanedUrl = cleanedUrl.replace('youtube.com', 'www.youtube.com');
          }
          
          const lowercaseUrl = cleanedUrl.toLowerCase();
          if (lowercaseUrl.includes('youtube.com') || lowercaseUrl.includes('youtu.be')) {
            try {
              const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(cleanedUrl)}&format=json`;
              const oembedRes = await fetch(oembedUrl);
              if (oembedRes.ok) {
                const data = await oembedRes.json() as any;
                if (data && data.title) {
                  return {
                    title: decodeHtmlEntities(data.title).trim(),
                    description: data.author_name ? `By ${data.author_name}` : ''
                  };
                }
              }
            } catch (oembedErr) {
              console.error('[ListAgent Scraper] YouTube oEmbed failed, falling back to static scrape:', oembedErr);
            }
          }

          // 2. Static HTML Scraper Fallback (for Instagram and other links)
          // Utilizing facebookexternalhit User-Agent allows us to get fully server-side rendered HTML metadata (OpenGraph tags)
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_voiced.html)'
            }
          });
          if (!response.ok) return { title: '', description: '' };
          const html = await response.text();
          
          let title = '';
          let description = '';
          
          // Match og:title
          const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                               html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
          if (ogTitleMatch) title = ogTitleMatch[1];
          
          // Fallback to html title tag
          if (!title) {
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleMatch) title = titleMatch[1];
          }
          
          // Match og:description
          const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                              html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
          if (ogDescMatch) description = ogDescMatch[1];
          
          // Fallback to standard description
          if (!description) {
            const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                              html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
            if (descMatch) description = descMatch[1];
          }
          
          return {
            title: decodeHtmlEntities(title).trim(),
            description: decodeHtmlEntities(description).trim()
          };
        } catch (err) {
          console.error('[ListAgent Scraper] Error scraping URL metadata:', err);
          return { title: '', description: '' };
        }
      };

      const unmaskString = (str: string): string => {
        if (!str) return str;
        const masks = (context as any).urlMasks || {};
        let result = str;
        for (const [key, value] of Object.entries(masks)) {
          result = result.replace(new RegExp(key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), value as string);
        }
        return result;
      };

      // ───────────────────────────────────────────────────────────────────────
      // TOOLS
      // ───────────────────────────────────────────────────────────────────────

      const addTool = FunctionTool.from(
        async (args: { listType: 'grocery' | 'coding_bucket' | 'movie_bucket'; title: string; notes?: string }) => {
          const listType = args.listType;
          const originalInput = unmaskString(args.title.trim());
          
          RuntimeEventBus.log('LIST_AGENT_TOOL', 'SYSTEM', `Adding item to ${listType}: "${originalInput}"`, context.traceId);

          // 1. Grocery Duplicate Check
          if (listType === 'grocery') {
            const activeGrocery = await activeDb.collection('user_lists').findOne({
              userId: context.userId,
              listType: 'grocery',
              status: 'active',
              title: { $regex: new RegExp(`^${originalInput}$`, 'i') }
            });
            if (activeGrocery) {
              return `DUPLICATE: Sir! ${originalInput} is already on list.`;
            }

            // Store grocery item
            const newEntry: UserListEntry = {
              entryId: randomUUID(),
              userId: context.userId,
              listType: 'grocery',
              title: originalInput,
              status: 'active',
              tags: ['grocery'],
              createdAt: new Date(),
              updatedAt: new Date()
            };
            await activeDb.collection('user_lists').insertOne(newEntry);
            return `Successfully added "${originalInput}" to your grocery list.`;
          }

          // 2. Link Parsing & Dynamic Tagging (Coding Bucket & Movie Link Buckets)
          const urlRegex = /(https?:\/\/[^\s]+)/;
          const urlMatch = originalInput.match(urlRegex);

          if (urlMatch) {
            const url = urlMatch[1];
            RuntimeEventBus.log('LIST_AGENT_TOOL', 'SYSTEM', `Detected link in entry: ${url}. Scraping metadata...`, context.traceId);
            
            const scraped = await scrapeMetadata(url);
            
            // Call gpt-4o-mini to dynamically generate a clean title, tags, and summary
            const openaiClient = new OpenAI({ apiKey });
            const prompt = `
You are the Metadata Tagging Engine for Karen's Coding & Movie Buckets.
Your task is to take a raw URL, the scraped public HTML title, the scraped description, and optional user notes, and generate:
1. A clean, concise title for the bucket item (e.g. strip out trailing "YouTube", channel names, or random tracking details).
2. A 1-sentence summary of what the link is about.
3. An array of 3-5 relevant lowercase search tags (e.g. ['frontend', 'react', 'css', 'inspiration'] for coding links, or ['reels', 'movie-clip', 'sci-fi'] for movie trailers).

Raw URL: ${url}
Scraped Title: ${scraped.title || "Unknown Title"}
Scraped Description: ${scraped.description || "No description available."}
User Notes: ${args.notes || "None"}
Bucket Type: ${listType}

Respond STRICTLY in JSON format with exactly three keys: "title", "summary", "tags".
`;
            let llmResult: any = { title: scraped.title || url, summary: '', tags: [] };
            try {
              const chatCompletion = await openaiClient.chat.completions.create({
                model: 'gpt-4o-mini',
                temperature: 0.1,
                response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: prompt }]
              });
              const rawJson = chatCompletion.choices[0]?.message?.content;
              if (rawJson) {
                llmResult = JSON.parse(rawJson);
              }
            } catch (err) {
              console.error('[ListAgent LLM Tagging] OpenAI metadata parsing failed:', err);
            }

            const cleanTitle = llmResult.title || scraped.title || url;
            const finalTags = llmResult.tags || [listType];
            if (!finalTags.includes(listType)) finalTags.push(listType);

            const newEntry: UserListEntry = {
              entryId: randomUUID(),
              userId: context.userId,
              listType,
              title: cleanTitle,
              status: 'active',
              tags: finalTags,
              metadata: {
                rawUrl: url,
                originalTitle: scraped.title,
                description: scraped.description,
                summary: llmResult.summary,
                notes: args.notes
              },
              createdAt: new Date(),
              updatedAt: new Date()
            };
            await activeDb.collection('user_lists').insertOne(newEntry);
            
            return `Successfully tagged and cataloged link: "${cleanTitle}" with tags: ${finalTags.join(', ')}.`;
          } else {
            // General text addition for movies or other list items
            const newEntry: UserListEntry = {
              entryId: randomUUID(),
              userId: context.userId,
              listType,
              title: originalInput,
              status: 'active',
              tags: [listType],
              metadata: {
                notes: args.notes
              },
              createdAt: new Date(),
              updatedAt: new Date()
            };
            await activeDb.collection('user_lists').insertOne(newEntry);
            return `Successfully added "${originalInput}" to your ${listType.replace('_', ' ')}.`;
          }
        },
        {
          name: 'add_to_list',
          description: 'Add a new item to the grocery list, coding link bucket, or movie bucket. Handles grocery duplicate checks and auto-scraping/tagging YouTube and Instagram links.',
          parameters: {
            type: 'object',
            properties: {
              listType: { type: 'string', enum: ['grocery', 'coding_bucket', 'movie_bucket'] },
              title: { type: 'string', description: 'The item name, movie name, or URL link to save.' },
              notes: { type: 'string', description: 'Optional user comments or notes.' }
            },
            required: ['listType', 'title']
          }
        }
      );

      const queryTool = FunctionTool.from(
        async (args: { listType: 'grocery' | 'coding_bucket' | 'movie_bucket'; tag?: string }) => {
          RuntimeEventBus.log('LIST_AGENT_TOOL', 'SYSTEM', `Querying lists for type=${args.listType} | tag=${args.tag || 'none'}`, context.traceId);

          const filter: any = {
            userId: context.userId,
            listType: args.listType,
            status: 'active'
          };

          if (args.tag) {
            filter.tags = args.tag.toLowerCase();
          }

          const items = await activeDb.collection('user_lists')
            .find(filter)
            .sort({ createdAt: -1 })
            .toArray();

          return items.map(d => ({
            title: d.title,
            tags: d.tags,
            link: d.metadata?.rawUrl || '',
            summary: d.metadata?.summary || '',
            notes: d.metadata?.notes || ''
          }));
        },
        {
          name: 'query_list',
          description: 'Fetch and view active items from the grocery list, movie list, or coding link bucket. Optionally filter the coding/movie bucket by tag.',
          parameters: {
            type: 'object',
            properties: {
              listType: { type: 'string', enum: ['grocery', 'coding_bucket', 'movie_bucket'] },
              tag: { type: 'string', description: 'Optional. Tag filter (e.g. "frontend", "tutorials", "inspiration").' }
            },
            required: ['listType']
          }
        }
      );

      const completeTool = FunctionTool.from(
        async (args: {
          listType: 'grocery' | 'coding_bucket' | 'movie_bucket';
          itemsToKeepActive?: string[];
          itemsToComplete?: string[];
        }) => {
          RuntimeEventBus.log('LIST_AGENT_TOOL', 'SYSTEM', `Completing/deleting items on list ${args.listType}`, context.traceId);

          if (args.listType === 'grocery') {
            // GROCERY RULE: Clean check-off. Physically delete items from database.
            if (args.itemsToKeepActive && args.itemsToKeepActive.length > 0) {
              // Get all currently active grocery items
              const activeGroceryItems = await activeDb.collection('user_lists')
                .find({ userId: context.userId, listType: 'grocery', status: 'active' })
                .toArray();

              const keepLower = args.itemsToKeepActive.map(name => name.trim().toLowerCase());
              
              // Filter out the ones to delete (everything NOT in the keep array)
              const itemsToDelete = activeGroceryItems.filter(item => 
                !keepLower.some(k => item.title.toLowerCase().includes(k) || k.includes(item.title.toLowerCase()))
              );

              if (itemsToDelete.length > 0) {
                const idsToDelete = itemsToDelete.map(x => x.entryId);
                await activeDb.collection('user_lists').deleteMany({ entryId: { $in: idsToDelete } });
                
                return `Grocery completed! Deleted the items you bought: ${itemsToDelete.map(x => x.title).join(', ')}. Keeping active: ${args.itemsToKeepActive.join(', ')}.`;
              }

              return `Grocery list updated. Kept active: ${args.itemsToKeepActive.join(', ')}.`;
            } else if (args.itemsToComplete && args.itemsToComplete.length > 0) {
              // Delete specific grocery items
              const deleteTargets = args.itemsToComplete.map(name => new RegExp(`^${name.trim()}$`, 'i'));
              const res = await activeDb.collection('user_lists').deleteMany({
                userId: context.userId,
                listType: 'grocery',
                title: { $in: deleteTargets }
              });

              return `Grocery completed! Deleted items: ${args.itemsToComplete.join(', ')}.`;
            } else {
              // Complete all grocery items
              const res = await activeDb.collection('user_lists').deleteMany({
                userId: context.userId,
                listType: 'grocery',
                status: 'active'
              });
              return `Cleared all active grocery items! Deleted ${res.deletedCount} items.`;
            }
          } else {
            // CODING / MOVIE BUCKET RULE: Mark completed
            if (args.itemsToComplete && args.itemsToComplete.length > 0) {
              const completeTargets = args.itemsToComplete.map(name => new RegExp(`^${name.trim()}$`, 'i'));
              await activeDb.collection('user_lists').updateMany(
                {
                  userId: context.userId,
                  listType: args.listType,
                  title: { $in: completeTargets }
                },
                { $set: { status: 'completed', updatedAt: new Date() } }
              );
              return `Marked items as completed: ${args.itemsToComplete.join(', ')}.`;
            } else {
              // Mark all completed
              await activeDb.collection('user_lists').updateMany(
                { userId: context.userId, listType: args.listType, status: 'active' },
                { $set: { status: 'completed', updatedAt: new Date() } }
              );
              return `Marked all active items in ${args.listType.replace('_', ' ')} as completed.`;
            }
          }
        },
        {
          name: 'complete_list_items',
          description: 'Mark items as completed (or physically delete groceries). Supports smart-checkout by checking off all items except the ones specified to keep active.',
          parameters: {
            type: 'object',
            properties: {
              listType: { type: 'string', enum: ['grocery', 'coding_bucket', 'movie_bucket'] },
              itemsToKeepActive: { type: 'array', items: { type: 'string' }, description: 'Optional. Grocery items to KEEP active (all other active items will be checked off/deleted).' },
              itemsToComplete: { type: 'array', items: { type: 'string' }, description: 'Optional. Specific item names to check off/delete.' }
            },
            required: ['listType']
          }
        }
      );

      // Initialize OpenAI & Agent
      const llm = new LlamaOpenAI({
        apiKey,
        model: 'gpt-4o-mini',
        temperature: 0,
      });

      const agent = new OpenAIAgent({
        tools: [addTool, queryTool, completeTool],
        llm,
        verbose: true,
      });

      const userQuery = context.payload?.userQuery || context.payload?.query || context.intent || '';
      const conversationContext = context.payload?.conversationContext || '';

      const query = `
You are the Karen List and Bucket Agent.
Your job is to manage the user's grocery lists, coding buckets (links), and movie bucket lists.
You have access to tools to add items/links, query lists, and complete/delete items.

Memory Context:
${conversationContext || "_No previous context._"}

URL MASKING & PRIVACY RULES:
- YouTube and Instagram links are passed completely unmasked in plain text. You will see raw URLs (e.g., https://youtube.com/... or https://instagram.com/...) in the query. Pass these raw URLs directly to the add_to_list tool as the "title" parameter!
- Other sensitive document URLs in the user's query may be masked as placeholders like {{MASKED_URL_1}}, {{MASKED_URL_2}}, etc. to protect privacy. If the user refers to a placeholder, pass that exact placeholder to the tool as the "title" parameter. The tool will automatically resolve/unmask it programmatically.

LIST & DUPLICATE RULES:
1. Groceries: 
   - Groceries support case-insensitive duplicate checking. If you call add_to_list and it returns status "DUPLICATE", report that immediately! E.g. "Sir! eggs is already on list."
   - Checking off groceries must delete the purchased items. If the user says they completed grocery shopping but specify some items are still left (e.g., "done grocery only milk left"), call complete_list_items and pass the remaining items as "itemsToKeepActive".
2. Coding Link Bucket:
   - Shared YouTube or Instagram links must be stored under "coding_bucket".
   - Links are automatically parsed, summarized, and tagged with appropriate categories (e.g. "frontend", "react", "tutorials") for easy retrieval.
3. Movie Bucket List:
   - Stores movie names and clip links (usually sent by YouTube/Instagram reel links).
   
Execute the appropriate tool or answer based on the user's request.

Original User Query: "${userQuery}"
`;

      const response = await agent.chat({ message: query });
      const summaryReport = response.toString();

      RuntimeEventBus.log('AGENT_COMPLETED', 'AI', `ListAgent SUCCESS | ${Date.now() - start}ms`, context.traceId);

      return {
        status: 'SUCCESS',
        data: {},
        summaryReport,
        mutationsCount: 1,
        latencyMs: Date.now() - start
      };
    } catch (err: any) {
      RuntimeEventBus.log('AGENT_FAILED', 'ERROR', `ListAgent failed: ${err.message}`, context.traceId);
      return {
        status: 'FAILED',
        data: {},
        summaryReport: `List operation failed: ${err.message}`,
        mutationsCount: 0,
        latencyMs: Date.now() - start,
        errorCode: 'AGENT_EXECUTION_ERROR'
      };
    }
  }
}
