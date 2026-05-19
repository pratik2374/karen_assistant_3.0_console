import crypto from 'crypto';
import http from 'http';

const WEBHOOK_SECRET = 'karen_webhook_secret';

const payload = JSON.stringify({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: 'wamid.HBgMOTE3OTk5OTk5OTk5FQIAERgSRDMx' + Math.random().toString(36).substring(7),
                from: '917999999999',
                text: {
                  body: 'remind me to call John tomorrow'
                }
              }
            ],
            contacts: [
              {
                wa_id: '917999999999',
                profile: {
                  name: 'Pratik Gond'
                }
              }
            ]
          },
          field: 'messages'
        }
      ]
    }
  ]
});

const signature = 'sha256=' + crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(payload)
  .digest('hex');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/v1/webhooks/whatsapp',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-hub-signature-256': signature,
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    console.log(`Body: ${chunk}`);
  });
});

req.on('error', (e) => {
  console.error(`Problem: ${e.message}`);
});

req.write(payload);
req.end();
