// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const supabase = require('./supabase'); // attention : supabase doit être configuré (service_role key dans .env)
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// utilitaire sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/', (req, res) => {
  res.send('Bienvenue dans la belle API Anak Requests !');
});

// lister les demandes (dashboard)
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('Requests')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('GET /test-db error:', err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// POST /requests : génère request_id, insert, retry si conflit, retourne la ligne insérée
app.post('/requests', async (req, res) => {
  try {
    console.log('POST /requests body reçu:', req.body);

    // Lire et nettoyer les champs attendus
    const requestor_name = (req.body.requestor_name || '').toString().trim();
    const center_name = (req.body.center_name || '').toString().trim();
    const amount_requested_raw = req.body.amount_requested;
    const amount_requested = (amount_requested_raw === undefined || amount_requested_raw === null || amount_requested_raw === '') 
      ? NaN 
      : Number(amount_requested_raw);
    const description = (req.body.description || '').toString().trim();

    // Validation côté serveur
    const missing = [];
    if (!requestor_name) missing.push('requestor_name');
    if (!center_name) missing.push('center_name');
    if (!Number.isFinite(amount_requested) || amount_requested <= 0) missing.push('amount_requested (doit être > 0)');

    if (missing.length > 0) {
      console.warn('POST /requests - champs manquants:', missing);
      return res.status(400).json({ 
        error: 'Champs obligatoires manquants.', 
        missing, 
        received: req.body 
      });
    }

    // Génération du request_id au format REQ-YYYYMMDD-XXXX
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const datePrefix = `${yyyy}${mm}${dd}`; // ex: 20251111

    const maxRetries = 5;
    let attempt = 0;
    let insertedRow = null;

    while (attempt < maxRetries && !insertedRow) {
      attempt++;

      // Récupérer le dernier request_id pour aujourd'hui
      const { data: lastData, error: lastError } = await supabase
        .from('Requests')
        .select('request_id')
        .ilike('request_id', `REQ-${datePrefix}-%`)
        .order('request_id', { ascending: false })
        .limit(1);

      if (lastError) throw lastError;

      let seq = 1;
      if (lastData && lastData.length > 0) {
        const lastId = lastData[0].request_id; // ex: REQ-20251111-0003
        const parts = lastId.split('-');
        const lastSeq = parseInt(parts[2], 10);
        seq = lastSeq + 1;
      }

      const seqStr = String(seq).padStart(4, '0');
      const generatedRequestId = `REQ-${datePrefix}-${seqStr}`;
      console.log('Généré request_id:', generatedRequestId);

      // Tentative d'insertion
      const { data, error } = await supabase
        .from('Requests')
        .insert([{
          request_id: generatedRequestId,
          requestor_name,
          center_name,
          amount_requested,
          description,
          status: 'Pending',
          timestamp: new Date()
        }])
        .select('*');

      if (!error && data && data.length > 0) {
        insertedRow = data[0];
        break;
      }

      if (error) {
        console.warn(`Tentative ${attempt} insertion erreur:`, error);
        const isUniqueConflict =
          error.code === '23505' ||
          (error.message && error.message.toLowerCase().includes('duplicate')) ||
          (error.details && error.details.toLowerCase().includes('duplicate'));

        if (isUniqueConflict && attempt < maxRetries) {
          // Attente progressive avant retry
          await sleep(100 * attempt);
          continue;
        } else {
          throw error;
        }
      }
    }

    if (!insertedRow) {
      return res.status(500).json({ 
        error: 'Impossible d’insérer la demande après plusieurs tentatives.' 
      });
    }

    // Renvoyer la ligne insérée
    return res.status(201).json({ 
      message: 'Demande ajoutée avec succès', 
      data: insertedRow 
    });

  } catch (err) {
    console.error('POST /requests error:', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// Lancer le serveur
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});


//CODE POUR COTE ADMIN // CODE POUR COTE ADMIN ////CODE POUR COTE ADMIN // CODE POUR COTE ADMIN //

// Récupérer toutes les demandes (admin)
app.get('/admin/requests', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('Requests')
      .select('*')
      .order('timestamp', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Mettre à jour une demande (approve/reject + montant validé)
app.patch('/requests/:request_id', async (req, res) => {
  try {
    const { request_id } = req.params;
    const { status, approved_by, approved_amount } = req.body;

    // Vérifications simples
    if (!status || !approved_by) {
      return res.status(400).json({ error: 'Status et approved_by sont obligatoires.' });
    }

    const { data, error } = await supabase
      .from('Requests')
      .update({ status, approved_by, approved_amount })
      .eq('request_id', request_id)
      .select(); // récupère la ligne mise à jour

    if (error) throw error;
    if (data.length === 0) return res.status(404).json({ error: 'Request non trouvée.' });

    res.json({ message: 'Demande mise à jour avec succès', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les demandes avec filtre par statut et/ou centre
app.get('/requests', async (req, res) => {
  try {
    const { status, center_name } = req.query;

    let query = supabase.from('Requests').select('*');

    if (status) {
      query = query.eq('status', status);
    }
    if (center_name) {
      query = query.eq('center_name', center_name);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
