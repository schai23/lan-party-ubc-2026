# Grok Bot

Grok Bot runs three routines against the Sidekick server: Daily Dispatch, Network Watch and Party Recap. The prompts are in [routines.md](routines.md).

## Chat exports

Humans add the Grok Bot chat exports here after each routine run, named by date and routine, for example:

- `2026-11-20-daily-dispatch.md`
- `2026-11-20-network-watch.md`
- `2026-11-21-party-recap.md`

## Endpoints Grok Bot uses

| Endpoint | Used by |
| --- | --- |
| `GET /status` (plain HTML), `GET /status.json` | all three routines |
| `GET /admin/dispatch?token=GROK_TOKEN` (plain HTML form) | Daily Dispatch, Network Watch (pause request form) |
| `POST /api/dispatch` | Daily Dispatch (the form posts here) |
| `POST /api/pause-requests` | Network Watch |
