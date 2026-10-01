import { connect } from './client.mjs';
const client = await connect(), $ = selector => document.querySelector(selector);
let labels = {}, board = { format: 1, cards: [] }, revision = null, capabilities, active = null, result = '', dirty = false;
let libraryDraft = null;
const blobs = new Set();
const post = (path, body) => client.request(path, { method: 'POST', body: JSON.stringify(body) });
const allowed = name => { const state = capabilities?.capabilities[name]; return state && Object.values(state).every(Boolean); };
function state() {
  client.setState({ busy: !!active, dirty });
  $('#cancel').hidden = !active; $('#assistant').disabled = !!active || !allowed('agents.run'); $('#image').disabled = !!active || !allowed('images.generate');
  $('#keep').disabled = !!active || !result; $('#library').disabled = !!active || !result || !allowed('library.write'); $('#upload').disabled = !!active;
  $('#refresh').disabled = !!active;
  $('#availability').textContent = labels[allowed('agents.run') && allowed('images.generate') ? 'ready' : 'configure'];
}
async function appearance() {
  labels = await (await fetch(`./locales/${client.context.locale}.json`)).json();
  document.documentElement.dataset.theme = client.context.theme; document.documentElement.lang = client.context.locale;
  for (const el of document.querySelectorAll('[data-label]')) el.textContent = labels[el.dataset.label]; state();
}
await appearance(); window.addEventListener('denova:appearance', () => void appearance());
function showError(error) { console.error(error); $('#status').textContent = labels[error.code === 'DOCUMENT_CONFLICT' ? 'conflict' : error.code === 'UNSUPPORTED' ? 'formatError' : 'error']; }
async function render() {
  for (const url of blobs) URL.revokeObjectURL(url); blobs.clear(); $('#board').replaceChildren();
  for (const card of board.cards) {
    const article = document.createElement('article'), text = document.createElement('p'); text.textContent = card.text; article.append(text); $('#board').append(article);
    if (card.asset) {
      const response = await client.request(`/assets/content?kind=${card.asset.kind}&path=${encodeURIComponent(card.asset.path)}`, { responseType: 'stream' });
      const blob = await response.blob(), url = URL.createObjectURL(blob); blobs.add(url);
      const media = document.createElement(blob.type.startsWith('audio/') ? 'audio' : 'img'); media.src = url; media.alt = card.text; media.controls = true; article.append(media);
    }
  }
}
async function load() {
  capabilities = await client.request('/capabilities'); state();
  let file;
  try { file = await client.request('/assets/document?path=board.json'); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  const next = file ? JSON.parse(file.content) : { format: 1, cards: [] };
  if (next.format !== 1 || !Array.isArray(next.cards)) throw { code: 'UNSUPPORTED' };
  board = next; revision = file?.revision ?? null; dirty = false; await render(); state();
}
async function saveCard(card) {
  const next = { ...board, cards: [...board.cards, card] }; dirty = true; state();
  const saved = await client.request('/assets/document', { method: 'PUT', body: JSON.stringify({ path: 'board.json', content: JSON.stringify(next), expectedRevision: revision }) });
  board = next; revision = saved.revision; dirty = false; state(); await render();
}
async function run(work) {
  if (active) return; active = { cancel: null }; state(); $('#status').textContent = labels.running;
  try { await work(); $('#status').textContent = labels.done; }
  catch (error) { showError(error); }
  finally { active = null; state(); }
}
$('#refresh').onclick = () => { if (!dirty || confirm(labels.discard)) void run(load); };
$('#cancel').onclick = async () => { if (active?.cancel) { try { await post(active.cancel, {}); } catch (error) { showError(error); } } };
$('#image').onclick = () => run(async () => {
  const id = crypto.randomUUID(); active.cancel = `/images/generations/${id}/cancel`;
  let image = await post('/images/generations', { commandId: id, modelSlot: 'illustrator', prompt: $('#prompt').value });
  while (image.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 500)); image = await client.request(`/images/generations/${id}`);
  }
  if (image.status !== 'completed') { $('#result').textContent = labels[image.status] ?? labels.error; return; }
  for (const generated of image.images) {
    const response = await client.request(`/assets/content?kind=${generated.asset.kind}&path=${encodeURIComponent(generated.asset.path)}`, { responseType: 'stream' });
    const stored = await client.request('/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await response.blob() });
    await saveCard({ id: crypto.randomUUID(), text: $('#prompt').value, asset: stored.asset });
  }
});
function questions(interaction, runId) {
  if (interaction.kind !== 'ask') return;
  const form = $('#questions'); form.replaceChildren(); form.hidden = false;
  for (const question of interaction.questions) {
    const label = document.createElement('label'); label.textContent = question.prompt;
    const input = document.createElement(question.options?.length ? 'select' : 'input'); input.name = question.id;
    if (question.options?.length) { input.multiple = !!question.multiple; for (const option of question.options) input.append(new Option(option.label, option.value)); }
    label.append(input); form.append(label);
  }
  const button = document.createElement('button'); button.textContent = labels.answer; form.append(button);
  form.onsubmit = async event => {
    event.preventDefault(); button.disabled = true;
    try {
      const answers = interaction.questions.map(question => {
        const input = form.elements.namedItem(question.id);
        return question.options?.length ? { question_id: question.id, values: [...input.selectedOptions].map(o => o.value) } : { question_id: question.id, text: input.value };
      });
      await post(`/agents/runs/${runId}/interactions/${interaction.id}/responses`, { answers }); form.hidden = true;
    } catch (error) { showError(error); } finally { button.disabled = false; }
  };
}
$('#assistant').onclick = () => run(async () => {
  const session = await post('/agents/sessions', { projectId: client.context.scope.projectId, definition: 'builtin/assistant', key: `board-${crypto.randomUUID()}` });
  const started = await post(`/agents/sessions/${session.ref.sessionId}/runs`, { commandId: crypto.randomUUID(), input: { text: $('#prompt').value } });
  const runId = started.run.runId; active.cancel = `/agents/runs/${runId}/cancel`; result = ''; libraryDraft = null;
  const response = await client.request(`/agents/runs/${runId}/events`, { responseType: 'stream' });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += chunk.value.replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const kind = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const raw = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'); if (!raw) continue;
        const data = JSON.parse(raw);
        if (kind === 'delta') result += data.delta;
        if (kind === 'snapshot') result = data.snapshot.text;
        if (kind === 'result') result = data.text;
        if (kind === 'interaction') questions(data, runId);
        $('#result').textContent = result;
      }
    }
    const final = await client.request(`/agents/runs/${runId}`); result = final.text; $('#result').textContent = result || labels[final.status] || labels.error;
  } finally { reader.releaseLock(); $('#questions').hidden = true; }
});
$('#keep').onclick = () => run(() => saveCard({ id: crypto.randomUUID(), text: result }));
$('#library').onclick = () => run(async () => {
  // Keep the ID stable across a retry of an uncertain library write.
  libraryDraft ??= { id: crypto.randomUUID(), name: $('#prompt').value.slice(0, 120) || labels.title, type: 'other', tags: [], briefDescription: '', enabled: true, content: result };
  await post('/library/items', { item: libraryDraft });
});
$('#upload').onchange = () => run(async () => {
  const file = $('#upload').files[0]; if (!file) return;
  const stored = await client.request('/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  await saveCard({ id: crypto.randomUUID(), text: file.name, asset: stored.asset }); $('#upload').value = '';
});
await run(load);
