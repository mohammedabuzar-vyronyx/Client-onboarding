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

    logger.info("Contract branch — sending to n8n (PandaDoc)", {
      client: payload.clientName,
      email: payload.email,
      contractNotesChars: payload.contractNotes.length,
    });

    const result = await callN8nWebhook(url, {
      clientName: payload.clientName,
      email: payload.email,
      contractNotes: payload.contractNotes,
    });

    if (result.success) {
      logger.info("Contract branch — PandaDoc envelope created and sent", {
        client: payload.clientName,
      });
    } else {
      logger.error("Contract branch — n8n webhook failed", {
        client: payload.clientName,
        error: result.error,
      });
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

    logger.info("Email branch — sending to n8n (Gmail)", {
      client: payload.clientName,
      to: payload.email,
      emailBodyChars: payload.welcomeEmailBody.length,
    });

    const result = await callN8nWebhook(url, {
      clientName: payload.clientName,
      email: payload.email,
      welcomeEmailBody: payload.welcomeEmailBody,
    });

    if (result.success) {
      logger.info("Email branch — welcome email sent via Gmail", {
        client: payload.clientName,
        to: payload.email,
      });
    } else {
      logger.error("Email branch — n8n webhook failed", {
        client: payload.clientName,
        error: result.error,
      });
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

    logger.info("CRM branch — sending to n8n (Notion)", {
      client: payload.clientName,
      priority: payload.priority,
      tags: payload.tags,
      firstSessionFocus: payload.firstSessionFocus,
    });

    const result = await callN8nWebhook(url, {
      clientName: payload.clientName,
      email: payload.email,
      tags: payload.tags,
      priority: payload.priority,
      notes: payload.notes,
      firstSessionFocus: payload.firstSessionFocus,
    });

    // n8n Notion node returns the new page URL in { url: "..." }
    const crmLink =
      result.data !== null &&
      typeof result.data === "object" &&
      "url" in result.data &&
      typeof (result.data as { url: unknown }).url === "string"
        ? (result.data as { url: string }).url
        : undefined;

    if (result.success) {
      logger.info("CRM branch — Notion record created", {
        client: payload.clientName,
        crmLink: crmLink ?? "(no URL returned by n8n)",
      });
    } else {
      logger.error("CRM branch — n8n webhook failed", {
        client: payload.clientName,
        error: result.error,
      });
    }

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
    metadata.set("timezone", payload.timezone);
    metadata.set("referralSource", payload.referralSource);
    metadata.set("stage", "started");

    logger.info("━━━ Client onboarding started ━━━", {
      clientName: payload.clientName,
      email: payload.email,
      sessionPreference: payload.sessionPreference,
      timezone: payload.timezone,
      referralSource: payload.referralSource,
    });

    // --- Step 2: AI personalization ---
    metadata.set("stage", "ai-personalization");
    logger.info("Step 2 — Calling Claude for AI personalization");

    let aiOutput: OnboardingAIOutput;
    try {
      aiOutput = await generateOnboardingContent(payload);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown Claude API error";
      logger.error("Step 2 — Claude personalization failed, aborting run", {
        error: errorMessage,
      });
      metadata.set("stage", "failed-ai");
      throw err;
    }

    metadata.set("crmPriority", aiOutput.crmSummary.priority);
    metadata.set("crmTags", aiOutput.crmSummary.tags.join(", "));

    logger.info("Step 2 — AI personalization complete", {
      contractNotesChars: aiOutput.contractNotes.length,
      welcomeEmailChars: aiOutput.welcomeEmailBody.length,
      crmPriority: aiOutput.crmSummary.priority,
      crmTags: aiOutput.crmSummary.tags,
      firstSessionFocus: aiOutput.crmSummary.firstSessionFocus,
    });

    // --- Step 3: Parallel branches ---
    // Promise.all with triggerAndWait is NOT supported by Trigger.dev.
    // batch.triggerByTaskAndWait fans out to multiple different tasks in parallel.
    metadata.set("stage", "parallel-branches");
    logger.info("Step 3 — Launching 3 parallel branches (contract / email / CRM)");

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

    // Log a single consolidated summary for all 3 branches
    logger.info("Step 3 — Branch results", {
      contract: contractRun.ok ? "✓ ok" : `✗ failed — ${contractRun.error}`,
      email: emailRun.ok ? "✓ ok" : `✗ failed — ${emailRun.error}`,
      crm: crmRun.ok ? "✓ ok" : `✗ failed — ${crmRun.error}`,
    });

    if (!contractRun.ok) {
      logger.error("Step 3 — Contract branch failed (non-blocking)", {
        error: contractRun.error,
      });
    }
    if (!emailRun.ok) {
      logger.error("Step 3 — Email branch failed (non-blocking)", {
        error: emailRun.error,
      });
    }
    if (!crmRun.ok) {
      logger.error("Step 3 — CRM branch failed (non-blocking)", {
        error: crmRun.error,
      });
    }

    const crmLink =
      crmRun.ok && crmRun.output.crmLink ? crmRun.output.crmLink : null;

    if (crmLink) {
      metadata.set("crmLink", crmLink);
      logger.info("Step 3 — CRM link captured", { crmLink });
    } else {
      logger.warn("Step 3 — No CRM link returned from Notion (will send N/A to coach)");
    }

    // --- Step 4: Schedule first session ---
    metadata.set("stage", "scheduling");
    logger.info("Step 4 — Scheduling first session via Calendly", {
      client: payload.clientName,
      timezone: payload.timezone,
      sessionPreference: payload.sessionPreference,
    });

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

    if (calendlyResult.success && calendlyLink) {
      metadata.set("calendlyLink", calendlyLink);
      logger.info("Step 4 — Calendly booking link created and emailed to client", {
        client: payload.clientName,
        calendlyLink,
      });
    } else if (calendlyResult.success && !calendlyLink) {
      logger.warn("Step 4 — Calendly webhook succeeded but returned no bookingUrl");
    } else {
      logger.error("Step 4 — Calendly scheduling webhook failed (non-blocking)", {
        error: calendlyResult.error,
      });
    }

    // --- Step 5: Notify coach ---
    metadata.set("stage", "coach-notification");
    logger.info("Step 5 — Notifying coach via Gmail", {
      client: payload.clientName,
      crmLink: crmLink ?? "N/A",
      calendlyLink: calendlyLink ?? "N/A",
    });

    const gmailUrl = process.env.N8N_WEBHOOK_GMAIL;
    if (!gmailUrl) throw new Error("N8N_WEBHOOK_GMAIL env var is not set");

    const coachResult = await callN8nWebhook(gmailUrl, {
      clientName: payload.clientName,
      email: payload.email,
      crmLink: crmLink ?? "N/A",
      calendlyLink: calendlyLink ?? "N/A",
      crmSummary: aiOutput.crmSummary,
    });

    if (coachResult.success) {
      logger.info("Step 5 — Coach notification email sent", {
        client: payload.clientName,
      });
    } else {
      logger.error("Step 5 — Coach notification webhook failed (non-blocking)", {
        error: coachResult.error,
      });
    }

    // --- Done ---
    metadata.set("stage", "completed");

    const allBranchesOk = contractRun.ok && emailRun.ok && crmRun.ok;
    logger.info("━━━ Client onboarding completed ━━━", {
      clientName: payload.clientName,
      email: payload.email,
      allBranchesOk,
      steps: {
        contract: contractRun.ok,
        welcomeEmail: emailRun.ok,
        crmEntry: crmRun.ok,
        calendlyScheduled: calendlyResult.success,
        coachNotified: coachResult.success,
      },
      links: {
        crmLink: crmLink ?? "N/A",
        calendlyLink: calendlyLink ?? "N/A",
      },
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
