// PayPal Invoicing v2 client, with an in-memory mock for offline development.
const LIVE = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let token = null, tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal auth failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}

async function pp(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const msg = data.details?.map(d => `${d.field || ''} ${d.description || d.issue}`).join('; ') || data.message || text;
    throw new Error(`PayPal ${method} ${path} → ${r.status}: ${msg}`);
  }
  return data;
}

// ---------- shared helpers ----------
// PayPal rejects decimals for zero-decimal currencies (e.g. JPY).
const ZERO_DECIMAL = ['HUF', 'JPY', 'TWD'];
const money = (v, c) => ({ currency_code: c, value: Number(v).toFixed(ZERO_DECIMAL.includes(String(c).toUpperCase()) ? 0 : 2) });

function buildInvoice({ client_name, client_email, items, currency = process.env.DEFAULT_CURRENCY || 'USD', due_date, note, invoice_number }) {
  const [given, ...rest] = String(client_name || 'Client').split(' ');
  return {
    detail: {
      invoice_number,
      currency_code: (currency = String(currency).toUpperCase()),
      invoice_date: new Date().toISOString().slice(0, 10),
      note: note || undefined,
      payment_term: due_date
        ? { term_type: 'DUE_ON_DATE_SPECIFIED', due_date }
        : { term_type: 'NET_30' },
    },
    primary_recipients: [{
      billing_info: { name: { given_name: given, surname: rest.join(' ') || undefined }, email_address: client_email },
    }],
    items: items.map(i => ({
      name: i.name,
      description: i.description || undefined,
      quantity: String(i.quantity ?? 1),
      unit_amount: money(i.unit_price, currency),
      unit_of_measure: i.unit === 'HOURS' ? 'HOURS' : 'QUANTITY',
    })),
  };
}

// Normalised shape the UI and agent use.
function summarize(inv) {
  const d = inv.detail || {};
  const r = inv.primary_recipients?.[0]?.billing_info || {};
  const total = inv.amount?.value ?? inv.amount?.breakdown?.item_total?.value
    ?? (inv.items || []).reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
  const due = d.payment_term?.due_date || null;
  const status = inv.status;
  const open = ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING'].includes(status);
  return {
    id: inv.id,
    number: d.invoice_number,
    status,
    client: [r.name?.given_name, r.name?.surname].filter(Boolean).join(' ') || r.email_address,
    email: r.email_address,
    total: Number(total).toFixed(2),
    currency: d.currency_code || inv.amount?.currency_code || 'USD',
    issued: d.invoice_date,
    due,
    overdue: open && due ? new Date(due) < new Date(new Date().toISOString().slice(0, 10)) : false,
    items: (inv.items || []).map(i => `${i.quantity} × ${i.name} @ ${i.unit_amount.value}`),
    pay_link: d.metadata?.recipient_view_url || inv.detail?.metadata?.recipient_view_url || null,
  };
}

// ---------- live implementation ----------
const live = {
  async createDraft(args) {
    const { invoice_number } = await pp('POST', '/v2/invoicing/generate-next-invoice-number');
    const inv = await pp('POST', '/v2/invoicing/invoices', buildInvoice({ ...args, invoice_number }));
    // Some responses only return a link; fetch the full object if needed.
    const full = inv.id ? inv : await pp('GET', new URL(inv.href).pathname);
    return summarize(full);
  },
  async send(id) {
    await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: true });
    return summarize(await pp('GET', `/v2/invoicing/invoices/${id}`));
  },
  async remind(id, subject, note) {
    await pp('POST', `/v2/invoicing/invoices/${id}/remind`, { subject, note, send_to_recipient: true, send_to_invoicer: false });
    return summarize(await pp('GET', `/v2/invoicing/invoices/${id}`));
  },
  async recordPayment(id, method = 'BANK_TRANSFER') {
    const inv = await pp('GET', `/v2/invoicing/invoices/${id}`);
    await pp('POST', `/v2/invoicing/invoices/${id}/payments`, {
      method, payment_date: new Date().toISOString().slice(0, 10),
      amount: inv.due_amount || inv.amount,
    });
    return summarize(await pp('GET', `/v2/invoicing/invoices/${id}`));
  },
  async cancel(id) {
    const inv = await pp('GET', `/v2/invoicing/invoices/${id}`);
    if (inv.status === 'DRAFT') { await pp('DELETE', `/v2/invoicing/invoices/${id}`); return { id, status: 'DELETED' }; }
    await pp('POST', `/v2/invoicing/invoices/${id}/cancel`, { send_to_recipient: true, send_to_invoicer: false });
    return summarize(await pp('GET', `/v2/invoicing/invoices/${id}`));
  },
  async get(id) { return summarize(await pp('GET', `/v2/invoicing/invoices/${id}`)); },
  async list() {
    const j = await pp('GET', '/v2/invoicing/invoices?page=1&page_size=100&total_required=true');
    return (j.items || []).map(summarize);
  },
};

// ---------- mock implementation (no credentials) ----------
const store = new Map();
let seq = 1000;
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => iso(new Date(Date.now() - n * 864e5));

function mockSeed() {
  const add = (args, status, issuedAgo) => {
    const inv = buildInvoice({ ...args, invoice_number: String(++seq) });
    inv.id = `INV2-MOCK-${seq}`;
    inv.status = status;
    inv.detail.invoice_date = daysAgo(issuedAgo);
    store.set(inv.id, inv);
  };
  add({ client_name: 'Maria Lopez', client_email: 'maria@lopezbakery.example', items: [{ name: 'Website redesign', quantity: 1, unit_price: 1200 }], due_date: daysAgo(12) }, 'SENT', 42);
  add({ client_name: 'Tom Becker', client_email: 'tom@beckerlegal.example', items: [{ name: 'Logo design', quantity: 1, unit_price: 450 }], due_date: daysAgo(-10) }, 'SENT', 5);
  add({ client_name: 'Aisha Khan', client_email: 'aisha@studiok.example', items: [{ name: 'Landing page copy', quantity: 6, unit_price: 60, unit: 'HOURS' }], due_date: daysAgo(20) }, 'PAID', 35);
}

const mock = {
  async createDraft(args) {
    const inv = buildInvoice({ ...args, invoice_number: String(++seq) });
    inv.id = `INV2-MOCK-${seq}`; inv.status = 'DRAFT';
    store.set(inv.id, inv); return summarize(inv);
  },
  async send(id) { const i = must(id); i.status = 'SENT'; i.detail.metadata = { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` }; return summarize(i); },
  async remind(id) { const i = must(id); if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status)) throw new Error(`Can't remind a ${i.status} invoice`); i.reminders = (i.reminders || 0) + 1; return summarize(i); },
  async recordPayment(id) { const i = must(id); i.status = 'MARKED_AS_PAID'; return summarize(i); },
  async cancel(id) { const i = must(id); if (i.status === 'DRAFT') { store.delete(id); return { id, status: 'DELETED' }; } i.status = 'CANCELLED'; return summarize(i); },
  async get(id) { return summarize(must(id)); },
  async list() { return [...store.values()].map(summarize).reverse(); },
};
function must(id) { const i = store.get(id); if (!i) throw new Error(`No invoice ${id}`); return i; }

if (!LIVE) mockSeed();

module.exports = { ...(LIVE ? live : mock), LIVE, mode: LIVE ? (process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox') : 'mock' };
