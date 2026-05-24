import { Db } from 'mongodb';
import { OpenAI } from '@llamaindex/openai';
import { TwilioWhatsAppAdapter } from '../infrastructure/whatsapp/TwilioAdapter.js';
import { RuntimeEventBus } from './RuntimeEventBus.js';
import * as cron from 'node-cron';
import { Queue } from 'bullmq';

export class DailyReportService {
  constructor(
    private db: Db,
    private whatsappAdapter: TwilioWhatsAppAdapter,
    private reportQueue: Queue
  ) {}

  public start(userId: string): void {
    // 1. Cron job at 11:30 PM (23:30) IST every day to generate the report
    // The server is currently configured in UTC by Heroku, but we want 23:30 IST.
    // 23:30 IST is 18:00 UTC.
    cron.schedule('0 18 * * *', async () => {
      console.log(`[DailyReportService] Triggered generation for ${userId}`);
      await this.generateAndScheduleReport(userId);
    });

    console.log('[DailyReportService] Scheduled daily report generation cron at 23:30 IST (18:00 UTC).');
  }

  private async generateAndScheduleReport(userId: string): Promise<void> {
    try {
      // 1. Gather data for the current day
      const now = new Date();
      // Since it's 11:30 PM IST, the local date is correct.
      // Get the start and end of the day in UTC that corresponds to the IST day.
      // Easiest way: fetch tasks created in the last 24 hours
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const tasks = await this.db.collection('aggregates_tasks').find({
        lastUpdatedAt: { $gte: yesterday }
      }).toArray();

      const events = await this.db.collection('calendar_projections').find({
        startTime: { $gte: yesterday }
      }).toArray();

      let completedTasks = 0;
      let missedTasks = 0;
      let pendingTasks = 0;

      tasks.forEach((t: any) => {
        if (t.state === 'STOPPED') completedTasks++;
        else if (t.state === 'ESCALATED') missedTasks++;
        else pendingTasks++;
      });

      const totalEvents = events.length;

      // 2. Generate report using LLM
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return;

      const llm = new OpenAI({ apiKey, model: 'gpt-5.4-mini', temperature: 0.7 });

      const prompt = `
You are Karen, an aggressively helpful, slightly snarky, and highly opinionated AI assistant.
Your job is to write a Daily Report for the user summarizing their day.

Here are their stats for today:
- Completed Tasks: ${completedTasks}
- Missed/Ignored Tasks: ${missedTasks}
- Pending/Unfinished Tasks: ${pendingTasks}
- Calendar Events Attended: ${totalEvents}

Instructions:
1. Write a short, punchy report for the user (about 3-4 sentences).
2. If they completed a lot, give them a backhanded compliment.
3. If they missed a lot, roast them playfully.
4. Call it the "Karen Daily Report" at the top.
5. Keep it conversational for WhatsApp. Do NOT use emojis excessively.
`;

      const response = await llm.chat({ messages: [{ role: 'user', content: prompt }] });
      const reportText = response.message.content;

      // 3. Schedule delivery for 7:00 AM IST next morning.
      // 7:00 AM IST is 01:30 UTC next day.
      // Since it's currently 18:00 UTC, 01:30 UTC is exactly 7.5 hours (450 minutes) from now.
      const delayMs = 7.5 * 60 * 60 * 1000;
      
      console.log(`[DailyReportService] Generated report. Scheduling delivery in 7.5 hours for 7:00 AM IST.`);

      await this.reportQueue.add('deliver_daily_report', {
        userId,
        reportText
      }, {
        delay: delayMs,
        jobId: `daily-report-${Date.now()}`
      });

    } catch (err: any) {
      console.error(`[DailyReportService] Generation failed: ${err.message}`);
    }
  }
}
