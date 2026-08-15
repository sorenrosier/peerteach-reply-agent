export type ReplyClassification =
  | 'SCHEDULING'
  | 'SOFT_YES'
  | 'REFERRED'
  | 'SOFT_NO'
  | 'HARD_NO'
  | 'OOO'
  | 'WRONG_PERSON'
  | 'NO_REPLY'
  | 'ESCALATE';

export type AgentAction = 'draft' | 'no_reply' | 'hard_no' | 'ooo' | 'escalate';

export interface AgentResult {
  action: AgentAction;
  draft?: string;
  booked?: boolean; // true when a booking is PREPARED (created only on Send approval)
  pendingBooking?: {
    startTime: string;
    name: string;
    email: string;
    timezone: string;
    guests: string[];
    host: 'katie' | 'soren';
  };
  // Everyone else on the thread (colleagues looped in via to/cc) who should be cc'd if
  // this draft is sent. Computed in code from thread data, not left to the model.
  ccEmails?: string[];
  returnDate?: string;
  reason?: string;
}

export interface InstantlyWebhookPayload {
  timestamp: string;
  event_type: string;
  workspace: string;
  campaign_id: string;
  campaign_name: string;
  lead_email: string;
  email_account: string;
  unibox_url: string;
  email_id: string;
  email_subject: string;
  email_text: string;
  reply_text: string;
  reply_html: string;
  reply_subject: string;
  reply_text_snippet: string;
  firstName?: string;
  lastName?: string;
  School?: string;
  'School/District Nickname'?: string;
  'District Name'?: string;
  Role?: string;
  Persona?: string;
  [key: string]: any;
}

export interface ClassificationResult {
  classification: ReplyClassification;
  confidence: number;
  reasoning: string;
  extractedInfo: {
    proposedTimes?: string[];
    referralContact?: string;
    objection?: string;
    question?: string;
    returnDate?: string;
  };
}

export interface SlackActionPayload {
  type: string;
  actions: Array<{
    action_id: string;
    value: string;
  }>;
  message: {
    ts: string;
    blocks: any[];
  };
  response_url: string;
  channel: { id: string };
  user?: { id: string; name?: string };
}

export interface SendReplyButtonValue {
  email_id: string;
  eaccount: string;
  subject: string;
  body_text: string;
  lead_email: string;
  campaign_id: string;
  // Everyone else who should be cc'd on the reply itself (colleagues looped in on the
  // thread). Distinct from booking.guests, which controls the Calendly invite.
  cc?: string[];
  // When present, the meeting is booked at Send time (before the reply is sent) — onto
  // Katie's Calendly or directly onto Soren's Google Calendar, depending on host.
  booking?: {
    startTime: string;
    name: string;
    email: string;
    timezone: string;
    guests: string[];
    host: 'katie' | 'soren';
  };
}
