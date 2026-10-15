// Offline test: mock PayPal + a scripted fake LLM that issues the tool calls Claude would.
const assert = require('assert');
const agent = require('./agent');
const paypal = require('./paypal');

function scripted(steps) {
  let i = 0;
  return async () => steps[i++];
}
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });

(async () => {
  assert.equal(paypal.mode, 'mock');
  const before = (await paypal.list()).length;

  // 1) Paste email → draft → propose send
  let llm = scripted([
    { stop_reason: 'tool_use', content: [tu('t1', 'create_invoice_draft', {
      client_name: 'Freja Nordic', client_email: 'accounts@nordicknits.example', currency: 'EUR', due_date: '2026-10-29',
      items: [{ name: 'Theme fixes', quantity: 14, unit_price: 55, unit: 'HOURS' }, { name: 'App setup', quantity: 1, unit_price: 200 }] })] },
  ]);
  // second step needs the draft id, so build it dynamically
  const r1 = await agent.chat('bill Freja', { llm: async (h) => {
    if (h.length === 1) return (await llm());
    const res = JSON.parse(h.at(-1).content[0].content);
    if (res.id && res.status === 'DRAFT') return { stop_reason: 'tool_use', content: [tu('t2', 'propose_action', { action: 'send', id: res.id, summary: `Send €970 invoice to Freja` })] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Draft ready: €970.00. Approve to send.' }] };
  } });
  assert.equal(r1.trace.length, 2);
  assert.equal(r1.proposals.length, 1);
  const list1 = await paypal.list();
  assert.equal(list1.length, before + 1);
  const draft = list1.find(i => i.client === 'Freja Nordic');
  assert.equal(draft.total, '970.00');
  assert.equal(draft.status, 'DRAFT');

  // 2) Approve → SENT with pay link
  const sent = await agent.approve(r1.proposals[0].actionId);
  assert.equal(sent.status, 'SENT');
  assert.ok(sent.pay_link);
  await assert.rejects(agent.approve(r1.proposals[0].actionId)); // can't double-approve

  // 3) Overdue detection + reminder
  const overdue = (await paypal.list()).filter(i => i.overdue);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].client, 'Maria Lopez');
  const r3 = await agent.chat('chase overdue', { llm: scripted([
    { stop_reason: 'tool_use', content: [tu('t3', 'list_invoices', {})] },
    { stop_reason: 'tool_use', content: [tu('t4', 'propose_action', { action: 'remind', id: overdue[0].id, subject: 'Invoice 1001 overdue', note: 'Hi Maria…', summary: 'Remind Maria' })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'One overdue invoice; reminder ready.' }] },
  ]) });
  assert.equal(r3.proposals[0].action, 'remind');
  await agent.approve(r3.proposals[0].actionId);

  // 4) Bad tool input surfaces as an error to the model, not a crash
  const r4 = await agent.chat('get bogus', { llm: scripted([
    { stop_reason: 'tool_use', content: [tu('t5', 'get_invoice', { id: 'nope' })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Not found.' }] },
  ]) });
  assert.equal(r4.trace[0].ok, false);

  // 5) Record payment
  await paypal.recordPayment(overdue[0].id);
  assert.equal((await paypal.list()).filter(i => i.overdue).length, 0);

  console.log('All tests passed');
})().catch(e => { console.error(e); process.exit(1); });
