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
  booked?: boolean;
  bookingDetails?: {
    startTime: string;
    rescheduleUrl?: string;
    cancelUrl?: string;
  };
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
}
