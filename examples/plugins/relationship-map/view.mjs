// This example deliberately uses the public wire protocol without an SDK.
const parentOrigin = new URL(document.referrer).origin, nonce = crypto.randomUUID();
const { connection, context } = await new Promise(resolve => {
  function receive(event) {
    if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'denova:bootstrap' || event.data.nonce !== nonce) return;
    window.removeEventListener('message', receive); resolve(event.data);
  }
  window.addEventListener('message', receive); parent.postMessage({ type: 'denova:ready', nonce }, parentOrigin);
});
let labels = {}, model = { format: 1, nodes: [], edges: [] }, revision = null, dirty = false, busy = false;
const status = document.querySelector('#status');
function state() { parent.postMessage({ type: 'denova:state', dirty, busy }, parentOrigin); }
async function request(path, options = {}) {
  const response = await fetch(connection.baseUrl + path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}`, 'X-Denova-Consumer': connection.consumerId } });
  const result = await response.json(); if (!response.ok) throw result; return result;
}
async function appearance() {
  labels = await (await fetch(`./locales/${context.locale}.json`)).json();
  document.documentElement.dataset.theme = context.theme; document.documentElement.lang = context.locale;
  for (const el of document.querySelectorAll('[data-label]')) el.textContent = labels[el.dataset.label]; render();
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'denova:appearance') return;
  context.locale = event.data.locale; context.theme = event.data.theme; void appearance();
});
function svg(tag, attributes, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  if (text) el.textContent = text; document.querySelector('#map').append(el);
}
function render() {
  document.querySelector('#map').replaceChildren(); document.querySelector('#nodes').replaceChildren();
  for (const id of ['from', 'to']) document.querySelector('#' + id).replaceChildren(...model.nodes.map(node => new Option(node.name, node.id)));
  const positions = new Map(model.nodes.map((node, i) => [node.id, [400 + 285 * Math.cos(i * 2 * Math.PI / model.nodes.length), 240 + 185 * Math.sin(i * 2 * Math.PI / model.nodes.length)]]));
  for (const edge of model.edges) {
    const from = positions.get(edge[0]), to = positions.get(edge[1]); if (!from || !to) continue;
    svg('line', { x1: from[0], y1: from[1], x2: to[0], y2: to[1], stroke: 'currentColor', opacity: '.4' });
  }
  for (const node of model.nodes) {
    const [x, y] = positions.get(node.id); svg('circle', { cx: x, cy: y, r: 9, fill: '#bc4040' });
    svg('text', { x, y: y - 16, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 16 }, node.name);
    const item = document.createElement('li'), name = document.createElement('span'), remove = document.createElement('button');
    name.textContent = node.name; remove.textContent = labels.remove;
    remove.onclick = () => { model.nodes = model.nodes.filter(n => n.id !== node.id); model.edges = model.edges.filter(e => !e.includes(node.id)); changed(); };
    item.append(name, remove); document.querySelector('#nodes').append(item);
  }
  document.querySelector('#map').setAttribute('aria-label', labels.title);
}
function changed() { dirty = true; state(); render(); }
async function perform(work) {
  if (busy) return; busy = true; state();
  for (const control of document.querySelectorAll('button,input,select')) control.disabled = true;
  try { await work(); status.textContent = model.nodes.length ? labels.done : labels.empty; }
  catch (error) { status.textContent = labels[error.code === 'DOCUMENT_CONFLICT' ? 'conflict' : error.code === 'UNSUPPORTED' ? 'formatError' : 'error']; console.error(error); }
  finally { busy = false; state(); render(); for (const control of document.querySelectorAll('button,input,select')) control.disabled = false; }
}
async function load() {
  let file;
  try { file = await request('/assets/document?path=relationships.json'); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  const next = file ? JSON.parse(file.content) : { format: 1, nodes: [], edges: [] };
  if (next.format !== 1 || !Array.isArray(next.nodes) || !Array.isArray(next.edges)) throw { code: 'UNSUPPORTED' };
  model = next; revision = file?.revision ?? null; dirty = false;
}
document.querySelector('#add').onsubmit = event => {
  event.preventDefault(); const input = document.querySelector('#name'); const name = input.value.trim();
  if (name && model.nodes.length < 100) { model.nodes.push({ id: crypto.randomUUID(), name }); input.value = ''; changed(); }
};
document.querySelector('#link').onsubmit = event => {
  event.preventDefault(); const edge = ['from', 'to'].map(id => document.querySelector('#' + id).value).sort();
  if (edge[0] && edge[0] !== edge[1] && !model.edges.some(e => e[0] === edge[0] && e[1] === edge[1])) { model.edges.push(edge); changed(); }
};
document.querySelector('#library').onclick = () => perform(async () => {
  const page = await request('/library/items?limit=100');
  for (const item of page.items) if (model.nodes.length < 100 && !model.nodes.some(node => node.id === item.id)) model.nodes.push({ id: item.id, name: item.name });
  dirty = true;
});
document.querySelector('#save').onclick = () => perform(async () => {
  const saved = await request('/assets/document', { method: 'PUT', body: JSON.stringify({ path: 'relationships.json', content: JSON.stringify(model), expectedRevision: revision }) });
  revision = saved.revision; dirty = false;
});
document.querySelector('#reload').onclick = () => { if (!dirty || confirm(labels.discard)) void perform(load); };
await appearance(); await perform(load);
