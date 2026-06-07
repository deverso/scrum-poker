// Read-only history for a room code. Works even after the live room expired.
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
const listEl = document.getElementById('list');
const errorEl = document.getElementById('error');
document.getElementById('code').textContent = code || '—';

let estimates = [];

function fmtDate(ms) {
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function render() {
  listEl.innerHTML = '';
  if (estimates.length === 0) {
    listEl.innerHTML = '<p class="hist-empty">Nenhuma estimativa registrada para este código.</p>';
    return;
  }
  for (const e of estimates) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const val = document.createElement('span');
    val.className = 'hist-value';
    val.textContent = e.finalValue;
    const title = document.createElement('span');
    title.className = 'hist-title';
    title.textContent = e.storyTitle || '(sem título)';
    const when = document.createElement('span');
    when.className = 'hist-when';
    when.textContent = fmtDate(e.createdAt);
    row.append(val, title, when);
    listEl.appendChild(row);
  }
}

document.getElementById('exportCsv').addEventListener('click', () => {
  const rows = [['historia', 'valor_final', 'consenso', 'media', 'votantes', 'data']];
  for (const e of estimates) {
    rows.push([e.storyTitle || '', e.finalValue, e.consensus || '', e.average ?? '', e.voterCount, new Date(e.createdAt).toISOString()]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(csv).then(() => {
      const b = document.getElementById('exportCsv');
      b.textContent = 'CSV copiado!';
      setTimeout(() => (b.textContent = 'copiar CSV'), 1500);
    });
  }
});

async function load() {
  if (!code) {
    errorEl.textContent = 'Código não informado na URL (?code=...).';
    errorEl.hidden = false;
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/estimates`);
    if (!res.ok) throw new Error('falha ao carregar');
    const data = await res.json();
    estimates = data.estimates || [];
    render();
  } catch {
    errorEl.textContent = 'Não foi possível carregar o histórico.';
    errorEl.hidden = false;
  }
}

load();
