import { ValidatedCommand } from '../commands/CommandStandard.js';

export class MessageRenderer {
  private karenGreetings = [
    "On it!",
    "Locked in.",
    "Consider it done.",
    "Got you covered.",
    "Schedules updated.",
    "Way ahead of you.",
    "Done and dusted."
  ];

  private karenBanter = [
    "Let's hope your memory holds out better than my cache.",
    "I've got an eye on this for you. Try to stay focused, okay?",
    "Excellent choice. I'm sure you'll do great.",
    "Don't worry, I won't let you forget. That's what best friends are for.",
    "Locked, loaded, and stored in my memory banks.",
    "Another task scheduled! Let's see if we actually get to this one today."
  ];

  private getRandom(arr: string[]): string {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  public renderClarification(prompt: string, missing: string[]): string {
    return `🎙️ *Karen* | _Clarification Required_\n\n"Hmm, my mind-reading module must be a bit glitchy today.\n\n${prompt}"\n\n*Required Details:*\n${missing.map(m => `  • *${m}*`).join('\n')}`;
  }

  public renderConfirmation(command: ValidatedCommand): string {
    const greeting = this.getRandom(this.karenGreetings);
    const banter = this.getRandom(this.karenBanter);
    const title = command.payload?.title || command.payload?.action || 'Reminder';
    
    return `🎙️ *Karen* | _Task Scheduled_\n\n"${greeting} I've locked in:\n  👉 *${title}*\n\n${banter}"\n\n_ID: \`${command.commandId.substring(0, 8)}\` | Timezone: Asia/Kolkata_`;
  }

  public renderCancellation(taskId: string): string {
    const lines = [
      `"All done! I've cleared that task from my memory bank. You're officially off the hook."`,
      `"Poof! Vaporized it. Your schedule is looking a bit more breathable now."`,
      `"Task removed. Let's hope you didn't actually need to do that!"`,
      `"Done! I've cleared the task for you. Anything else we should tackle?"`
    ];
    return `🎙️ *Karen* | _Task Cancelled_\n\n${this.getRandom(lines)}\n\n_Task ID: \`${taskId.substring(0, 8)}\`_`;
  }

  public renderInformation(response: string): string {
    // Let the LLM's own rich, customized Karen best-friend persona flow directly through without any robotic wrappers!
    return response;
  }

  public renderError(message: string): string {
    return `🎙️ *Karen* | _Glitch Detected_\n\n"Oops, seems like my systems hit a small snag. ${message}"`;
  }
}
