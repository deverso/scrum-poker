// Home page: create or join a room, then redirect to room.html?code=CODE.
function getClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) {
    id = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('clientId', id);
  }
  return id;
}

const nameInput = document.getElementById('name');
const codeInput = document.getElementById('code');
const errorEl = document.getElementById('error');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function saveName() {
  const name = nameInput.value.trim();
  if (!name) {
    showError('Digite seu nome primeiro.');
    return null;
  }
  localStorage.setItem('name', name);
  return name;
}

// Prefill name and code from storage / URL.
nameInput.value = localStorage.getItem('name') || '';
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeInput.value = urlCode;

document.getElementById('create').addEventListener('click', async () => {
  if (!saveName()) return;
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId() }),
  });
  if (!res.ok) return showError('Não foi possível criar a sala.');
  const { code } = await res.json();
  location.href = `room.html?code=${encodeURIComponent(code)}`;
});

document.getElementById('join').addEventListener('click', () => {
  if (!saveName()) return;
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return showError('Digite o código da sala.');
  location.href = `room.html?code=${encodeURIComponent(code)}`;
});
