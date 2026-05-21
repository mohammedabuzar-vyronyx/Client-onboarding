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

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Webhook server listening on http://localhost:${port}`);
  console.log(`POST /webhook/client-intake  — trigger an onboarding run`);
  console.log(`GET  /health                 — health check`);
});
