# Client Onboarding Automation

Fully automated, hands-free client onboarding using Trigger.dev, Claude AI, and n8n.
When a new client submits an intake form the system runs end-to-end with zero manual steps.

## Architecture

```
Intake Form POST
      │
      ▼
server.ts  (Hono webhook receiver — port 3000)
      │  tasks.trigger("client-onboarding", payload)
      ▼
Trigger.dev Worker
      │
      ├─── Step 2: Claude AI  ──────────────────────────────────── personalize content
      │
      ├─── Step 3: parallel branches ──────────────────────────── batch.triggerByTaskAndWait
      │     ├── n8n → PandaDoc   (contract)
      │     ├── n8n → Gmail      (welcome email)
      │     └── n8n → Notion     (CRM entry)
      │
      ├─── Step 4: n8n → Calendly  ────────────────────────────── schedule first session
      │
      └─── Step 5: n8n → Gmail  ───────────────────────────────── notify coach
```

## Stack

| Layer | Technology | Role |
|---|---|---|
| Orchestration | Trigger.dev v4 | Background task runner, parallel fan-out, retries |
| AI | Anthropic Claude (`claude-sonnet-4-20250514`) | Personalise contract notes, welcome email, CRM tags |
| Integrations | n8n | PandaDoc, Gmail, Notion, Calendly — each a separate sub-workflow |
| Webhook receiver | Hono on Node 20 | Thin HTTP server that enqueues Trigger.dev runs |
| CI/CD | GitHub Actions | Auto-deploy tasks to Trigger.dev on push to `main` |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in every value. See the [Environment Variables](#environment-variables)
table below for descriptions of each key.

### 3. Create a Trigger.dev project

1. Sign up at https://trigger.dev
2. Create a new project
3. Copy the **project ref** (e.g. `proj_abc123`) into:
   - `.env` → `TRIGGER_PROJECT_ID`
   - `trigger.config.ts` → replace `"proj_replace_me"`
4. Copy the **secret key** (API Keys page) → `.env` → `TRIGGER_SECRET_KEY`
5. Copy your **personal access token** (Profile page) → `.env` → `TRIGGER_ACCESS_TOKEN`

### 4. Start the development worker

Terminal 1 — connects the Trigger.dev worker to the cloud and runs tasks locally:

```bash
npm run dev
```

Terminal 2 — starts the Hono webhook receiver:

```bash
npm run server
```

### 5. Test the full flow

```bash
curl -X POST http://localhost:3000/webhook/client-intake \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Jane Smith",
    "email": "jane@example.com",
    "goals": "Build a sustainable consulting practice and land 3 high-ticket clients within 6 months",
    "sessionPreference": "weekly",
    "timezone": "America/Chicago",
    "referralSource": "LinkedIn"
  }'
```

The server responds immediately with `{ "runId": "...", "status": "queued" }`.
Open the Trigger.dev dashboard to watch the run progress through each stage.

---

## n8n Sub-Workflow Setup

Create five separate workflows in n8n. Each starts with a **Webhook** node.
Copy the webhook URL from each workflow into the matching env var in `.env`.

> **Important:** Every workflow must end with a **Respond to Webhook** node that
> explicitly returns the JSON body described below. Without it, n8n returns an empty
> body and the main task cannot capture CRM or Calendly links.

---

### Workflow 1 — Contract (PandaDoc)

**Env var:** `N8N_WEBHOOK_CONTRACT`  
**Webhook path:** `/contract`  
**Method:** POST

**Expected request body:**
```json
{
  "clientName": "string",
  "email": "string",
  "contractNotes": "string"
}
```

**Nodes:**
1. **Webhook** — trigger
2. **Set** — map `contractNotes` into PandaDoc template token values
3. **PandaDoc → Create Document** — create envelope from template, pre-fill name, email, notes
4. **PandaDoc → Send Document** — send envelope to client for e-signature
5. **Respond to Webhook** — return `{ "status": "sent", "documentId": "..." }`

---

### Workflow 2 — Welcome Email (Gmail)

**Env var:** `N8N_WEBHOOK_EMAIL`  
**Webhook path:** `/email`  
**Method:** POST

**Expected request body:**
```json
{
  "clientName": "string",
  "email": "string",
  "welcomeEmailBody": "string"
}
```

**Nodes:**
1. **Webhook** — trigger
2. **Set** — compose subject: `"Welcome aboard, {{ $json.clientName }}!"`
3. **Gmail → Send Email** — to: `email`, subject, body: `welcomeEmailBody`
4. **Respond to Webhook** — return `{ "status": "sent" }`

---

### Workflow 3 — CRM Entry (Notion)

**Env var:** `N8N_WEBHOOK_CRM`  
**Webhook path:** `/crm`  
**Method:** POST

**Expected request body:**
```json
{
  "clientName": "string",
  "email": "string",
  "tags": ["string"],
  "priority": "high | medium | low",
  "notes": "string",
  "firstSessionFocus": "string"
}
```

**Nodes:**
1. **Webhook** — trigger
2. **Notion → Create Database Item** — insert row with all fields; map `tags` to a Multi-select property
3. **Respond to Webhook** — return `{ "url": "<notion-page-url>" }` ← **required field name**

> The `url` field is used by the main task to store the CRM deep link that gets sent to the coach.

---

### Workflow 4 — Session Scheduling (Calendly)

**Env var:** `N8N_WEBHOOK_CALENDLY`  
**Webhook path:** `/calendly`  
**Method:** POST

**Expected request body:**
```json
{
  "clientName": "string",
  "email": "string",
  "timezone": "string",
  "sessionPreference": "string"
}
```

**Nodes:**
1. **Webhook** — trigger
2. **HTTP Request** — call Calendly API to generate a one-off scheduling link with the client's `timezone`
3. **Gmail → Send Email** — email the booking link to the client
4. **Respond to Webhook** — return `{ "bookingUrl": "<calendly-link>" }` ← **required field name**

> The `bookingUrl` field is captured by the main task and included in the coach notification.

---

### Workflow 5 — Coach Notification (Gmail)

**Env var:** `N8N_WEBHOOK_GMAIL`  
**Webhook path:** `/gmail`  
**Method:** POST

**Expected request body:**
```json
{
  "clientName": "string",
  "email": "string",
  "crmLink": "string | 'N/A'",
  "calendlyLink": "string | 'N/A'",
  "crmSummary": {
    "tags": ["string"],
    "priority": "string",
    "notes": "string",
    "firstSessionFocus": "string"
  }
}
```

**Nodes:**
1. **Webhook** — trigger
2. **Set** — build HTML email body with all fields formatted as a summary card
3. **Gmail → Send Email** — to coach's address, subject: `"New client onboarded: {{ $json.clientName }}"`
4. **Respond to Webhook** — return `{ "status": "notified" }`

---

## Deployment (GitHub Actions)

Push to `main` → GitHub Actions automatically deploys all Trigger.dev tasks.

**Required GitHub repository secret:**

| Secret | Value |
|---|---|
| `TRIGGER_ACCESS_TOKEN` | Your personal access token from https://trigger.dev/account |

The project ref is baked into `trigger.config.ts` (committed). No other secrets are needed in CI.

To deploy manually:
```bash
npm run deploy
```

---

## Environment Variables

| Variable | Required | Used by | Description |
|---|---|---|---|
| `TRIGGER_PROJECT_ID` | Yes | `trigger.config.ts` | Project ref from Trigger.dev dashboard (e.g. `proj_abc123`) |
| `TRIGGER_SECRET_KEY` | Yes | `server.ts` | Runtime API secret from Trigger.dev → API Keys |
| `TRIGGER_ACCESS_TOKEN` | Deploy only | CLI + GitHub Actions | Personal access token from your Trigger.dev profile |
| `ANTHROPIC_API_KEY` | Yes | `lib/claude.ts` | From https://console.anthropic.com |
| `N8N_WEBHOOK_CONTRACT` | Yes | `trigger/onboarding.ts` | n8n webhook URL — contract workflow |
| `N8N_WEBHOOK_EMAIL` | Yes | `trigger/onboarding.ts` | n8n webhook URL — welcome email workflow |
| `N8N_WEBHOOK_CRM` | Yes | `trigger/onboarding.ts` | n8n webhook URL — CRM entry workflow |
| `N8N_WEBHOOK_CALENDLY` | Yes | `trigger/onboarding.ts` | n8n webhook URL — session scheduling workflow |
| `N8N_WEBHOOK_GMAIL` | Yes | `trigger/onboarding.ts` | n8n webhook URL — coach notification workflow |
| `PORT` | No | `server.ts` | Webhook receiver port (default: 3000) |
| `WEBHOOK_SECRET` | No | `server.ts` | Shared secret for `x-webhook-secret` header validation |

---

## Project Structure

```
/
├── trigger/
│   └── onboarding.ts       Main Trigger.dev task (3 sub-tasks + orchestrator)
├── lib/
│   ├── claude.ts           Anthropic API wrapper
│   └── n8n.ts              n8n webhook caller with retry
├── prompts/
│   └── onboarding.ts       Claude prompt templates (edit here to tune AI output)
├── .github/
│   └── workflows/
│       └── deploy.yml      GitHub Actions → auto-deploy on push to main
├── workflows/
│   └── onboard-client.md   WAT procedure file for this workflow
├── server.ts               Hono webhook receiver (enqueues Trigger.dev runs)
├── trigger.config.ts       Trigger.dev project configuration
├── tsconfig.json
├── package.json
├── .env.example            Template — copy to .env and fill in values
└── CLAUDE.md               WAT framework master config (read by Claude Code)
```
