// Vérifier connexion
const token = localStorage.getItem('access_token');
if (!token) window.location.href = 'login.html';

// Logout
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('access_token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
});

// Switch onglets
document.getElementById('tabSubmit').addEventListener('click', () => {
  document.getElementById('submitSection').style.display = '';
  document.getElementById('myRequestsSection').style.display = 'none';
});
document.getElementById('tabMyRequests').addEventListener('click', () => {
  document.getElementById('submitSection').style.display = 'none';
  document.getElementById('myRequestsSection').style.display = '';
  loadMyRequests();
});

// Soumettre une demande
document.getElementById('requestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const requestor_name = document.getElementById('requestorName').value.trim();
  const amount_requested = parseFloat(document.getElementById('amountRequested').value);
  const description = document.getElementById('requestDescription').value.trim();

  if (!requestor_name || !amount_requested) {
    alert('Nom et montant obligatoires');
    return;
  }

  try {
    const res = await fetch('http://localhost:3000/requests', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ requestor_name, amount_requested, description })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');

    alert('✅ Demande soumise !');
    document.getElementById('requestForm').reset();
    loadMyRequests();
  } catch (err) {
    alert('❌ ' + err.message);
  }
});

// Charger mes demandes
async function loadMyRequests() {
  const tbody = document.querySelector('#myRequestsTable tbody');
  tbody.innerHTML = '';

  try {
    const res = await fetch('http://localhost:3000/requests', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');

    data.forEach(req => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${req.request_id}</td>
        <td>${new Date(req.timestamp).toLocaleDateString()}</td>
        <td>${req.amount_requested}</td>
        <td>${req.status}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    alert('❌ ' + err.message);
  }
}
