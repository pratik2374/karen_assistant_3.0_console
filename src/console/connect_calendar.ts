import { Composio } from '@composio/core';
import chalk from 'chalk';

async function main() {
  const apiKey = 'ak_wOYh4Hmuxxknt_PSzKDf';
  const userId = 'karen';
  const composio = new Composio({ apiKey });
  
  console.log(chalk.blue(`\nInitiating Google Calendar connection request for user "${userId}"...`));
  
  try {
    const session = await composio.create(userId);
    const connectionRequest = await session.authorize('googlecalendar');
    
    console.log(chalk.yellow(`\n👉 VISIT THIS URL IN YOUR BROWSER TO AUTHENTICATE GOOGLE CALENDAR:\n`));
    console.log(chalk.bold.cyan(connectionRequest.redirectUrl));
    console.log(`\nWaiting for connection to be completed (120s timeout)...`);
    
    const connectedAccount = await connectionRequest.waitForConnection(120000);
    console.log(chalk.green(`\n√ Google Calendar connection established successfully!`));
    console.log(`Connected Account ID: ${connectedAccount.id}`);
  } catch (err: any) {
    console.error(chalk.red(`\nFailed to establish connection: ${err.message}`));
  }
}

main();
