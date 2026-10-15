// Claude tool-calling agent. Read-only + draft tools run immediately;
// anything that emails a client or moves money is queued for the user's approval.
const paypal = require('./paypal');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const today = () => new Date().toISOString().slice(0, 10);

const SYSTEM = () => `You are Settle, an accounts-receivable assistant for freelancers and small studios.
You manage the user's PayPal invoices: turn messy client messages, emails or job notes into clean invoices, chase late payers politely, and answer "who owes me what?".
Today is ${today()}. The user's business currency defaults to ${process.env.DEFAULT_CURRENCY || 'USD'} unless they say otherwise.

Rules:
- Extract client name, email, line items (hours × rate or fixed fees), currency and due date from whatever the user pastes. If the client email is missing, ask for it — never invent emails.
- Default due date: 14 days from today unless stated.
- Always create invoices as DRAFTS first with create_invoice_draft, then call propose_action to send. Sending, reminding, recording payments and cancelling only happen after the user clicks Approve — say so briefly.
- For reminders, write the note yourself: friendly at 1–7 days late, firmer at 8–30, formal past 30 (mention the invoice number, amount, original due date and the pay link). Keep notes under 80 words.
- Be concise. Use short sentences and amounts with currency. No markdown tables.`;

const TOOLS = [
  {
    name: 'list_invoices',
    description: 'List all invoices with status, client, totals, due dates and an overdue flag.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_invoice',
    description: 'Get one invoice by id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_invoice_draft',
    description: 'Create a DRAFT PayPal invoice (not sent to the client).',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        client_email: { type: 'string' },
        currency: { type: 'string', description: 'ISO code, e.g. USD, EUR, GBP' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        note: { type: 'string', description: 'Short note shown on the invoice' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              unit: { type: 'string', enum: ['QUANTITY', 'HOURS'] },
            },
            required: ['name', 'quantity', 'unit_price'],
          },
        },
      },
      required: ['client_name', 'client_email', 'items'],
    },
  },
  {
    name: 'propose_action',
    description: 'Queue an action that needs the user\'s approval: send an invoice, send a payment reminder (with your drafted subject+note), record an off-PayPal payment, or cancel.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'remind', 'record_payment', 'cancel'] },
        id: { type: 'string', description: 'Invoice id' },
        subject: { type: 'string', description: 'Reminder subject (remind only)' },
        note: { type: 'string', description: 'Reminder message (remind only)' },
        summary: { type: 'string', description: 'One line describing what will happen, for the approval card' },
      },
      required: ['action', 'id', 'summary'],
    },
  },
];

const pending = new Map();   // actionId -> action (tagged with the session that proposed it)
let actionSeq = 0;

async function runTool(name, input, session) {
  switch (name) {
    case 'list_invoices': return await paypal.list();
    case 'get_invoice': return await paypal.get(input.id);
    case 'create_invoice_draft': return await paypal.createDraft(input);
    case 'propose_action': {
      const actionId = `a${++actionSeq}`;
      const act = { actionId, session, ...input };
      pending.set(actionId, act);
      return { queued: true, actionId, note: 'Waiting for the user to click Approve.' };
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

async function approve(actionId, session = 'default') {
  const a = pending.get(actionId);
  if (!a || a.session !== session) throw new Error('That action has already been handled.');
  pending.delete(actionId);
  switch (a.action) {
    case 'send': return paypal.send(a.id);
    case 'remind': return paypal.remind(a.id, a.subject || 'Payment reminder', a.note || '');
    case 'record_payment': return paypal.recordPayment(a.id);
    case 'cancel': return paypal.cancel(a.id);
  }
}
function reject(actionId, session = 'default') { const a = pending.get(actionId); if (a && a.session === session) pending.delete(actionId); }

async function callClaude(messages) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM(), tools: TOOLS, messages }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  return r.json();
}

// One conversation per browser session, so several people can use a shared demo at once.
const sessions = new Map();   // session id -> { history, last }
function getHistory(session) {
  let s = sessions.get(session);
  if (!s) {
    if (sessions.size > 200) { // drop the oldest idle conversation
      const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0][0];
      sessions.delete(oldest);
    }
    s = { history: [] }; sessions.set(session, s);
  }
  s.last = Date.now();
  return s;
}

async function chat(userText, { llm = callClaude, session = 'default' } = {}) {
  const s = getHistory(session);
  const history = s.history;
  history.push({ role: 'user', content: userText });
  const trace = [];      // tool calls made this turn, for the UI
  const proposals = [];
  for (let step = 0; step < 8; step++) {
    const res = await llm(history);
    history.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter(c => c.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      trimHistory(s);
      return { reply: text, trace, proposals };
    }
    const results = [];
    for (const c of calls) {
      let out, is_error = false;
      try { out = await runTool(c.name, c.input, session); }
      catch (e) { out = { error: e.message }; is_error = true; }
      trace.push({ tool: c.name, input: c.input, ok: !is_error });
      if (c.name === 'propose_action' && !is_error) proposals.push(pending.get(out.actionId));
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out), is_error });
    }
    history.push({ role: 'user', content: results });
  }
  return { reply: 'I hit my step limit — try a smaller request.', trace, proposals };
}

// Keep context bounded; only cut at a plain user text turn so tool pairs stay intact.
function trimHistory(s) {
  const h = s.history;
  if (h.length <= 40) return;
  const idx = h.findIndex((m, i) => i >= h.length - 30 && m.role === 'user' && typeof m.content === 'string');
  if (idx > 0) s.history = h.slice(idx);
}
function reset(session = 'default') {
  sessions.delete(session);
  for (const [id, a] of pending) if (a.session === session) pending.delete(id);
}

module.exports = { chat, approve, reject, reset, pendingList: (session = 'default') => [...pending.values()].filter(a => a.session === session) };
