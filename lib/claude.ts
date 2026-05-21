import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@trigger.dev/sdk";
import {
  buildSystemPrompt,
  buildUserPrompt,
  ONBOARDING_MODEL,
  ONBOARDING_MAX_TOKENS,
  type OnboardingPayload,
} from "../prompts/onboarding.js";

/** Structured output produced by the AI personalization step. */
export interface OnboardingAIOutput {
  contractNotes: string;
  welcomeEmailBody: string;
  crmSummary: {
    tags: string[];
    priority: "high" | "medium" | "low";
    notes: string;
    firstSessionFocus: string;
  };
}

/** Singleton Anthropic client — reads ANTHROPIC_API_KEY from env automatically. */
const anthropic = new Anthropic();

/**
 * Calls Claude to generate personalized onboarding content for a new client.
 *
 * Uses the prompts from `prompts/onboarding.ts` so AI behaviour can be
 * tuned without touching this wrapper.
 *
 * @param payload - Validated client intake payload
 * @returns Parsed AI output with contractNotes, welcomeEmailBody, and crmSummary
 * @throws Error if the API call fails or the response cannot be parsed
 */
export async function generateOnboardingContent(
  payload: OnboardingPayload
): Promise<OnboardingAIOutput> {
  logger.info("Calling Claude API", {
    model: ONBOARDING_MODEL,
    maxTokens: ONBOARDING_MAX_TOKENS,
    client: payload.clientName,
  });

  const message = await anthropic.messages.create({
    model: ONBOARDING_MODEL,
    max_tokens: ONBOARDING_MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(payload),
      },
    ],
  });

  logger.info("Claude API responded", {
    stopReason: message.stop_reason,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });

  const firstBlock = message.content[0];
  if (firstBlock.type !== "text") {
    throw new Error(
      `Unexpected Claude response block type: ${firstBlock.type}`
    );
  }

  const rawText = firstBlock.text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    logger.error("Claude returned non-JSON — raw response logged", {
      preview: rawText.slice(0, 300),
    });
    throw new Error(
      `Claude returned non-JSON content. Raw response: ${rawText.slice(0, 200)}`
    );
  }

  if (!isOnboardingAIOutput(parsed)) {
    logger.error("Claude JSON shape mismatch", {
      received: JSON.stringify(parsed).slice(0, 300),
    });
    throw new Error(
      `Claude JSON response did not match expected shape. Got: ${JSON.stringify(parsed).slice(0, 300)}`
    );
  }

  logger.info("Claude content parsed successfully", {
    contractNotesChars: parsed.contractNotes.length,
    welcomeEmailChars: parsed.welcomeEmailBody.length,
    crmPriority: parsed.crmSummary.priority,
    crmTags: parsed.crmSummary.tags,
    firstSessionFocus: parsed.crmSummary.firstSessionFocus,
  });

  return parsed;
}

/**
 * Type guard that validates the shape of the Claude JSON response at runtime.
 *
 * @param value - Unknown value from JSON.parse
 * @returns True if value matches OnboardingAIOutput
 */
function isOnboardingAIOutput(value: unknown): value is OnboardingAIOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (typeof v.contractNotes !== "string") return false;
  if (typeof v.welcomeEmailBody !== "string") return false;
  if (typeof v.crmSummary !== "object" || v.crmSummary === null) return false;

  const crm = v.crmSummary as Record<string, unknown>;
  if (!Array.isArray(crm.tags)) return false;
  if (!["high", "medium", "low"].includes(crm.priority as string)) return false;
  if (typeof crm.notes !== "string") return false;
  if (typeof crm.firstSessionFocus !== "string") return false;

  return true;
}
