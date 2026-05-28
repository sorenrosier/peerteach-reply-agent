// Smoke test: invoke the routing layer directly with a sample Instantly payload.
// Usage:  npx ts-node scripts/testWebhook.ts [scheduling|soft_yes|referred|soft_no|hard_no|ooo|wrong|escalate]
//
// Requires env vars set (ANTHROPIC_API_KEY, SLACK_*, INSTANTLY_API_KEY).
// Will actually post to Slack and may attempt Instantly API calls. Use a sandbox channel.

import { routeReply } from '../src/router';
import { InstantlyWebhookPayload } from '../src/types';

const SAMPLES: Record<string, Partial<InstantlyWebhookPayload>> = {
  scheduling: {
    reply_text:
      'Sure, happy to chat. What times work for you next week? Tuesday or Wednesday afternoon would be ideal on my end.',
    reply_text_snippet: 'Sure, happy to chat. What times work for you...',
  },
  soft_yes: {
    reply_text: 'Interesting — is this free for our school? And what grade levels?',
    reply_text_snippet: 'Interesting — is this free...',
  },
  referred: {
    reply_text:
      'You should reach out to my AP, Maria Sanchez. She handles math curriculum decisions.',
    reply_text_snippet: 'You should reach out to my AP...',
  },
  soft_no: {
    reply_text: 'Thanks but we are not a fit for this at the moment. Maybe next year.',
    reply_text_snippet: 'Thanks but we are not a fit...',
  },
  hard_no: {
    reply_text: 'Remove me from your list. Stop emailing me.',
    reply_text_snippet: 'Remove me from your list...',
  },
  ooo: {
    reply_text:
      'I am out of the office until Monday, March 10th and will respond when I return.',
    reply_text_snippet: 'I am out of the office until Monday...',
  },
  wrong: {
    reply_text:
      'I am no longer at Lincoln Elementary, I retired last June. You may want to contact the new principal.',
    reply_text_snippet: 'I am no longer at Lincoln Elementary...',
  },
  escalate: {
    reply_text:
      'This is unsolicited communication. Our legal team will be in touch about your CAN-SPAM violations.',
    reply_text_snippet: 'This is unsolicited communication...',
  },
};

function makePayload(overrides: Partial<InstantlyWebhookPayload>): InstantlyWebhookPayload {
  return {
    timestamp: new Date().toISOString(),
    event_type: 'reply_received',
    workspace: 'test-workspace',
    campaign_id: 'test-campaign-id',
    campaign_name: 'Site Admin — Test Campaign',
    lead_email: 'test.principal@example.edu',
    email_account: 'kreg@peerteachly.com',
    unibox_url: 'https://app.instantly.ai/app/unibox',
    email_id: 'test-email-id-' + Date.now(),
    email_subject: 'Quick question about math at your school',
    email_text:
      'Hi {{firstName}}, Kreg here from PeerTeach. We help math teachers run peer tutoring during class time, fully grant-funded for pilot schools. Worth a quick Zoom?',
    reply_text: '',
    reply_html: '',
    reply_subject: 'RE: Quick question about math at your school',
    reply_text_snippet: '',
    firstName: 'Pat',
    lastName: 'Smith',
    School: 'Lincoln Elementary',
    Role: 'Principal',
    Persona: 'Site Admin',
    ...overrides,
  };
}

async function main() {
  const which = (process.argv[2] || 'scheduling').toLowerCase();
  const sample = SAMPLES[which];
  if (!sample) {
    console.error(`Unknown sample: ${which}. Options: ${Object.keys(SAMPLES).join(', ')}`);
    process.exit(1);
  }
  const payload = makePayload(sample);
  console.log(`\n=== Routing sample: ${which} ===\n`);
  await routeReply(payload);
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Test webhook failed:', err);
  process.exit(1);
});
