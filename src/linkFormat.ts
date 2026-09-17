// The model writes links in the draft as plain `[label](url)` markdown — a single,
// destination-agnostic marker. Email and Slack each need a different rendering of that
// same marker (a real <a> tag, a plain-text fallback, Slack's own <url|label> syntax), so
// this is the one place that knows how to produce all three from one source of truth,
// rather than asking the model to already know which destination it's writing for.
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Slack mrkdwn only requires escaping these three — see Slack's own formatting docs.
function escapeSlackMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface RenderedLinks {
  plainText: string;
  html: string;
  slackMrkdwn: string;
}

export function renderLinks(raw: string): RenderedLinks {
  let plainText = '';
  let html = '';
  let slackMrkdwn = '';
  let lastIndex = 0;

  for (const match of raw.matchAll(LINK_PATTERN)) {
    const [full, label, url] = match;
    const start = match.index ?? raw.indexOf(full, lastIndex);
    const before = raw.slice(lastIndex, start);

    plainText += before;
    html += escapeHtml(before).replace(/\n/g, '<br>');
    slackMrkdwn += escapeSlackMrkdwn(before);

    plainText += `${label} (${url})`;
    html += `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    slackMrkdwn += `<${url}|${escapeSlackMrkdwn(label)}>`;

    lastIndex = start + full.length;
  }

  const rest = raw.slice(lastIndex);
  plainText += rest;
  html += escapeHtml(rest).replace(/\n/g, '<br>');
  slackMrkdwn += escapeSlackMrkdwn(rest);

  return { plainText, html: `<div>${html}</div>`, slackMrkdwn };
}
