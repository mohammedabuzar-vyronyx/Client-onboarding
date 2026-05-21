# CLAUDE.md — Master Configuration

## WAT Framework

This project is organised around three layers:

| Layer | What it is | Lives in |
|---|---|---|
| **W — Workflows** | Step-by-step procedure files that orchestrate the work. Each file defines a discrete process: what triggers it, what steps to follow, what the done-state looks like. | `/workflows/` |
| **A — Agent** | Claude Code — the AI agent that reads this file at session start, loads the relevant workflow, plans the execution, and drives every step to completion. | *(you are here)* |
| **T — Tools** | Scripts and integrations the agent calls to get things done: Trigger.dev task runners, API wrappers, data-transformation scripts, and any CLI helpers. | `/tools/` |

The agent never acts without a workflow. The workflow never runs without tools. Together, WAT turns a prompt into a repeatable, auditable automation.

---

## Project — Client Onboarding Workflow with Trigger.dev

**Goal:** Automate the end-to-end client onboarding process using Trigger.dev as the task-orchestration backbone.

**Stack:**
- [Trigger.dev](https://trigger.dev/docs/manual-setup) — background job orchestration (tasks, schedules, triggers)
- Node.js / TypeScript — task implementation language
- `.env` — all secrets and API keys (never committed to git)

---

## Folder Structure

```
/
├── CLAUDE.md                  ← you are here (session config, read first)
├── .env                       ← API keys and secrets (NEVER commit)
│
├── workflows/                 ← W: procedure files
│   └── *.md                   ←   one file per process (e.g. onboard-client.md)
│
├── tools/                     ← T: scripts and integrations
│   └── *.ts / *.js            ←   Trigger.dev tasks, API wrappers, CLI helpers
│
└── temp/                      ← working scratch space (ephemeral, not committed)
    ├── outputs/               ←   generated artefacts (reports, exports, logs)
    └── resources/             ←   downloaded inputs (CSVs, API responses, etc.)
```

---

## Session Rules

1. **Read this file first.** Every session starts here before touching any code or tool.
2. **Pick a workflow.** Identify which `/workflows/*.md` file governs the current task. If none exists, create one before writing code.
3. **Use the tools layer.** All side-effects (API calls, file writes, Trigger.dev task invocations) go through `/tools/`. Do not inline business logic in ad-hoc scripts.
4. **Write to `/temp/` for scratch work.** Outputs go in `/temp/outputs/`, downloaded inputs in `/temp/resources/`. Nothing in `/temp/` is committed.
5. **Never commit `.env`.** Secrets stay local. Document required env vars in each workflow file under an `## Environment` section.
6. **One workflow file per process.** Keep workflows small and single-purpose. Compose complex processes by chaining workflow files, not by growing a single file.
7. **End every session with a status note.** Append a brief `## Session Log` entry to the relevant workflow file: date, what was done, what is next.

---

## Trigger.dev Quick Reference

- Docs: https://trigger.dev/docs/manual-setup
- Dev server: `npx trigger.dev@latest dev`
- Deploy: `npx trigger.dev@latest deploy`
- Tasks live in `/tools/` and are imported by the Trigger.dev runtime automatically when following the standard project layout.
- Use the `mcp__trigger__*` MCP tools available in this session to inspect runs, list projects, trigger tasks, and check dev-server status without leaving the agent.

---

## Environment Variables

All required keys must be present in `.env` before any workflow runs. Add new variables here as the project grows.

| Variable | Purpose |
|---|---|
| `TRIGGER_SECRET_KEY` | Trigger.dev API secret (from project settings) |
| `TRIGGER_PROJECT_ID` | Trigger.dev project ID |

See individual workflow files for service-specific variables (e.g. CRM API keys, email provider tokens).
