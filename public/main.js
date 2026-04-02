// ---- const API_URL = 'http://localhost:3000';
const API_URL = 'http://192.168.254.145:3000';

// --- UTILITAIRES ---
function setToken(token) {
    localStorage.setItem('access_token', token);
}

function getToken() {
    return localStorage.getItem('access_token');
}

function apiHeaders() {
    const token = getToken();
    return token
        ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        : { 'Content-Type': 'application/json' };
}

// Affichage notifications
function notify(message, type = 'info') {
    const container = document.querySelector('#notificationContainer');
    if (!container) return;

    const note = document.createElement('div');
    note.className = `notification ${type}`;
    note.textContent = message;
    container.appendChild(note);

    setTimeout(() => note.remove(), 4000);
}

// Affichage loader
function showLoader(show = true) {
    const loader = document.querySelector('#loader');
    if (!loader) return;
    loader.style.display = show ? 'block' : 'none';
}

// --- LOGIN ---
async function login(event) {
    event.preventDefault();

    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value.trim();

    if (!email || !password) {
        notify('Email et mot de passe requis', 'error');
        return;
    }

    try {
        showLoader(true);
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        showLoader(false);

        if (!res.ok) {
            notify(data.error || 'Erreur connexion', 'error');
            return;
        }

        setToken(data.access_token);
        notify('Connexion réussie !', 'success');
        setTimeout(() => window.location.href = 'index.html', 800);
    } catch (err) {
        showLoader(false);
        console.error('Login error', err);
        notify('Erreur serveur', 'error');
    }
}

// --- SOUMISSION DEMANDE ---
async function submitRequest(event) {
  event.preventDefault();

  const requestor_name = document.querySelector('#requestor_name').value.trim();
  const amount_requested = Number(document.querySelector('#amount_requested').value);
  const description = document.querySelector('#description').value.trim();

  if (!requestor_name || isNaN(amount_requested) || amount_requested <= 0 || !description) {
    notify('Tous les champs sont obligatoires et le montant doit être > 0', 'error');
    return;
  }

  try {
    showLoader(true);

    const res = await fetch(`${API_URL}/requests`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ requestor_name, amount_requested, description })
    });

    // 🔒 Token invalide / expiré
    if (res.status === 401) {
          showLoader(false); // 👈 ici
      localStorage.removeItem('access_token');
      window.location.href = 'login.html';
      return;
    }

    const data = await res.json();
    showLoader(false);

    if (!res.ok) {
      notify(data.error || 'Erreur lors de l’ajout', 'error');
      return;
    }

    notify('Demande ajoutée avec succès !', 'success');
    document.querySelector('#requestForm').reset();
    loadMyRequests();

  } catch (err) {
    showLoader(false);
    console.error('Submit request error', err);
    notify('Erreur serveur', 'error');
  }
}


// --- CHARGER MES DEMANDES ---
async function loadMyRequests() {
  try {
    showLoader(true);

    const res = await fetch(`${API_URL}/requests`, {
      headers: apiHeaders()
    });

    // 🔒 Token invalide / expiré
    if (res.status === 401) {
      showLoader(false); // 👈 ici
      localStorage.removeItem('access_token');
      window.location.href = 'login.html';
      return;
    }

    const data = await res.json();
    showLoader(false);

    if (!res.ok) {
      notify(data.error || 'Impossible de charger vos demandes', 'error');
      return;
    }

    const tableBody = document.querySelector('#requestsTable tbody');
    tableBody.innerHTML = '';

    data.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.request_id}</td>
        <td>${r.requestor_name}</td>
        <td>${r.amount_requested}</td>
        <td>${r.status}</td>
        <td>${new Date(r.timestamp).toLocaleString()}</td>
      `;
      tableBody.appendChild(tr);
    });

  } catch (err) {
    showLoader(false);
    console.error('Load requests error', err);
    notify('Erreur serveur', 'error');
  }
}

// --- VERIFIER TOKEN + REDIRECTION ---
function requireLogin() {
  if (!getToken()) {
    window.location.href = 'login.html';
  }
}

// --- EVENTS ---
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.querySelector('#loginForm');
  if (loginForm) loginForm.addEventListener('submit', login);

  const requestForm = document.querySelector('#requestForm');
  if (requestForm) requestForm.addEventListener('submit', submitRequest);

  const requestsTable = document.querySelector('#requestsTable');
  if (requestsTable) {
    requireLogin();
    loadMyRequests();
  }
});
