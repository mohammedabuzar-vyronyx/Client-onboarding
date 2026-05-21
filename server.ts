import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { tasks } from "@trigger.dev/sdk";
import type { clientOnboardingTask } from "./trigger/onboarding.js";

const app = new Hono();

/** Health check — useful for load balancers and uptime monitors. */
app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * Webhook receiver for client intake form submissions.
 *
 * Accepts a POST with the ClientIntakePayload JSON body and enqueues a
 * `client-onboarding` Trigger.dev run. Payload schema validation happens
 * on the worker side (schemaTask), keeping this server thin and stateless.
 *
 * Optional header `x-webhook-secret` must match WEBHOOK_SECRET env var
 * when that variable is set.
 *
 * Expected request body:
 * {
 *   clientName: string
 *   email: string
 *   goals: string
 *   sessionPreference: string
 *   timezone: string
 *   referralSource: string
 * }
 *
 * Responds 202 { runId, status: "queued" } on success.
 */
app.post("/webhook/client-intake", async (c) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const incoming = c.req.header("x-webhook-secret");
    if (incoming !== secret) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let handle: { id: string };
  try {
    handle = await tasks.trigger<typeof clientOnboardingTask>(
      "client-onboarding",
      payload as Parameters<typeof clientOnboardingTask.run>[0]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Trigger failed";
    return c.json({ error: message }, 422);
  }

  return c.json({ runId: handle.id, status: "queued" }, 202);
});

// ---------------------------------------------------------------------------
// Tally webhook receiver
// ---------------------------------------------------------------------------

/**
 * Find a Tally field value by partial label match (case-insensitive).
 * Handles both string values and array values (e.g. multi-select → joined).
 */
function tallyFieldValue(
  fields: Array<{ label: string; type: string; value: unknown }>,
  ...labelFragments: string[]
): string {
  for (const fragment of labelFragments) {
    const match = fields.find(
      (f) =>
        typeof f.label === "string" &&
        f.label.toLowerCase().includes(fragment.toLowerCase())
    );
    if (!match) continue;
    if (typeof match.value === "string" && match.value.trim()) return match.value.trim();
    if (Array.isArray(match.value) && match.value.length > 0) {
      return (match.value as unknown[]).map(String).join(", ");
    }
  }
  return "";
}

/**
 * Tally form webhook receiver.
 *
 * Configure your Tally form's Integrations → Webhooks to POST to this URL.
 * Tally sends: { eventType: "FORM_RESPONSE", data: { fields: [{ label, type, value }] } }
 *
 * Field labels in your Tally form MUST include these words (case-insensitive):
 *   - "name"            → clientName
 *   - "email"           → email
 *   - "goal"            → goals
 *   - "session"         → sessionPreference  (e.g. "Session Frequency")
 *   - "timezone"        → timezone
 *   - "referral"        → referralSource     (e.g. "How did you hear about us?")
 */
app.post("/webhook/tally", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tallyBody = body as Record<string, unknown>;
  const data = tallyBody?.data as Record<string, unknown> | undefined;
  if (!data || !Array.isArray(data.fields)) {
    return c.json({ error: "Invalid Tally payload: missing data.fields" }, 400);
  }

  const fields = data.fields as Array<{ label: string; type: string; value: unknown }>;

  const payload = {
    clientName: tallyFieldValue(fields, "full name", "name", "client name"),
    email: tallyFieldValue(fields, "email"),
    goals: tallyFieldValue(fields, "goal"),
    sessionPreference: tallyFieldValue(fields, "session preference", "session frequency", "session", "frequency"),
    timezone: tallyFieldValue(fields, "timezone", "time zone"),
    referralSource: tallyFieldValue(fields, "how did you hear", "referral", "hear about us", "source"),
  };

  const missingFields = Object.entries(payload)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missingFields.length > 0) {
    return c.json(
      {
        error: `Could not map Tally fields: ${missingFields.join(", ")}. Ensure form field labels contain the expected keywords.`,
      },
      422
    );
  }

  let handle: { id: string };
  try {
    handle = await tasks.trigger<typeof clientOnboardingTask>(
      "client-onboarding",
      payload as Parameters<typeof clientOnboardingTask.run>[0]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Trigger failed";
    return c.json({ error: message }, 422);
  }

  return c.json({ runId: handle.id, status: "queued" }, 202);
});

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Webhook server listening on http://localhost:${port}`);
  console.log(`POST /webhook/tally          — Tally form submission (primary trigger)`);
  console.log(`POST /webhook/client-intake  — manual trigger (raw JSON)`);
  console.log(`GET  /health                 — health check`);
});
