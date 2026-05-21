import { task, logger, metadata, batch, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { generateOnboardingContent } from "../lib/claude.js";
import { callN8nWebhook } from "../lib/n8n.js";
import type { OnboardingAIOutput } from "../lib/claude.js";

// ---------------------------------------------------------------------------
// Payload schema — validated by schemaTask before the run body executes
// ---------------------------------------------------------------------------

const ClientIntakeSchema = z.object({
  clientName: z.string().min(1),
  email: z.string().email(),
  goals: z.string().min(1),
  sessionPreference: z.string().min(1),
  timezone: z.string().min(1),
  referralSource: z.string().min(1),
});

type ClientIntakePayload = z.infer<typeof ClientIntakeSchema>;

// ---------------------------------------------------------------------------
// Branch sub-tasks — each is a separate exported task so Trigger.dev can
// schedule them independently. All three are triggered in parallel by the
// main task via batch.triggerByTaskAndWait.
// ---------------------------------------------------------------------------

/**
 * Branch A — POSTs contract notes to n8n, which creates a PandaDoc envelope.
 */
export const contractBranchTask = task({
  id: "onboarding-contract-branch",
  retry: { maxAttempts: 2 },
  run: async (payload: {
    clientName: string;
    email: string;
    contractNotes: string;
  }): Promise<{ success: boolean; data: unknown }> => {
    const url = process.env.N8N_WEBHOOK_CONTRACT;
    if (!url) throw new Error("N8N_WEBHOOK_CONTRACT env var is not set");

    logger.info("Sending contract webhook", { clientName: payload.clientName });

    const result = await callN8nWebhook(url, {
      clientName: payload.clientName,
      email: payload.email,
      contractNotes: payload.contractNotes,
    });

    if (!result.success) {
      logger.error("Contract webhook failed", { error: result.error });
    }

    return { success: result.success, data: result.data };
  },
});

/**
 * Branch B — POSTs welcome email body to n8n, which sends it via Gmail.
 */
export const emailBranchTask = task({
  id: "onboarding-email-branch",
  retry: { maxAttempts: 2 },
  run: async (payload: {
    clientName: string;
    email: string;
    welcomeEmailBody: string;
  }): Promise<{ success: boolean; data: unknown }> => {
    const url = process.env.N8N_WEBHOOK_EMAIL;
    if (!url) throw new Error("N8N_WEBHOOK_EMAIL env var is not set");

    logger.info("Sending welcome email webhook", {
      clientName: payload.clientName,
    });

    const result = await callN8nWebhook(url, {
      clientName: payload.clientName,
      email: payload.email,
      welcomeEmailBody: payload.welcomeEmailBody,
    });

    if (!result.success) {
      logger.error("Welcome email webhook failed", { error: result.error });
    }

    return { success: result.success, data: result.data };
  },
});

/**
 * Branch C — POSTs CRM data to n8n, which inserts a row into Notion.
 * Extracts the new Notion page URL from the n8n response.
 */
export const crmBranchTask = task({
  id: "onboarding-crm-branch",
  retry: { maxAttempts: 2 },
  run: async (payload: {
    clientName: string;
    email: string;
    tags: string[];
    priority: string;
    notes: string;
    firstSessionFocus: string;
  }): Promise<{ success: boolean; data: unknown; crmLink?: string }> => {
    const url = process.env.N8N_WEBHOOK_CRM;
    if (!url) throw new Error("N8N_WEBHOOK_CRM env var is not set");

    logger.info("Sending CRM webhook", { clientName: payload.clientName });

    const result = await callN8nWebhook(url, {
      clientName: payload.clientName,
      email: payload.email,
      tags: payload.tags,
      priority: payload.priority,
      notes: payload.notes,
      firstSessionFocus: payload.firstSessionFocus,
    });

    if (!result.success) {
      logger.error("CRM webhook failed", { error: result.error });
    }

    // n8n Notion node typically returns the new page URL in { url: "..." }
    const crmLink =
      result.data !== null &&
      typeof result.data === "object" &&
      "url" in result.data &&
      typeof (result.data as { url: unknown }).url === "string"
        ? (result.data as { url: string }).url
        : undefined;

    return { success: result.success, data: result.data, crmLink };
  },
});

// ---------------------------------------------------------------------------
// Main orchestration task
// ---------------------------------------------------------------------------

/**
 * Primary onboarding task. Triggered by POSTing a ClientIntakePayload to
 * the webhook receiver (server.ts → POST /webhook/client-intake).
 *
 * Steps:
 *  1. Attach run metadata for dashboard visibility
 *  2. Generate personalized content via Claude
 *  3. Fan out to 3 parallel branches (contract, email, CRM)
 *  4. Schedule first session via Calendly
 *  5. Notify the coach via Gmail
 */
export const clientOnboardingTask = schemaTask({
  id: "client-onboarding",
  schema: ClientIntakeSchema,
  // The main task does not auto-retry — sub-tasks handle their own retries.
  retry: { maxAttempts: 1 },
  run: async (payload: ClientIntakePayload) => {
    // --- Step 1: Attach run metadata ---
    metadata.set("clientName", payload.clientName);
    metadata.set("email", payload.email);
    metadata.set("stage", "started");

    logger.info("Client onboarding started", {
      clientName: payload.clientName,
      email: payload.email,
    });

    // --- Step 2: AI personalization ---
    metadata.set("stage", "ai-personalization");
    logger.info("Generating AI personalization content");

    let aiOutput: OnboardingAIOutput;
    try {
      aiOutput = await generateOnboardingContent(payload);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown Claude API error";
      logger.error("Claude personalization failed — aborting", {
        error: errorMessage,
      });
      metadata.set("stage", "failed-ai");
      throw err;
    }

    logger.info("AI content generated", {
      contractNotesLength: aiOutput.contractNotes.length,
      emailBodyLength: aiOutput.welcomeEmailBody.length,
      crmPriority: aiOutput.crmSummary.priority,
    });

    // --- Step 3: Parallel branches ---
    // Promise.all with triggerAndWait is NOT supported by Trigger.dev.
    // batch.triggerByTaskAndWait fans out to multiple different tasks in parallel.
    metadata.set("stage", "parallel-branches");
    logger.info("Starting parallel branches: contract, email, CRM");

    const { runs: branchRuns } = await batch.triggerByTaskAndWait([
      {
        task: contractBranchTask,
        payload: {
          clientName: payload.clientName,
          email: payload.email,
          contractNotes: aiOutput.contractNotes,
        },
      },
      {
        task: emailBranchTask,
        payload: {
          clientName: payload.clientName,
          email: payload.email,
          welcomeEmailBody: aiOutput.welcomeEmailBody,
        },
      },
      {
        task: crmBranchTask,
        payload: {
          clientName: payload.clientName,
          email: payload.email,
          tags: aiOutput.crmSummary.tags,
          priority: aiOutput.crmSummary.priority,
          notes: aiOutput.crmSummary.notes,
          firstSessionFocus: aiOutput.crmSummary.firstSessionFocus,
        },
      },
    ]);

    // Positional destructure matches the input array order above
    const [contractRun, emailRun, crmRun] = branchRuns;

    if (!contractRun.ok) {
      logger.error("Contract branch failed", { error: contractRun.error });
    }
    if (!emailRun.ok) {
      logger.error("Email branch failed", { error: emailRun.error });
    }
    if (!crmRun.ok) {
      logger.error("CRM branch failed", { error: crmRun.error });
    }

    const crmLink =
      crmRun.ok && crmRun.output.crmLink ? crmRun.output.crmLink : null;

    // --- Step 4: Schedule first session ---
    metadata.set("stage", "scheduling");
    logger.info("Scheduling first session via Calendly");

    const calendlyUrl = process.env.N8N_WEBHOOK_CALENDLY;
    if (!calendlyUrl) throw new Error("N8N_WEBHOOK_CALENDLY env var is not set");

    const calendlyResult = await callN8nWebhook(calendlyUrl, {
      clientName: payload.clientName,
      email: payload.email,
      timezone: payload.timezone,
      sessionPreference: payload.sessionPreference,
    });

    // n8n Calendly workflow returns { bookingUrl: "..." }
    const calendlyLink =
      calendlyResult.success &&
      calendlyResult.data !== null &&
      typeof calendlyResult.data === "object" &&
      "bookingUrl" in calendlyResult.data &&
      typeof (calendlyResult.data as { bookingUrl: unknown }).bookingUrl === "string"
        ? (calendlyResult.data as { bookingUrl: string }).bookingUrl
        : null;

    if (!calendlyResult.success) {
      logger.error("Calendly scheduling webhook failed", {
        error: calendlyResult.error,
      });
    }

    // --- Step 5: Notify coach ---
    metadata.set("stage", "coach-notification");
    logger.info("Notifying coach");

    const gmailUrl = process.env.N8N_WEBHOOK_GMAIL;
    if (!gmailUrl) throw new Error("N8N_WEBHOOK_GMAIL env var is not set");

    const coachResult = await callN8nWebhook(gmailUrl, {
      clientName: payload.clientName,
      email: payload.email,
      crmLink: crmLink ?? "N/A",
      calendlyLink: calendlyLink ?? "N/A",
      crmSummary: aiOutput.crmSummary,
    });

    if (!coachResult.success) {
      logger.error("Coach notification webhook failed", {
        error: coachResult.error,
      });
    }

    metadata.set("stage", "completed");

    logger.info("Client onboarding completed", {
      clientName: payload.clientName,
      email: payload.email,
      contractOk: contractRun.ok,
      emailOk: emailRun.ok,
      crmOk: crmRun.ok,
      calendlyOk: calendlyResult.success,
      coachNotifyOk: coachResult.success,
    });

    return {
      success: true,
      clientName: payload.clientName,
      email: payload.email,
      branches: {
        contract: contractRun.ok,
        email: emailRun.ok,
        crm: crmRun.ok,
      },
      calendlyLink,
      crmLink,
    };
  },
});
