// Offline replay of real teacher replies through the teacher agent. Sends nothing, writes
// nothing to Instantly, creates no demo links (a fake link stands in). Uses the real Claude API.
//
// Run with: npx ts-node scripts/teacherReplay.ts [count] [seed]
// Writes scripts/teacher-replay-results.md (gitignored: it holds real teachers' emails).
//
// The replies come from our past teacher campaigns (2023-2025), which offered a Zoom call, not a
// demo link. To test the new flow, each reply is placed under the NEW cold email instead of the
// one it actually answered, and dated as if it just arrived (the real dates are 2023-2025, and
// the agent rightly treats a year-old reply as suspicious). Replies that only make sense against the old email ("what time
// works?") are expected to read a little oddly; judge those with that in mind.

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

import axios from 'axios';
import { draftTeacherReply, TeacherResult } from '../src/teacherAgent';
import { ThreadEmail } from '../src/agent';
import { InstantlyWebhookPayload } from '../src/types';

const COUNT = Number(process.argv[2] || 40);
const SEED = Number(process.argv[3] || 1);
const CONCURRENCY = 4;
const FAKE_LINK = 'https://app.peerteach.org/ai-agents/demo?link=REPLAY-TEST-TOKEN';

const api = axios.create({
  baseURL: 'https://api.instantly.ai/api/v2',
  headers: { Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}` },
  timeout: 20000,
});
// This shares the workspace's API key, and so its rate limit (20 requests/minute on some
// endpoints), with the live reply agent. Pace every request to 8/minute so live replies keep
// most of the budget.
const MIN_GAP_MS = 7500;
let nextSlot = 0;
api.interceptors.request.use(async (cfg) => {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return cfg;
});
// Everything this script sends to Instantly is a read (including POST /leads/list), so retrying is safe.
api.interceptors.response.use(undefined, async (err) => {
  const cfg = err.config || {};
  cfg.__tries = (cfg.__tries || 0) + 1;
  if (cfg.__tries > 3) throw err;
  await new Promise((r) => setTimeout(r, err.response?.status === 429 ? 60000 : 2000 * cfg.__tries));
  return api.request(cfg);
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// The reply alone, without the quoted thread under it.
function stripQuoted(text: string): string {
  // Gmail often wraps the quote header over two lines ("On Thu, Dec 11, 2025 ... Katie <" /
  // "katie@...> wrote:"), which the line-by-line checks below miss.
  const t = text.replace(/\r/g, '');
  const wrapped = t.search(/\n\s*On [^\n]{5,200}\n[^\n]{0,200}wrote:/);
  const lines = (wrapped >= 0 ? t.slice(0, wrapped) : t).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .{5,200}wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/.test(line) && out.length > 0) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function coldEmail(first: string, school: string): string {
  return `Hi ${first || 'there'},

I'm part of the team behind PeerTeach, a math peer tutoring platform that grew out of research at Stanford. It trains every student in your class to coach a partner, pairs them up using quick micro-assessments, and guides them through the session, so the whole class gets 1:1 help at once.

We have grant funding for a small number of pilot classrooms this school year, and we're down to the last few spots. Wanted to reach out to ${school || 'your school'} before we close them out.

Want me to send you a demo link? You can click through it on your own in a few minutes, no call needed.

-Katie
Katie Kaplan
Head of School Partnerships, PeerTeach`;
}

interface Case {
  email: any;
  reply: string;
  status: number;
  lead: any;
}

async function collect(): Promise<Case[]> {
  const camps: any[] = [];
  let after: string | undefined;
  do {
    const r = await api.get('/campaigns', { params: { limit: 100, search: 'eacher', starting_after: after } });
    camps.push(...(r.data.items || []));
    after = r.data.next_starting_after;
  } while (after);
  const teacherCamps = camps.filter((c) => /teacher/i.test(c.name));
  console.log(`teacher campaigns: ${teacherCamps.length}`);

  // First reply per lead, across campaigns, up to a pool a few times the sample size.
  const byLead = new Map<string, any>();
  for (const c of teacherCamps) {
    let cursor: string | undefined;
    for (let page = 0; page < 1; page++) {
      const r = await api.get('/emails', { params: { campaign_id: c.id, email_type: 'received', limit: 100, starting_after: cursor } });
      for (const e of r.data.items || []) {
        const prev = byLead.get(e.lead);
        if (!prev || e.timestamp_email < prev.timestamp_email) byLead.set(e.lead, e);
      }
      cursor = r.data.next_starting_after;
      if (!cursor) break;
    }
    if (byLead.size >= COUNT * 3) break;
  }
  console.log(`distinct replying leads in pool: ${byLead.size}`);

  // Sample spread across Instantly's interest labels so it isn't all "not interested".
  const groups = new Map<number, any[]>();
  for (const e of byLead.values()) {
    const reply = stripQuoted(e.body?.text || '');
    if (!reply) continue;
    const k = e.i_status ?? 0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const rand = rng(SEED);
  for (const g of groups.values()) g.sort(() => rand() - 0.5);
  const picked: any[] = [];
  const keys = [...groups.keys()];
  while (picked.length < COUNT && keys.some((k) => groups.get(k)!.length)) {
    for (const k of keys) {
      const g = groups.get(k)!;
      if (g.length && picked.length < COUNT) picked.push(g.shift());
    }
  }

  const cases: Case[] = [];
  for (const e of picked) {
    const r = await api.post('/leads/list', { campaign: e.campaign_id, search: e.lead, limit: 5 });
    const lead = (r.data.items || []).find((i: any) => (i.email || '').toLowerCase() === e.lead.toLowerCase()) || {};
    cases.push({ email: e, reply: stripQuoted(e.body?.text || ''), status: e.i_status ?? 0, lead });
  }
  return cases;
}

async function runCase(c: Case): Promise<{ c: Case; result?: TeacherResult; error?: string; ms: number }> {
  const p = c.lead.payload || {};
  const first = c.lead.first_name || p.firstName || '';
  const school = p['School/District Nickname'] || p.School || c.lead.company_name || '';
  const payload: InstantlyWebhookPayload = {
    timestamp: new Date().toISOString(),
    event_type: 'reply_received',
    workspace: '',
    campaign_id: c.email.campaign_id,
    campaign_name: '(replay)',
    lead_email: c.email.lead,
    email_account: 'katie@gopeerteach.com',
    unibox_url: '',
    email_id: c.email.id,
    email_subject: `${first || 'Hi'}, quick question`,
    email_text: '',
    reply_text: c.reply,
    reply_html: '',
    reply_subject: `Re: ${first || 'Hi'}, quick question`,
    reply_text_snippet: c.reply.slice(0, 200),
    firstName: first,
    lastName: c.lead.last_name || p.lastName || '',
    School: school,
    State: p.State || p.state || '',
    Persona: 'Teacher',
  };
  const thread: ThreadEmail[] = [
    { body: coldEmail(first, school), timestamp: new Date(Date.now() - 2 * 86400000).toISOString(), isOutbound: true, from: 'katie@gopeerteach.com', to: [c.email.lead] },
    { body: c.reply, timestamp: new Date().toISOString(), isOutbound: false, from: c.email.lead, to: ['katie@gopeerteach.com'] },
  ];
  const t0 = Date.now();
  try {
    const result = await draftTeacherReply(payload, thread, 'Katie', { createDemoLink: async () => FAKE_LINK });
    return { c, result, ms: Date.now() - t0 };
  } catch (err) {
    return { c, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}

const STATUS_LABEL: Record<string, string> = { '1': 'interested', '-1': 'not interested', '0': 'unlabeled', '2': 'meeting booked', '3': 'meeting completed', '-2': 'wrong person', '-3': 'lost' };

(async () => {
  // Collected cases are cached (gitignored) so a rerun after a prompt change compares like with
  // like and doesn't spend the shared Instantly rate limit again. Delete the file to resample.
  const cacheFile = path.join(__dirname, `teacher-replay-cases-${COUNT}-${SEED}.json`);
  const cases: Case[] = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : await collect();
  if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, JSON.stringify(cases));
  for (const c of cases) c.reply = stripQuoted(c.email.body?.text || '');
  console.log(`running ${cases.length} cases...`);
  const out: Awaited<ReturnType<typeof runCase>>[] = [];
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(cases.slice(i, i + CONCURRENCY).map(runCase))));
    console.log(`  ${out.length}/${cases.length}`);
  }

  const tally = (f: (o: (typeof out)[number]) => string) =>
    out.reduce<Record<string, number>>((m, o) => ((m[f(o)] = (m[f(o)] || 0) + 1), m), {});
  const ms = out.map((o) => o.ms).sort((a, b) => a - b);
  let md = `# Teacher replay results\n\n${new Date().toISOString()} · ${out.length} real past teacher replies, placed under the new cold email · seed ${SEED}\n\n`;
  md += `Actions: ${JSON.stringify(tally((o) => o.error ? 'ERROR' : o.result!.action))}\n\n`;
  md += `Escalation categories: ${JSON.stringify(tally((o) => o.result?.action === 'escalate' ? o.result.category || '?' : '-'))}\n\n`;
  md += `Demo link included: ${out.filter((o) => o.result?.demoLink).length}\n\n`;
  md += `Latency: median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)}s, max ${(ms[ms.length - 1] / 1000).toFixed(1)}s (webhook limit 60s)\n\n---\n\n`;
  out.forEach((o, i) => {
    md += `## ${i + 1}. ${o.c.email.lead} (Instantly label: ${STATUS_LABEL[String(o.c.status)] ?? o.c.status}) · ${(o.ms / 1000).toFixed(1)}s\n\n`;
    md += `**Their reply:**\n\n${o.c.reply.slice(0, 1200).split('\n').map((l) => '> ' + l).join('\n')}\n\n`;
    if (o.error) {
      md += `**ERROR:** ${o.error}\n\n`;
    } else {
      const r = o.result!;
      md += `**Decision:** ${r.action}${r.category ? ` [${r.category}]` : ''}${r.reason ? `: ${r.reason}` : ''}\n\n`;
      if (r.draft) md += '**Draft:**\n\n```\n' + r.draft + '\n```\n\n';
    }
  });
  const file = path.join(__dirname, 'teacher-replay-results.md');
  fs.writeFileSync(file, md);
  console.log(md.split('---')[0]);
  console.log(`wrote ${file}`);
})().catch((e) => {
  console.error('replay failed:', e.response?.status, e.response?.data || e.message);
  process.exit(1);
});
