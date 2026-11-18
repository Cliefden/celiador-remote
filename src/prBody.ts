/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *  Ported from the celiador-ai extension of the Celiador editor (agents/prBody.ts).
 *--------------------------------------------------------------------------------------------*/

// The pull request body an agent task opens with (stand-out contract §4), built
// from the run's final assistant message. The task prompt asks the agent to end
// with a "## Self-review" section (what changed; what it is unsure about; what
// it did not run or verify) — this parses that section leniently, since the
// agent writes it in prose, and falls back to the message itself. Pure (no
// vscode import) so it unit-tests under plain node; the daemon composes the
// same body server-side and PATCHes in what only it knows (the cost).

/** "$0.38", or "<$0.01" for a run that cost a fraction of a cent. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) {return '<$0.01';}
  return `$${usd.toFixed(2)}`;
}

/** "<1 min", "12 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {return '<1 min';}
  if (minutes < 60) {return `${minutes} min`;}
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A session's usage as the daemon reports it (`Task.usage`, contract §1). */
export interface TaskUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** The parts of the agent's "## Self-review" section. */
export interface SelfReview {
  /** The "what changed" paragraph(s), when labelled or leading the section. */
  whatChanged?: string;
  /** What the agent said it is unsure about, one item per line or bullet. */
  unsure: string[];
  /** What the agent said it did not run or verify (and why). */
  notVerified: string[];
  /** The section's text when none of its lines could be classified. */
  raw?: string;
}

export interface TaskPrBodyArgs {
  issueNumber?: number;
  /** The run's final assistant message (the editor reports the same text as `summary`). */
  finalMessage?: string;
  /** Where the run happened: this computer's name; ignored for a cloud run. */
  machine?: string;
  runner?: 'mac' | 'cloud';
  /** Files the pull request changes, when already known. */
  files?: number;
  elapsedMs?: number;
  /** The run's cost, when known (the daemon knows; the editor leaves it out). */
  usage?: TaskUsage;
  /** The opt-in "made with Celiador" line. */
  attribution?: boolean;
}

/** `## What the agent did` is clipped to this many characters (contract §4). */
export const WHAT_CHANGED_MAX_CHARS = 2000;
const RAW_REVIEW_MAX_CHARS = 1500;

