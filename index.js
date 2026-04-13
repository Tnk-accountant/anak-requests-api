require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const cookieParser = require('cookie-parser'); //
const { supabaseAuth, supabaseService } = require('./supabase');


// ✅ api drive
const { uploadToYearCenterMonth } = require('./drive');
const DRIVE_PARENT_ID = '0AEg5ur7DTXwJUk9PVA'; // dossier Anak Requests sur drive



// Pour stocker les connexions SSE des admins
let sseClients = [];

const app = express();
const PORT = process.env.PORT || 3000;

// ======= CORS - configuration (dev only) =========
const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://anak-requests-api.onrender.com'
];

const corsOptions = {
  origin: function(origin, callback) {
    // Autorise requêtes sans origin (curl, file:// -> origin === null)
    if (!origin) return callback(null, true);
    // Autorise explicitement la valeur 'null' (si le navigateur envoie 'null')
    if (origin === 'null') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Bloquer les autres origines (en dev on loggue l'origine)
    console.warn('CORS blocage origine:', origin);
    return callback(new Error('Origin non autorisée par CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200 // certains clients attendent 200 pour OPTIONS
};

// Appliquer CORS globalement
app.use(cors(corsOptions));
app.use(cookieParser());

// 🔥 IMPORTANT : limite payload (évite crash upload)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Multer pour upload temporaire
const upload = multer({ dest: '/tmp/uploads/' });

// ==============================
// AUTH + LOGIN + REFRESH CLEAN
// ==============================

const path = require('path');

app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ==============================
// 🔐 AUTH UTIL
// ==============================
async function getUserFromAuthHeader(req) {
  let token = null;

  if (req.cookies?.access_token) {
    token = req.cookies.access_token;
  } else if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) return null;

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (e) {
    console.error('getUser error:', e);
    return null;
  }
}

// ==============================
// 🔐 MIDDLEWARE AUTH
// ==============================
async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.access_token;

    if (!token) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const { data, error } = await supabaseAuth.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }

    const user = data.user;

    const { data: profile, error: profErr } = await supabaseService
      .from('profiles')
      .select('role, center_name, center_id, mail, "Name"')
      .eq('id', user.id)
      .maybeSingle();

    if (profErr) {
      return res.status(500).json({ error: 'Erreur récupération profil' });
    }

    if (!profile) {
      return res.status(403).json({ error: 'Profil introuvable' });
    }

    req.user = user;
    req.profile = {
      userId: user.id,
      role: profile.role,
      center: (profile.center_name || '').trim().toUpperCase(),
      center_id: profile.center_id,
      name: profile.Name,
      email: profile.mail
    };

    next();

  } catch (err) {
    console.error('authenticate error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ==============================
// 🔐 LOGIN
// ==============================
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data?.session) {
      return res.status(401).json({ error: 'Échec de l’authentification' });
    }

    const user = data.user;
    const session = data.session;

    const { data: profile } = await supabaseService
      .from('profiles')
      .select('role, center_name')
      .eq('id', user.id)
      .maybeSingle();

    // 🔥 ACCESS TOKEN (court)
    res.cookie('access_token', session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 // 1 jour
    });

    // 🔥 REFRESH TOKEN (long)
    res.cookie('refresh_token', session.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 jours
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: profile?.role || 'Utilisateur',
        center_name: profile?.center_name || null
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==============================
// 🔁 REFRESH TOKEN
// ==============================
app.post('/refresh', async (req, res) => {
  try {
    const refresh_token = req.cookies?.refresh_token;

    if (!refresh_token) {
      return res.status(401).json({ error: 'No refresh token' });
    }

    const { data, error } = await supabaseAuth.auth.refreshSession({
      refresh_token
    });

    if (error || !data?.session) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const session = data.session;

    // 🔁 nouveaux cookies
    res.cookie('access_token', session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24
    });

    res.cookie('refresh_token', session.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 7
    });

    res.json({ success: true });

  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==============================
// 👤 PROFILE
// ==============================
app.get('/profile', authenticate, async (req, res) => {
  try {
    res.json({
      id: req.user.id,
      email: req.user.email,
      role: req.profile.role,
      center_name: req.profile.center
    });
  } catch (err) {
    console.error('GET /profile error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});



/* =========================================
   ROUTES PUBLIQUES
========================================= */

// Racine
app.get('/', (req, res) => {
  res.send('Welcome in the beautiful API Anak Requests !');
});


// =====================
// GET CENTERS
// =====================
app.get('/centers', async (req, res) => {
  try {
    const { data, error } = await supabaseService
      .from('centers')
      .select('id, code, name')
      .order('code');

    if (error) {
      console.error('GET /centers error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('GET /centers catch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================
// GET REQUESTS (PAGINATED)
// =====================
app.get('/requests', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    console.log(
      '🔹 GET /requests | role=', req.profile.role,
      '| center=', req.profile.center,
      '| status=', req.query.status || 'none',
      '| limit=', limit,
      '| offset=', offset
    );

    let query = supabaseService
      .from('Requests')
      .select('*', { count: 'exact' })
      .order('timestamp', { ascending: false })
      .range(offset, offset + limit - 1);

    // 🔥 LOGIQUE MULTI-CENTRES CORRIGÉE

    if (req.profile.role === 'Admin') {
      // voit tout
    }
    else if (req.profile.role === 'Purchaser') {
      query = query.or(
        `created_by.eq.${req.user.id},status.eq.Approved`
      );
    }
    else if (req.profile.role === 'ChefCentre' || req.profile.role === 'Chef de centre') {

      const userCenters = req.profile.center.split(',').map(c => c.trim());

      // convertir centers → IDs
      const { data: centersData } = await supabaseService
        .from('centers')
        .select('id, code')
        .in('code', userCenters);

      const centerIds = centersData.map(c => c.id);

      // construire filtre dynamique
      const centerFilters = centerIds.map(id => `center_id.eq.${id}`).join(',');

      query = query.or(`
        created_by.eq.${req.user.id},
        and(or(${centerFilters}),visibility_scope.eq.CENTER)
      `);
    }
    else {
      // utilisateur normal
      query = query.eq('created_by', req.user.id);
    }

    // filtre status optionnel
    if (req.query.status) {
      query = query.eq('status', req.query.status);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({
      data: data || [],
      pagination: {
        limit,
        offset,
        total: count || 0,
        hasMore: offset + limit < (count || 0)
      }
    });

  } catch (err) {
    console.error('GET /requests error:', err);
    return res.status(500).json({ error: err.message });
  }
});


// =====================
// TEST BASE DE DONNÉES
// =====================
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabaseService
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

// =========================================
// SSE : stream temps réel (COOKIE AUTH)
// =========================================
app.get('/requests/stream', async (req, res) => {
  try {
    // 🔐 Lire le token depuis le cookie
    const token = req.cookies?.access_token;

    if (!token) {
      console.warn('❌ SSE: cookie manquant');
      return res.status(401).end();
    }

    // 🔎 Vérifier utilisateur via Supabase
    const { data, error } = await supabaseAuth.auth.getUser(token);

    if (error || !data?.user) {
      console.warn('❌ SSE: token invalide');
      return res.status(401).end();
    }

    // 📦 Récupérer profil utilisateur
    const { data: profile, error: profErr } = await supabaseService
      .from('profiles')
      .select('role, center_name')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profErr || !profile) {
      console.warn('❌ SSE: profil introuvable');
      return res.status(403).end();
    }

    // ==============================
    // INIT SSE
    // ==============================
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 🔥 important pour certains environnements (Render, proxies)
    if (res.flushHeaders) res.flushHeaders();

    // ==============================
    // ENREGISTRER LE CLIENT
    // ==============================
    const client = {
      res,
      userId: data.user.id,
      role: profile.role,
      center: (profile.center_name || '').toString().trim().toUpperCase()
    };

    sseClients.push(client);

    console.log(
      `✅ SSE connecté | role=${client.role} | center=${client.center} | total=${sseClients.length}`
    );

    // ==============================
    // CLEANUP À LA DÉCONNEXION
    // ==============================
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== client);
      console.log('❌ SSE déconnecté | total:', sseClients.length);
    });

  } catch (err) {
    console.error('❌ SSE error:', err);
    return res.status(500).end();
  }
});


// =========================================
// NOTIFY CLIENTS (SSE BROADCAST)
// =========================================
function notifyAdmins(newRequest) {
  const payload = `data: ${JSON.stringify(newRequest)}\n\n`;

  const reqCenter = (newRequest.center_name || '')
    .toString()
    .trim()
    .toUpperCase();

  console.log('📡 SSE broadcast → center:', reqCenter);

  sseClients.forEach(client => {
    try {

      // 🔵 Admin → tout
      if (client.role === 'Admin') {
        client.res.write(payload);
        client.res.flush?.();
        return;
      }

      // 👁️ PRIVATE → seulement créateur
      if (newRequest.visibility_scope === "PRIVATE") {
        if (client.userId === newRequest.created_by) {
          client.res.write(payload);
          client.res.flush?.();
        }
        return;
      }

      // 🟢 CENTER → centre
      if (client.center && reqCenter === client.center) {
        client.res.write(payload);
        client.res.flush?.();
      }

    } catch (err) {
      console.warn('⚠️ SSE write failed → suppression client');
      sseClients = sseClients.filter(c => c !== client);
    }
  });
}

/* =========================================
   ROUTES DEMANDES
========================================= */

// Création d'une demande (protected : CC ou Admin)
app.post('/requests', authenticate, async (req, res) => {
  try {
    const requestor_name = (req.body.requestor_name || '').toString().trim();
    const amount_requested = Number(req.body.amount_requested);
    const description = (req.body.description || '').toString().trim();
    const payment_method = (req.body.payment_method || '').toString().trim();
    const request_type = (req.body.request_type || '').toString().trim();

    // Validation
    const missing = [];
    if (!requestor_name) missing.push('requestor_name');
    if (!Number.isFinite(amount_requested) || amount_requested <= 0)
      missing.push('amount_requested (doit être > 0)');
    if (!description) missing.push('description');
    if (!request_type) missing.push('request_type');

    if (missing.length > 0) {
      return res.status(400).json({ error: 'Champs obligatoires manquants.', missing });
    }

    const allowedMethods = ['cash', 'cheque', 'card'];
    if (!allowedMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Mode de paiement invalide.' });
    }

    const allowedTypes = ['CashAdvance', 'FundTransfer'];
    if (!allowedTypes.includes(request_type)) {
      return res.status(400).json({ error: 'Type de demande invalide.' });
    }

    // centre (vient du formulaire, pas du profil)
    const center_name = (req.body.center_name || '')
      .toString()
      .trim()
      .toUpperCase();


    // ==============================
    // 🔐 PERMISSIONS + VISIBILITY
    // ==============================

    const SERVICE_CENTERS = ["CLINIC", "CYDW", "ADM", "CARP"];

    const userCenters = req.profile.center.split(',').map(c => c.trim());
    const isService = SERVICE_CENTERS.includes(userCenter);

    // 🔒 restriction création
    if (!isService && !userCenters.includes(center_name)) {
      return res.status(403).json({
        error: "You can only create for your own center"
      });
    }

    // 👁️ visibilité
    const visibility_scope = isService ? "PRIVATE" : "CENTER";  


    if (!center_name) {
      return res.status(400).json({ error: 'center_name is required.' });
    }

    const { data: center, error: centerError } = await supabaseService
      .from('centers')
      .select('id, code')
      .eq('code', center_name)
      .maybeSingle();

    if (centerError) {
      console.error('center lookup error:', centerError);
      return res.status(500).json({ error: 'Database error (center lookup)' });
    }

    if (!center) {
      return res.status(400).json({ error: 'Invalid center_name.' });
    }

    // sécurité : empêcher centre inventé
    const CENTERS = [
      "ADM","DIB","DIG","NURB","NURG","RB1","RB2","RB3","RB4","RB5","RB6","RB7","RB8","RB9",
      "CARP","SJE","BH","CFH","RG3","RG4","RG5","RG6","JLH","OLG","SAH","SJB","OLMC","SSK",
      "SMG","NBBS","MOB","CLINIC","SEDS","CYDW","ELD"
    ];

    if (!CENTERS.includes(center_name)) {
      return res.status(400).json({ error: 'Invalid center_name.' });
    }



    // ✅ RPC Supabase (atomique, anti-doublon)
    const { data: insertedRow, error } = await supabaseService.rpc("create_request", {
      p_requestor_name: requestor_name,
      p_center_name: center_name,
      p_center_id: center.id, // ✅ AJOUT ICI
      p_amount_requested: amount_requested,
      p_description: description,
      p_payment_method: payment_method,
      p_request_type: request_type,
      p_visibility_scope: visibility_scope,
      p_created_by: req.user.id 
    });

    // 1) Toujours gérer l'erreur en premier
    if (error) {
      console.error("RPC create_request error:", error);
      return res.status(500).json({ error: error.message });
    }

    // 2) Normaliser la réponse (parfois Supabase renvoie un tableau)
    const created = Array.isArray(insertedRow) ? insertedRow[0] : insertedRow;

    // 3) Sécurité si rien n'a été renvoyé
    if (!created) {
      return res.status(500).json({
        error: "RPC create_request did not return a row."
      });
    }

    // 4) SSE : envoyer un objet propre
    notifyAdmins(created);

    // 5) Réponse HTTP : renvoyer un objet propre
    return res.status(201).json({
      message: "Demande ajoutée avec succès",
      data: created
    });

    } catch (err) {
      console.error('POST /requests error:', err);
      return res.status(500).json({ error: err.message || err.toString() });
    }
    });


/* =========================================
   PATCH ROUTES
========================================= */
// Route ouverte pour l'admin (pas besoin de token)
app.get('/admin/requests/open', authenticate, async (req, res) => {
  try {
    // Vérifier que l'utilisateur est Admin
    if (req.profile.role !== 'Admin') {
      return res.status(403).json({ error: 'Access restricted to administrators.' });
    }

    let query = supabaseService
      .from('Requests')
      .select('*')
      .order('timestamp', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);

    console.log('Query avant execution:', query.toString?.() || query);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('GET /admin/requests/open error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH mise à jour générale
app.patch('/requests/:request_id', authenticate, async (req, res) => {
  try {
    const { request_id } = req.params;
    const { status, approved_by, approved_amount, certified_by, certified_at } = req.body;

    // Validation basique
    if (!status || (!approved_by && !certified_by)) {
      return res.status(400).json({ error: 'Status and name are required.' });
    }

    // Construire l'objet de mise à jour
    const updateData = { status };
    if (approved_by) updateData.approved_by = approved_by;
    if (approved_amount !== undefined) updateData.approved_amount = approved_amount;
    if (certified_by) updateData.certified_by = certified_by;
    if (certified_at) updateData.certified_at = certified_at ? new Date(certified_at).toISOString() : undefined;

    // Supprimer les champs undefined pour éviter Supabase errors
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    // Mise à jour avec maybeSingle pour éviter l'erreur si aucune ligne trouvée
    const { data, error } = await supabaseService
      .from('Requests')
      .update(updateData)
      .eq('request_id', request_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found.' });

    notifyAdmins(data);

    res.json({ message: 'Request updated successfully.', data });

  } catch (err) {
    console.error('PATCH /requests/:request_id error:', err);
    res.status(500).json({ error: err.message });
  }
});


// PATCH certifier argent reçu
app.patch('/requests/:request_id/received', authenticate, async (req, res) => {
  try {
    const { request_id } = req.params;
    const { amount_received, received_at, received_name, received_confirmed } = req.body;

    if (amount_received === undefined || !received_at)
      return res.status(400).json({ error: 'amount_received et received_at obligatoires.' });

    const receivedDate = new Date(received_at);
    if (isNaN(receivedDate.getTime()))
      return res.status(400).json({ error: 'received_at invalide' });

    console.log('Fetch request existante:', request_id);
    const { data: existing, error: getError } = await supabaseService
      .from('Requests')
      .select('*')
      .eq('request_id', request_id)
      .maybeSingle();
    if (getError) {
      console.error('Error fetching request:', getError);
      return res.status(500).json({ error: getError.message });
    }
    console.log('Existing request:', existing);

    if (!existing) return res.status(404).json({ error: 'Request not found.' });


    if (existing.received_confirmed)
      return res.status(400).json({ error: 'This request has already been confirmed.' });

    let statusToSet = existing.status;

      if (received_confirmed) {
        if (existing.request_type === 'FundTransfer') {
          statusToSet = 'Closed';
        } else {
          statusToSet = 'ToLiquidate';
        }
      }


    const updateData = {
      amount_received,
      received_at: receivedDate.toISOString(),
      received_name: received_name || null,
      received_confirmed: !!received_confirmed,
      status: statusToSet
    };

    console.log('Update data:', updateData);

    const { data, error } = await supabaseService
      .from('Requests')
      .update(updateData)
      .eq('request_id', request_id)
      .select();

    if (error) {
      console.error('Error update request:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data || !data.length) return res.status(404).json({ error: 'Request not found after update.' });
    // 🔥 TEMPS RÉEL
    notifyAdmins(data[0]);

    console.log('Update successful:', data);
    res.json({ message: 'Receipt confirmed and status updated.', data });

  } catch (err) {
    console.error('Catch général PATCH /received:', err);
    res.status(500).json({ error: err.message });
  }
});


// PATCH liquidation avec upload multiple


app.patch('/requests/:request_id/liquidate', authenticate, async (req, res) => {
  try {

// 🔒 seulement admin/CC peut valider la liquidation 
    const normalizeRole = (role) =>
      (role || '')
        .toLowerCase()
        .replace(/\s/g, '');

      const role = (req.profile.role || '').toLowerCase();

      if (!role.includes('admin') && !role.includes('chef')) {
        return res.status(403).json({ error: 'Not allowed' });
      }


    const { request_id } = req.params;
    let { amount_spent, returned_amount, liquidation_note } = req.body;

    if (amount_spent === undefined || returned_amount === undefined) {
      return res.status(400).json({ error: 'Spent amount and returned amount are required.' });
    }

    amount_spent = Number(amount_spent);
    returned_amount = Number(returned_amount);

    if (!Number.isFinite(amount_spent) || !Number.isFinite(returned_amount)) {
      return res.status(400).json({ error: 'Invalid spent and returned amounts.' });
    }

    const { data: existing, error: getError } = await supabaseService
      .from('Requests')
      .select('received_confirmed, status, approved_amount, request_type')
      .eq('request_id', request_id)
      .maybeSingle();

    if (getError) throw getError;
    if (!existing) return res.status(404).json({ error: 'Request not found.' });

        if (existing.request_type === 'FundTransfer') {
    return res.status(400).json({
      error: 'error: Fund Transfer does not require liquidation.' });
    }

    if (!existing.received_confirmed) {
      return res.status(400).json({ error: 'This request has not been confirmed as received.' });
    }

    if (existing.status !== 'ToLiquidate') {
      return res.status(400).json({ error: `Unable to liquidate: current status = '${existing.status}'.` });
    }

    const approved_amount = Number(existing.approved_amount);
    if (!Number.isFinite(approved_amount)) {
      return res.status(400).json({ error: 'Approved amount is missing or invalid.' });
    }

    const epsilon = 0.01;
    if (Math.abs((amount_spent + returned_amount) - approved_amount) > epsilon) {
      return res.status(400).json({
        error: 'Amounts do not match.',
        details: {
          approved_amount,
          amount_spent,
          returned_amount,
          total: amount_spent + returned_amount
        }
      });
    }

  const { data: updated, error: updateError } = await supabaseService
    .from('Requests')
    .update({
      status: 'PendingValidation',
      amount_spent,
      returned_amount,
      liquidation_note,
      liquidated_at: new Date().toISOString(),
      receipts_upload_status: 'pending',
      receipts_upload_error: null
    })
    .eq('request_id', request_id)
    .select()
    .single();

    if (updateError) throw updateError;
    notifyAdmins(updated);

    return res.json({
      success: true,
      message: 'Waiting for admin validation'
    });

  } catch (err) {
    console.error('PATCH /liquidate error:', err);
    return res.status(500).json({ error: err.message });
  }
});


app.post(
  '/requests/:request_id/receipts',
  authenticate,
  upload.array('receipts'),
  async (req, res) => {
    try {
      const { request_id } = req.params;
      const files = req.files ? [...req.files] : [];

      if (files.length === 0) {
        return res.status(400).json({ error: 'No file received.' });
      }

      const pendingFiles = files.map((file) => {
        return {
          name: file.originalname,
          temp_path: file.path
        };
      });

      await supabaseService
        .from('Requests')
        .update({
          pending_receipts: pendingFiles,
          receipts_upload_status: 'pending'
        })
        .eq('request_id', request_id);

      return res.json({
        success: true,
        message: 'Waiting for admin validation'
      });

    } catch (err) {
      console.error('POST /receipts error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);


app.patch('/requests/:request_id/request-cancel', authenticate, async (req, res) => {
  try {
    const { request_id } = req.params;
    const { cancellation_note } = req.body;

    if (!cancellation_note) {
      return res.status(400).json({ error: 'Cancellation reason required' });
    }

    // 🔒 empêcher double demande
    const { data: existing } = await supabaseService
      .from('Requests')
      .select('status')
      .eq('request_id', request_id)
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (existing.status === 'PendingCancel') {
      return res.status(400).json({ error: 'Already pending cancel' });
    }

    if (existing.status === 'Closed' || existing.status === 'Cancelled') {
      return res.status(400).json({ error: 'Cannot cancel this request' });
    }

    const { data, error } = await supabaseService
      .from('Requests')
      .update({
        status: 'PendingCancel',
        cancellation_note
      })
      .eq('request_id', request_id)
      .select()
      .maybeSingle();

    if (error) throw error;

    notifyAdmins(data);

    res.json({
      message: 'Cancellation requested',
      data
    });

  } catch (err) {
    console.error('request-cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH demander une annulation (flow avec validation admin)
    app.patch('/requests/:request_id/cancel', authenticate, async (req, res) => {
      try {
        const { request_id } = req.params;
        const { cancellation_note } = req.body;

        // 🔒 validation
        if (!cancellation_note) {
          return res.status(400).json({ error: 'Cancellation reason required' });
        }

        // 🔎 récupérer la demande actuelle
        const { data: existing } = await supabaseService
          .from('Requests')
          .select('status')
          .eq('request_id', request_id)
          .maybeSingle();

        if (!existing) {
          return res.status(404).json({ error: 'Request not found' });
        }

        // 🔒 protections métier
        if (existing.status === 'PendingCancel') {
          return res.status(400).json({ error: 'Already pending cancel' });
        }

        if (existing.status === 'Closed' || existing.status === 'Cancelled') {
          return res.status(400).json({ error: 'Cannot cancel this request' });
        }

        // 🔁 passer en attente de validation admin
        const { data, error } = await supabaseService
          .from('Requests')
          .update({
            status: 'PendingCancel',
            cancellation_note
          })
          .eq('request_id', request_id)
          .select()
          .maybeSingle();

        if (error) throw error;

        // 🔔 notifier admin (SSE)
        notifyAdmins(data);

        res.json({
          message: 'Cancellation requested',
          data
        });

      } catch (err) {
        console.error('PATCH /cancel error:', err);
        res.status(500).json({ error: err.message });
      }
    });

// PATCH VALIDATION LIQUIDATION
app.patch('/requests/:request_id/validate-liquidation', authenticate, async (req, res) => {
  try {
    const { request_id } = req.params;

    // 🔒 Admin only
    if (req.profile.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    // ==============================
    // 1) CHECK STATUS + PASSER EN CLOSED
    // ==============================
    const { data: existing, error: fetchStatusErr } = await supabaseService
      .from('Requests')
      .select('status')
      .eq('request_id', request_id)
      .single();

    if (fetchStatusErr) throw fetchStatusErr;
    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (existing.status !== 'PendingValidation') {
      console.warn("⚠️ Invalid status transition:", existing.status);
      return res.status(400).json({
        error: `Cannot close request from status '${existing.status}'`
      });
    }

    const { data, error } = await supabaseService
      .from('Requests')
      .update({ status: 'Closed' })
      .eq('request_id', request_id)
      .select()
      .maybeSingle();

    if (error) throw error;

    // ==============================
    // 2) UPLOAD DES RECEIPTS (APRÈS VALIDATION)
    // ==============================
    const { data: reqData, error: fetchErr } = await supabaseService
      .from('Requests')
      .select('pending_receipts, center_name, created_at')
      .eq('request_id', request_id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    if (Array.isArray(reqData?.pending_receipts) && reqData.pending_receipts.length > 0) {

      const uploadedReceipts = [];

      // 🔒 sécurisation données
      const center = (reqData.center_name || '').trim().toUpperCase();
      const createdAt = reqData.created_at || new Date().toISOString();

      for (const file of reqData.pending_receipts) {
        try {
            if (!file?.temp_path || !fs.existsSync(file.temp_path)) {
              console.warn("⚠️ File missing:", file);

              try {
                if (file?.temp_path) fs.unlinkSync(file.temp_path);
              } catch {}

              continue;
            }

          // 🧼 nom fichier clean
          const cleanName = file.name || `${request_id}.pdf`;

          const driveFileId = await uploadToYearCenterMonth(
            file.temp_path,
            cleanName,
            DRIVE_PARENT_ID,
            center,
            createdAt
          );

          uploadedReceipts.push({
            name: cleanName,
            drive_file_id: driveFileId
          });

          // 🔥 suppression fichier temporaire (TRÈS IMPORTANT)
          try {
            fs.unlinkSync(file.temp_path);
          } catch (e) {
            console.warn("⚠️ Failed to delete temp file:", file.temp_path);
          }

        } catch (err) {
          console.error("❌ Upload error:", err);
        }
      }

      await supabaseService
        .from('Requests')
        .update({
          receipts: uploadedReceipts,
          pending_receipts: null,
          receipts_upload_status: 'done'
        })
        .eq('request_id', request_id);
    }

    // ==============================
    // 3) RÉPONSE
    // ==============================
    res.json({
      message: 'Liquidation validated successfully',
      data
    });

  } catch (err) {
    console.error('validate liquidation error:', err);
    res.status(500).json({ error: err.message });
  }
});



app.patch('/requests/:request_id/validate-cancel', authenticate, async (req, res) => {
  try {
    const { request_id } = req.params;

    // 🔒 Admin uniquement
    if (req.profile.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    // 🔎 Récupérer la demande
    const { data: existing, error: fetchError } = await supabaseService
      .from('Requests')
      .select('status')
      .eq('request_id', request_id)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // 🔒 sécurité anti double action / incohérence
    if (existing.status === 'Cancelled') {
      return res.status(400).json({ error: 'Already cancelled' });
    }

    if (existing.status !== 'PendingCancel') {
      return res.status(400).json({
        error: `Cannot cancel from status '${existing.status}'`
      });
    }

    // ✅ Update
    const { data, error } = await supabaseService
      .from('Requests')
      .update({
        status: 'Cancelled',
        cancelled_at: new Date().toISOString(), // 🔥 bonus audit
        cancelled_by: req.user?.email || 'admin' // 🔥 traçabilité
      })
      .eq('request_id', request_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found.' });

    // 🔔 SSE update
    notifyAdmins(data);

    return res.json({
      message: 'Request cancelled',
      data
    });

  } catch (err) {
    console.error('validate-cancel error:', err);
    return res.status(500).json({ error: err.message });
  }
});


// =========================================
// LOGOUT
// =========================================
app.post('/logout', (req, res) => {
  res.clearCookie('access_token', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production'
  });

  console.log('👋 Logout OK');
  res.json({ success: true });
});

/* =========================================
   LANCEMENT SERVEUR
========================================= */


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur lancé sur http://0.0.0.0:${PORT}`);
});

