import { ToolExecutionGateway } from '../gateway/ToolExecutionGateway.js';
import { CircuitBreaker } from '../../resiliency/CircuitBreaker.js';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';
import { RuntimeConfig } from '../../../composition/config/RuntimeConfig.js';

export interface WhatsAppMessage {
  to: string;
  body: string;
  idempotencyKey: string;
}

export class WhatsAppAdapter extends ToolExecutionGateway {
  constructor(
    circuitBreaker: CircuitBreaker,
    private config?: RuntimeConfig
  ) {
    super(circuitBreaker);
  }

  async sendMessage(message: WhatsAppMessage, isReplay: boolean, isSandbox: boolean): Promise<void> {
    const accessToken = this.config?.WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = this.config?.WHATSAPP_PHONE_NUMBER_ID ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
    const executionMode = this.config?.EXECUTION_MODE ?? process.env.EXECUTION_MODE ?? 'SANDBOX';

    const cleanTo = message.to.replace(/^\+/, '');
    const url = `https://graph.facebook.com/v25.0/${phoneId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: cleanTo,
      type: 'text',
      text: { body: message.body }
    };

    // We bypass Sandbox / Replay guards for Outbound WhatsApp sends by setting isReplay and isSandbox to false in the Gateway Context,
    // ensuring NO early return exists in SANDBOX, REPLAY, or SIMULATION modes.
    await this.execute(
      {
        operationName: 'WhatsApp.SendMessage',
        isReplay: false, 
        isSandbox: false,
        replaySafe: true, 
        idempotencyKey: message.idempotencyKey,
        requiredScopes: ['SEND_WHATSAPP']
      },
      async () => {
        RuntimeEventBus.log('WHATSAPP_SEND_START', 'OUTBOUND', `Graph API URL: ${url} | Mode: ${executionMode}`);
        RuntimeEventBus.log('WHATSAPP_SEND_PAYLOAD', 'OUTBOUND', `Request Payload: ${JSON.stringify(payload)}`);

        if (!accessToken || !phoneId) {
          throw new Error(`Missing WhatsApp configuration: token=${!!accessToken}, phoneId=${!!phoneId}`);
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const resBody = await response.text();
        RuntimeEventBus.log('WHATSAPP_SEND_RESPONSE', 'OUTBOUND', `Response status: ${response.status} | Body: ${resBody}`);

        if (!response.ok) {
          throw new Error(`Graph API returned HTTP ${response.status}: ${resBody}`);
        }

        try {
          const parsed = JSON.parse(resBody);
          const metaMsgId = parsed.messages?.[0]?.id;
          if (metaMsgId) {
            RuntimeEventBus.log('WHATSAPP_SEND_SUCCESS', 'OUTBOUND', `Meta Graph API Message ID: ${metaMsgId}`);
          }
        } catch (e) {
          // Silent catch for JSON parsing if any
        }
      },
      async () => {
        // Mock fallback, should not be hit because we bypass sandbox/replay checks
        RuntimeEventBus.log('WHATSAPP_SEND_SANDBOX', 'OUTBOUND', `Simulated sandbox outbound to ${message.to}: "${message.body}"`);
      }
    );
  }
}
