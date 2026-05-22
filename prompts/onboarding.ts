/**
 * Prompt templates for client onboarding AI personalization.
 *
 * Intentionally free of SDK imports so prompts can be tested,
 * versioned, and iterated on without touching any integration code.
 */

/** Shape of the raw intake form payload passed into the onboarding task. */
export interface OnboardingPayload {
  clientName: string;
  email: string;
  goals: string;
  sessionPreference: string;
  timezone: string;
  referralSource: string;
}

/**
 * Returns the system prompt that instructs Claude to produce structured
 * onboarding content. Kept separate from the user prompt so each can
 * be tuned independently.
 */
export function buildSystemPrompt(): string {
  return `You are an expert client success specialist helping onboard new coaching clients.
Your role is to produce warm, personalized, professional content based on a client intake form.

Always respond with a single valid JSON object — no markdown fences, no prose outside the JSON.
The JSON must conform exactly to this shape:
{
  "contractNotes": "<string: 2-3 sentences summarizing the client's goals for the contract>",
  "welcomeEmailBody": "<string: ~150 word warm welcome email in plain text, no subject line>",
  "crmSummary": {
    "tags": ["<tag1>", "<tag2>"],
    "priority": "<high|medium|low>",
    "notes": "<string: 1-2 sentences of CRM intake notes>",
    "firstSessionFocus": "<string: suggested focus area for the first session>"
  }
}`;
}

/**
 * Builds the user message with all six intake fields injected.
 *
 * @param payload - Raw intake form data from the webhook event
 * @returns Fully formed user message string for the Claude API
 */
export function buildUserPrompt(payload: OnboardingPayload): string {
  return `Here is the client intake information:

Client Name: ${payload.clientName}
Email: ${payload.email}
Goals: ${payload.goals}
Session Preference: ${payload.sessionPreference}
Timezone: ${payload.timezone}
Referral Source: ${payload.referralSource}

Generate the onboarding content now. Remember: respond only with the JSON object.`;
}

/**
 * Claude model used for onboarding personalization.
 * Update this constant to switch models without touching any other file.
 */
export const ONBOARDING_MODEL = "claude-sonnet-4-5" as const;

/**
 * Token ceiling for the onboarding response.
 * The JSON output is compact; 1024 tokens is well above the ceiling.
 */
export const ONBOARDING_MAX_TOKENS = 1024 as const;
