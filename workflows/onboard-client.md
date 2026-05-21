# Workflow: Onboard Client

## Purpose
Automate the end-to-end onboarding of a new coaching client from intake form submission
to coach notification — including contract creation, welcome email, CRM entry, and
session scheduling — with zero manual steps.

## Trigger
A **Tally form submission**. When the client submits the intake form, Tally fires a webhook
to `POST /webhook/tally` on the server (`server.ts`), which maps Tally's field format to our
schema and enqueues the Trigger.dev run.

**Tally setup:**
1. Open your Tally form → Integrate → Webhooks
2. Add webhook URL: `https://<your-server>/webhook/tally`
3. Ensure your form has fields whose **labels** contain these keywords (case-insensitive):
   - `name` → mapped to `clientName`
   - `email` → mapped to `email`
   - `goal` → mapped to `goals`
   - `session` → mapped to `sessionPreference` (e.g. "Session Frequency")
   - `timezone` → mapped to `timezone`
   - `referral` → mapped to `referralSource` (e.g. "How did you hear about us?")

## Payload Shape
```json
{
  "clientName": "string (required)",
  "email": "string — valid email (required)",
  "goals": "string (required)",
  "sessionPreference": "string e.g. weekly / biweekly (required)",
  "timezone": "string e.g. America/New_York (required)",
  "referralSource": "string (required)"
}
```

## n8n Workflows

There are **6 n8n workflows** in total — one intake workflow that fires the Trigger.dev task,
and five outbound workflows called by the Trigger.dev task.

### Workflow 0 — Tally Form Intake *(triggers the whole pipeline)*

This workflow is **optional** — it gives you a pure-n8n path if you want to avoid hosting
`server.ts` publicly. If you are hosting the server, point Tally directly at `/webhook/tally`
and skip this workflow.

| Node | Type | Configuration |
|------|------|---------------|
| Tally Intake | Webhook (POST) | Path: `tally-intake` |
| Map Fields | Code | See code below |
| Trigger Task | HTTP Request | POST `https://api.trigger.dev/api/v1/tasks/client-onboarding/trigger`, Auth: Bearer `{{ $env.TRIGGER_SECRET_KEY }}`, Body: `{ "payload": {{ $json }} }` |
| Respond | Respond to Webhook | `{ "status": "queued" }` |

**Map Fields code node:**
```javascript
const fields = $json.data.fields;
const get = (...labels) => {
  for (const label of labels) {
    const f = fields.find(f => f.label.toLowerCase().includes(label.toLowerCase()));
    if (f && f.value) return Array.isArray(f.value) ? f.value.join(', ') : String(f.value);
  }
  return '';
};
return [{
  json: {
    clientName:        get('full name', 'name', 'client name'),
    email:             get('email'),
    goals:             get('goal'),
    sessionPreference: get('session preference', 'session frequency', 'session'),
    timezone:          get('timezone', 'time zone'),
    referralSource:    get('how did you hear', 'referral', 'hear about', 'source'),
  }
}];
```

---

## Steps

### Step 1 — Webhook Receiver (`server.ts`)
- Receives the POST
- Validates `x-webhook-secret` header if `WEBHOOK_SECRET` env var is set
- Calls `tasks.trigger("client-onboarding", payload)` — enqueues the Trigger.dev run
- Returns `{ runId, status: "queued" }` immediately (202 Accepted)
- Payload schema validation happens on the Trigger.dev worker side

### Step 2 — AI Personalization (`lib/claude.ts` + `prompts/onboarding.ts`)
- Calls `claude-sonnet-4-20250514` with system + user prompts
- Generates three outputs:
  - `contractNotes` — 2-3 sentences on the client's goals for the contract
  - `welcomeEmailBody` — ~150 word warm welcome email, plain text
  - `crmSummary` — `{ tags[], priority, notes, firstSessionFocus }`
- **If this step fails the entire run fails.** Fix the API key or prompt and re-trigger.

### Step 3 — Parallel Branches (`batch.triggerByTaskAndWait`)
All three run concurrently. Failures are logged but do not block steps 4 or 5.

| Branch | Sub-task ID | Env Var | n8n → Downstream |
|--------|-------------|---------|------------------|
| A — Contract | `onboarding-contract-branch` | `N8N_WEBHOOK_CONTRACT` | PandaDoc envelope |
| B — Email | `onboarding-email-branch` | `N8N_WEBHOOK_EMAIL` | Gmail welcome email |
| C — CRM | `onboarding-crm-branch` | `N8N_WEBHOOK_CRM` | Notion row insert |

**n8n response requirements:**
- CRM workflow must return `{ "url": "<notion-page-url>" }` so the main task can capture the CRM deep link
- All n8n workflows must end with a `Respond to Webhook` node

### Step 4 — Schedule First Session
- POST to `N8N_WEBHOOK_CALENDLY` → `{ clientName, email, timezone, sessionPreference }`
- n8n creates a Calendly one-off link and emails it to the client
- n8n response must return `{ "bookingUrl": "<link>" }` for the main task to capture it
- Failure is logged; run continues

### Step 5 — Notify Coach
- POST to `N8N_WEBHOOK_GMAIL` → `{ clientName, email, crmLink, calendlyLink, crmSummary }`
- n8n sends a summary email to the coach
- Failure is logged; run completes regardless

## Environment Variables
| Variable | Step | Description |
|---|---|---|
| `TRIGGER_SECRET_KEY` | 1 | Runtime SDK key used by `tasks.trigger()` in server.ts |
| `ANTHROPIC_API_KEY` | 2 | Claude API key |
| `N8N_WEBHOOK_CONTRACT` | 3A | n8n Webhook URL for contract workflow |
| `N8N_WEBHOOK_EMAIL` | 3B | n8n Webhook URL for welcome email workflow |
| `N8N_WEBHOOK_CRM` | 3C | n8n Webhook URL for CRM entry workflow |
| `N8N_WEBHOOK_CALENDLY` | 4 | n8n Webhook URL for Calendly scheduling workflow |
| `N8N_WEBHOOK_GMAIL` | 5 | n8n Webhook URL for coach notification workflow |
| `WEBHOOK_SECRET` | 1 | Optional shared secret for intake webhook |

See `.env.example` for all variables including Trigger.dev deploy credentials.

## Error Handling Matrix
| Failure point | Behaviour | Recovery |
|---|---|---|
| Step 2 — Claude API | Run fails immediately | Check `ANTHROPIC_API_KEY`; re-trigger from dashboard |
| Step 3 — any branch | Branch logged as failed; run continues | Re-run individual sub-task from dashboard |
| Step 4 — Calendly | Logged; run continues | Re-run manually or trigger a new one-off |
| Step 5 — Coach email | Logged; run completes | Send coach email manually if critical |

## Testing
```bash
curl -X POST http://localhost:3000/webhook/client-intake \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Jane Smith",
    "email": "jane@example.com",
    "goals": "Build a sustainable consulting practice and land 3 high-ticket clients",
    "sessionPreference": "weekly",
    "timezone": "America/Chicago",
    "referralSource": "LinkedIn"
  }'
```

Watch the run live in the Trigger.dev dashboard. The `stage` metadata field updates at
each step so you can see exactly where a run is if it stalls.

## Session Log
<!-- Append entries here after each working session: date, what was done, what is next -->