const SELF_REVIEW_HEADING = /^\s{0,3}(?:(?<hashes>#{1,6})\s*|(?:\*\*|__))?self[- ]?review\b[^\n]*$/im;
const ANY_HEADING = /^\s{0,3}(?<hashes>#{1,6})\s+\S/;
const NOTHING = /^(?:none|nothing|n\/a|nil|no|-|—)[.!]?$/i;

type ReviewBucket = 'changed' | 'unsure' | 'notVerified';

const LABELS: ReadonlyArray<{ readonly key: ReviewBucket; readonly re: RegExp }> = [
  { key: 'notVerified', re: /^(?:what\s+(?:i|was|wasn'?t|is)\s+)?(?:not\s+(?:run|verified|tested|checked|validated)|didn'?t\s+(?:run|verify|test|check)|did\s+not\s+(?:run|verify|test|check)|unverified|untested|not\s+run|skipped\s+(?:verification|tests?)|verification)\b/i },
  { key: 'unsure', re: /^(?:what\s+(?:i'?m|i\s+am)\s+)?(?:unsure|not\s+sure|uncertain(?:ty|ties)?|open\s+questions?|doubts?|caveats?|risks?)\b/i },
  { key: 'changed', re: /^(?:what\s+)?(?:changed|changes|what\s+i\s+did|summary)\b/i },
];
/** A label is a short phrase ("Not run / verified"), not a sentence that happens to start like one. */
const LABEL_MAX_WORDS = 6;

/** Strip a leading bullet or number, heading hashes and bold markers from a line. */
function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\*\*|__/g, '')
    .trim();
}

/** The bucket a label names, if the line starts with one; with the text after the label's `:` or `.`. */
function matchLabel(normalized: string): { key: ReviewBucket; rest: string } | undefined {
  const colon = /^(?<label>[^:.]{1,60}?)\s*[:.]\s*(?<rest>.*)$/s.exec(normalized);
  const candidates = colon?.groups ? [{ label: colon.groups.label, rest: colon.groups.rest }] : [];
  if (normalized.length <= 60) {candidates.push({ label: normalized, rest: '' });}
  for (const { label, rest } of candidates) {
    const words = label.trim().split(/\s+/).length;
    const key = words <= LABEL_MAX_WORDS ? LABELS.find((l) => l.re.test(label.trim()))?.key : undefined;
    if (key) {return { key, rest: rest.trim() };}
  }
  return undefined;
}

/**
 * Split the final message into the text before its "## Self-review" section and
 * the parsed section. Without the section, `review` is undefined and `body` is
 * the whole message.
 */
export function parseSelfReview(message: string): { body: string; review?: SelfReview } {
  const text = message.replace(/\r\n?/g, '\n');
  const heading = SELF_REVIEW_HEADING.exec(text);
  if (!heading) {return { body: text.trim() };}
  const level = heading.groups?.hashes?.length ?? 7;
  const after = text.slice(heading.index + heading[0].length);
  // The section runs to the next heading at the same or a higher level.
  let end = after.length;
  const lines = after.split('\n');
  let offset = 0;
  for (const line of lines) {
    const m = ANY_HEADING.exec(line);
    if (m?.groups && m.groups.hashes.length <= level && offset > 0) {end = offset; break;}
    offset += line.length + 1;
  }
  const section = after.slice(0, end);
  const body = `${text.slice(0, heading.index)}\n${after.slice(end)}`.replace(/\n{3,}/g, '\n\n').trim();

  const review: SelfReview = { unsure: [], notVerified: [] };
  const changed: string[] = [];
  let bucket: ReviewBucket | undefined;
  let classified = false;
  const add = (key: ReviewBucket, item: string, original: string) => {
    if (!item || NOTHING.test(item)) {return;}
    if (key === 'changed') {changed.push(original);}
    else {review[key].push(item);}
  };
  for (const line of section.split('\n')) {
    const normalized = normalizeLine(line);
    if (!normalized) {continue;}
    const label = matchLabel(normalized);
    if (label) {
      bucket = label.key;
      classified = true;
      add(bucket, label.rest, label.rest);
      continue;
    }
    add(bucket ?? 'changed', normalized, line.trim());
  }
  if (changed.length) {review.whatChanged = changed.join('\n').trim();}
  if (!classified) {
    // Prose with no labels at all: it is the section, not a "what changed" paragraph.
    const raw = review.whatChanged ?? section.trim();
    delete review.whatChanged;
    if (raw) {review.raw = raw;}
  }
  return { body, review };
}

/** Clip to `max` characters at a word boundary, marking the cut with an ellipsis. */
export function clipText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) {return t;}
  const cut = t.slice(0, max - 1);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** "1.2k" / "38k" / "512" tokens. */
export function formatTokens(n: number): string {
  if (n < 1000) {return `${Math.round(n)}`;}
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/** The footer's "Run by Celiador on … · k files · elapsed · $cost (in / out tokens)" line. */
export function runFooter(args: TaskPrBodyArgs): string {
  const parts: string[] = [];
  const where = args.runner === 'cloud' ? 'the cloud' : args.machine?.trim();
  parts.push(where ? `Run by Celiador on ${where}` : 'Run by Celiador');
  if (typeof args.files === 'number' && args.files >= 0) {parts.push(`${args.files} file${args.files === 1 ? '' : 's'}`);}
  if (typeof args.elapsedMs === 'number' && args.elapsedMs >= 0) {parts.push(formatDuration(args.elapsedMs));}
  const usage = args.usage;
  if (usage && typeof usage.costUsd === 'number') {
    const tokens = typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
      ? ` (${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out tokens)`
      : '';
    parts.push(`${formatCost(usage.costUsd)}${tokens}`);
  }
  return parts.join(' · ');
}

/**
 * The pull request body (contract §4):
 *
 *     Closes #n
 *
 *     ## What the agent did
 *     <the self-review's "what changed", else the final message clipped to 2000 chars>
 *
 *     ## Self-review
 *     - Unsure about: …
 *     - Not verified: …
 *
 *     ---
 *     Run by Celiador on <machine | the cloud> · k files · elapsed · $cost (in / out tokens)
 *
 * Parts that aren't known are left out rather than written as placeholders.
 */
export function composeTaskPrBody(args: TaskPrBodyArgs): string {
  const { body, review } = parseSelfReview(args.finalMessage ?? '');
  const out: string[] = [];
  if (typeof args.issueNumber === 'number') {out.push(`Closes #${args.issueNumber}`, '');}

  const what = review?.whatChanged || body;
  out.push('## What the agent did', what ? clipText(what, WHAT_CHANGED_MAX_CHARS) : 'The agent did not leave a summary.', '');

  if (review) {
    const bullets = [
      ...review.unsure.map((item) => `- Unsure about: ${item}`),
      ...review.notVerified.map((item) => `- Not verified: ${item}`),
    ];
    if (bullets.length) {out.push('## Self-review', ...bullets, '');}
    else if (review.raw) {out.push('## Self-review', clipText(review.raw, RAW_REVIEW_MAX_CHARS), '');}
  }

  out.push('---', runFooter(args));
  if (args.attribution) {
    // Opt-in (celiador.agentTasks.attribution): the growth loop's one line.
    out.push('', `Made with [Celiador](https://celiador.ai): an agent ran this${typeof args.issueNumber === 'number' ? ` from issue #${args.issueNumber}` : ''} and a person reviewed it.`);
  }
  return out.join('\n');
}
