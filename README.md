# Settle: get paid without chasing

Settle is an AI accounts-receivable agent for freelancers and small studios, built on **PayPal Invoicing** and **Claude**.

You can paste a messy client email, a timesheet or a one-line note ("bill Tom 6h at €60 for the logo"). Settle turns it into a clean PayPal invoice. It also tracks who owes you what and chases late payers, with reminders that get firmer the later a payment is. Anything that emails a client or moves money waits for your **Approve** click.

## Why

Freelancers lose hours every month writing invoices and awkward "just following up…" emails, and late payment is the norm. Settle takes care of the admin while you keep control.

## What it does

- **Paste → invoice.** Claude pulls out the client, email, line items (hours × rate or fixed fees), currency and due date. It then creates a PayPal **draft** invoice.
- **Human-in-the-loop sending.** Claude proposes actions (send, remind, record payment, cancel), and the UI shows an approval card. Nothing reaches a client until you approve it.
- **Smart chasing.** "Chase overdue" checks every invoice and drafts a reminder whose tone matches how late it is. The reminder goes out through PayPal's `/remind` endpoint.
- **Live receivables dashboard.** It shows Outstanding, Overdue and Collected, totalled per currency, straight from PayPal.
- **Off-PayPal payments.** If a client paid by bank transfer, Settle records it against the PayPal invoice.

## PayPal APIs used

| Purpose | Endpoint |
|---|---|
| Auth | `POST /v1/oauth2/token` |
| Invoice number | `POST /v2/invoicing/generate-next-invoice-number` |
| Create draft | `POST /v2/invoicing/invoices` |
| Send | `POST /v2/invoicing/invoices/{id}/send` |
| Remind | `POST /v2/invoicing/invoices/{id}/remind` |
| Record payment | `POST /v2/invoicing/invoices/{id}/payments` |
| Cancel / delete | `POST …/{id}/cancel`, `DELETE …/{id}` |
| List / get | `GET /v2/invoicing/invoices`, `GET …/{id}` |

## AI used

- **Claude** (Anthropic Messages API) with tool use: `list_invoices`, `get_invoice`, `create_invoice_draft` and `propose_action`.
- The agent can only *read* data and create *drafts* by itself. Every side effect goes through `propose_action`, which queues the action for the user's approval. That keeps the AI's room for mistakes small, which is what you want from an agent that touches money.
- Claude Code was used to help write this codebase.

## Architecture

```
Browser (public/index.html)
   │  chat / approve
   ▼
server.js  (plain Node http, zero dependencies)
   ├── agent.js   Claude tool loop + approval queue
   └── paypal.js  PayPal Invoicing v2 client (sandbox / live / offline mock)
```

## Run it

Requires Node 20+. There are no dependencies to install.

```bash
export PAYPAL_CLIENT_ID=...        # PayPal Developer → Apps & Credentials (Sandbox)
export PAYPAL_CLIENT_SECRET=...
export ANTHROPIC_API_KEY=...
npm start                           # http://localhost:3000
```

Without PayPal keys, the app runs on an in-memory **mock** with sample invoices, so judges can try the UI offline. Optional environment variables:

- `APP_PASSWORD`: password-protects a public deploy with a simple sign-in page (HTTP basic auth also works for scripts).
- `DEFAULT_CURRENCY`: default `USD`.
- `ANTHROPIC_MODEL`: the Claude model to use (default `claude-sonnet-5-5`).
- `PAYPAL_ENV=live`: switches from sandbox to live.

Run `npm test` for the offline end-to-end tests (mock PayPal plus a scripted agent).

## Deploy

The app is one click on Render with `render.yaml`. Set the environment variables in the dashboard.

## License

MIT
