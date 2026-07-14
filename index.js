require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const cookieParser = require('cookie-parser'); //
const { supabaseAuth, supabaseAdmin, supabaseService } = require('./supabase');


// ✅ api drive
const { uploadToYearCenterMonth } = require('./drive');
const DRIVE_PARENT_ID = '0AEg5ur7DTXwJUk9PVA'; // dossier Anak Requests sur drive



// Pour stocker les connexions SSE des admins
let sseClients = [];

// 🧼 Nettoie et valide un tableau de chaînes (display_names, saved_descriptions)
function sanitizeStringArray(arr, { maxItems = 20, maxLen = 200 } = {}) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0 && v.length <= maxLen)
    .slice(0, maxItems);
}

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
// 🔐 MIDDLEWARE AUTH (FIX)
// ==============================
async function authenticate(req, res, next) {
  try {
    let token = null;

    // ✅ 1. COOKIE
    if (req.cookies?.access_token) {
      token = req.cookies.access_token;
    }

    // ✅ 2. BEARER TOKEN (IMPORTANT)
    else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

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
          .select('role, center_name, center_id, mail, "Name", permissions, is_active, display_names, saved_descriptions, profile_label')
          .eq('id', user.id)
          .maybeSingle();

    if (profErr) {
      return res.status(500).json({ error: 'Erreur récupération profil' });
    }

    if (!profile) {
      return res.status(403).json({ error: 'Profil introuvable' });
    }

    if (profile.is_active === false) {
      return res.status(403).json({ error: 'User disabled' });
    }

    req.user = user;
    req.profile = {
          userId: user.id,
          role: profile.role,
          center: (profile.center_name || '').trim().toUpperCase(),
          center_id: profile.center_id,
          name: profile.Name,
          email: profile.mail,
          permissions: profile.permissions || {},
          is_active: profile.is_active !== false,
          display_names: Array.isArray(profile.display_names) ? profile.display_names : [],
          saved_descriptions: Array.isArray(profile.saved_descriptions) ? profile.saved_descriptions : [],
          profile_label: profile.profile_label || null
        };

    next();

  } catch (err) {
    console.error('authenticate error:', err);
    res.status(500).json({ error: 'Error serveur' });
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
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = data.user;
    const session = data.session;

const { data: profile } = await supabaseService
      .from('profiles')
      .select('role, center_name, is_active, approval_status')
      .eq('id', user.id)
      .maybeSingle();

      if (profile?.is_active === false) {
  return res.status(403).json({
    error: 'Your account has been deactivated. Please contact an administrator.'
  });
}

      if (profile?.approval_status === 'pending') {
  return res.status(403).json({
    error: 'Your account is awaiting admin approval.'
  });
}

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
// 📝 SIGNUP (compte public, en attente d'approbation)
// ==============================
app.post('/signup', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const { data: user, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

const { error: profileError } = await supabaseService
      .from('profiles')
      .insert({
        id: user.user.id,
        mail: email,
        Name: name.trim(),
        role: '',
        center_name: '',
        permissions: { scope: 'OWN' },
        is_active: true,
        approval_status: 'pending',
        display_names: [],
        saved_descriptions: []
      });

    if (profileError) {
      return res.status(400).json({ error: profileError.message });
    }

    res.json({
      success: true,
      message: 'Account created. Please wait for admin approval before logging in.'
    });

  } catch (err) {
    console.error('SIGNUP error:', err);
    res.status(500).json({ error: 'Server error' });
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
        name: req.profile.name,
        role: req.profile.role,
        center_name: req.profile.center,
        permissions: req.profile.permissions,
        is_active: req.profile.is_active,
        display_names: req.profile.display_names,
        saved_descriptions: req.profile.saved_descriptions,
        profile_label: req.profile.profile_label
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
  // ADMIN USERS
  // =====================

    // GET USERS
app.get('/admin/users', authenticate, async (req, res) => {
      try {
        if (req.profile.role !== 'Admin') {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const { data, error } = await supabaseService
          .from('profiles')
          .select('id, mail, "Name", role, center_name, permissions, is_active, display_names, saved_descriptions, profile_label')
          .order('"Name"');

        if (error) throw error;

        res.json(data);

      } catch (err) {
        console.error('GET USERS error:', err);
        res.status(500).json({ error: err.message });
      }
    });


    // CREATE USER
    app.post('/admin/users', authenticate, async (req, res) => {
      try {
        if (req.profile.role !== 'Admin') {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const { email, password, name, role, center_name, permissions, display_names, profile_label } = req.body;

        const cleanDisplayNames = sanitizeStringArray(display_names, { maxItems: 10, maxLen: 50 });
        const cleanLabel = (typeof profile_label === 'string' ? profile_label.trim() : '') || null;

        // =====================
        // 1. CREATE AUTH USER
        // =====================
        const { data: user, error } = await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true
        });

        if (error) {
          console.error("AUTH ERROR:", error);
          return res.status(400).json({ error: error.message });
        }

        // =====================
        // 2. CREATE PROFILE
        // =====================
const { error: profileError } = await supabaseService
          .from('profiles')
          .insert({
            id: user.user.id,
            mail: email,
            Name: name || '',
            role: role || 'Requester',
            center_name: center_name || '',
            permissions: permissions || { scope: 'OWN' },
            is_active: true,
            display_names: cleanDisplayNames,
            saved_descriptions: [],
            profile_label: cleanLabel
          });

        if (profileError) {
          console.error("PROFILE ERROR:", profileError);
          return res.status(400).json({ error: profileError.message });
        }

        res.json({ success: true });

      } catch (err) {
        console.error('CREATE USER error:', err);
        res.status(500).json({ error: err.message });
      }
    });


    // UPDATE USER
    app.patch('/admin/users/:id', authenticate, async (req, res) => {
      try {
        if (req.profile.role !== 'Admin') return res.status(403);

const { role, center_name, permissions, is_active, name, display_names, profile_label } = req.body;

        const updateData = {
          role,
          center_name,
          permissions,
          is_active,
          Name: name
        };

        // 🔥 champs optionnels : on ne les touche que si envoyés explicitement
        if (display_names !== undefined) {
          updateData.display_names = sanitizeStringArray(display_names, { maxItems: 10, maxLen: 50 });
        }
        if (profile_label !== undefined) {
          updateData.profile_label = (typeof profile_label === 'string' ? profile_label.trim() : '') || null;
        }

        const { error } = await supabaseService
          .from('profiles')
          .update(updateData)
          .eq('id', req.params.id);

        if (error) throw error;

        res.json({ success: true });

      } catch (err) {
        console.error('UPDATE USER error:', err);
        res.status(500).json({ error: err.message });
      }
    });

// GET PENDING USERS
    app.get('/admin/pending-users', authenticate, async (req, res) => {
      try {
        if (req.profile.role !== 'Admin') {
          return res.status(403).json({ error: 'Forbidden' });
        }

const { data, error } = await supabaseService
          .from('profiles')
          .select('id, mail, "Name"')
          .eq('approval_status', 'pending')
          .order('"Name"', { ascending: true });

        if (error) throw error;

        res.json(data);

      } catch (err) {
        console.error('GET PENDING USERS error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // APPROVE USER
    app.patch('/admin/users/:id/approve', authenticate, async (req, res) => {
      try {
        if (req.profile.role !== 'Admin') {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const { role, center_name, permissions } = req.body;

        if (!role) {
          return res.status(400).json({ error: 'Role is required to approve this account' });
        }

        const { error } = await supabaseService
          .from('profiles')
          .update({
            role,
            center_name: center_name || '',
            permissions: permissions || { scope: role === 'Admin' ? 'ALL' : role === 'CC' ? 'CENTER' : 'OWN' },
            approval_status: 'approved'
          })
          .eq('id', req.params.id);

        if (error) throw error;

        res.json({ success: true });

      } catch (err) {
        console.error('APPROVE USER error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // DELETE USER ADMIN SIDE
app.delete('/admin/users/:id', authenticate, async (req, res) => {
  try {
    if (req.profile.role !== 'Admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const userId = req.params.id;

    if (userId === req.user.id) {
      return res.status(400).json({
        error: 'You cannot delete your own account'
      });
    }

    // 🔒 Vérifier AVANT toute suppression : des demandes liées existent-elles ?
    const { count, error: countError } = await supabaseService
      .from('Requests')
      .select('request_id', { count: 'exact', head: true })
      .eq('created_by', userId);

    if (countError) throw countError;

    if (count > 0) {
      return res.status(400).json({
        error: `Cannot delete: this user has ${count} request(s) linked to their account. Disable the account instead to preserve history.`
      });
    }

    // ✅ Aucune demande liée → suppression sûre
    const { error: profileError } = await supabaseService
      .from('profiles')
      .delete()
      .eq('id', userId);

    if (profileError) throw profileError;

    const { error: authError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) throw authError;

    res.json({ success: true });

  } catch (err) {
    console.error('DELETE USER error:', err);
    res.status(500).json({ error: err.message });
  }
});


// =====================
// GET REQUESTS (PAGINATED + PERMISSIONS)
// =====================
app.get('/requests', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const perms = req.profile.permissions || {};

    console.log(
      '🔹 GET /requests | role=', req.profile.role,
      '| scope=', perms.scope,
      '| center=', req.profile.center,
      '| status=', req.query.status || 'none',
      '| limit=', limit,
      '| offset=', offset
    );

    let query = supabaseService
      .from('Requests')
      .select('*', { count: 'exact' })
      .eq('archived', false)
      .order('timestamp', { ascending: false })
      .range(offset, offset + limit - 1);

    // ==============================
    // 🔐 NEW ROLE-BASED LOGIC
    // ==============================

    const role = req.profile.role;
    const userId = req.user.id;
    const userCenter = req.profile.center;

    // 👑 ADMIN → voit tout
    if (role === 'Admin') {
      // no filter
    }

// 🏠 CC → voit tous les centres qu'il supervise
else if (role === 'CC') {

  const allowedCenters =
    req.profile.permissions?.allowed_centers || [];

  if (allowedCenters.length > 0) {
    query = query.in('center_name', allowedCenters);
  } else {
    query = query.eq('center_name', userCenter);
  }

}

    // 👤 REQUESTER → voit uniquement ses demandes
    else {
      query = query.eq('created_by', userId);
    }

    // ==============================
    // 🔎 FILTRE STATUS
    // ==============================
    if (req.query.status) {
      query = query.eq('status', req.query.status);
    }

    // ==============================
    // 🚀 EXECUTION
    // ==============================
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





    // ==============================
    // ARCHIVES
    // ==============================
app.get('/requests/archives', authenticate, async (req, res) => {
  try {

    if (req.profile.role !== 'Admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data, error } = await supabaseService
      .from('Requests')
      .select('*')
      .eq('archived', true)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    res.json({ data });

  } catch (err) {

    console.error('GET ARCHIVES error:', err);
    res.status(500).json({ error: err.message });

  }
});

// ========== ARCHIVED ROUTE 1=======

app.post('/requests/archive-completed', authenticate, async (req, res) => {
  try {

    if (req.profile.role !== 'Admin') {
      return res.status(403).json({
        error: 'Forbidden'
      });
    }

    const { data, error } = await supabaseService
      .from('Requests')
      .update({
        archived: true
      })
      .in('status', ['Closed', 'Cancelled'])
      .eq('archived', false)
      .select();

    if (error) throw error;

    res.json({
      success: true,
      archived: data.length
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }
});

// ========== ARCHIVED ROUTE 2 =======

app.get('/requests/archive-stats', authenticate, async (req, res) => {
  try {

    const { data, error } = await supabaseService
      .from('Requests')
      .select('status')
      .eq('archived', false)
      .in('status', ['Closed', 'Cancelled']);

    if (error) throw error;

    const closed =
      data.filter(r => r.status === 'Closed').length;

    const cancelled =
      data.filter(r => r.status === 'Cancelled').length;

    res.json({
      closed,
      cancelled,
      total: closed + cancelled
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }
});


//======== RESTORE =========
app.patch('/requests/:request_id/restore', authenticate, async (req, res) => {
  try {

    if (req.profile.role !== 'Admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { request_id } = req.params;

    const { data, error } = await supabaseService
      .from('Requests')
      .update({
        archived: false
      })
      .eq('request_id', request_id)
      .select()
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      data
    });

  } catch (err) {

    console.error('RESTORE error:', err);
    res.status(500).json({ error: err.message });

  }
});

// ===============
// RETOUR clarification ADMIN 
//================

// =====================
// USER RESPONSE TO CLARIFICATION
// =====================
app.post('/requests/:id/respond', authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    const { id } = req.params;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

// 🔥 1. récupérer conversation
    const { data: existing, error: fetchError } = await supabaseService
      .from('Requests')
      .select('conversation, created_by')
      .eq('request_id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // 🔒 Seul le créateur de la demande (ou un Admin) peut répondre
    const respondRole = (req.profile.role || '').toLowerCase();
    if (respondRole !== 'admin' && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const conversation = existing?.conversation || [];

    // 🔥 2. ajouter message user
    conversation.push({
      sender: "user",
      message,
      created_at: new Date().toISOString()
    });

    // 🔥 3. update
    const { data, error } = await supabaseService
      .from('Requests')
      .update({
        conversation,
        status: 'Resubmitted'
      })
      .eq('request_id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    notifyAdmins(data);

    res.json({ success: true, data });

  } catch (err) {
    console.error('Respond error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/requests/:id/feedback', authenticate, async (req, res) => {
  try {
    // 🔒 Réservé aux Admins
    if ((req.profile.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { message } = req.body;
    const { id } = req.params;

    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    // 🔥 1. récupérer conversation actuelle
    const { data: existing, error: fetchError } = await supabaseService
      .from('Requests')
      .select('conversation')
      .eq('request_id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;

    const conversation = existing?.conversation || [];

    // 🔥 2. ajouter message admin
    conversation.push({
      sender: "admin",
      message,
      created_at: new Date().toISOString()
    });

    // 🔥 3. update
    const { data, error } = await supabaseService
      .from('Requests')
      .update({
        conversation,
        status: 'NeedsInfo'
      })
      .eq('request_id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    notifyAdmins(data);

    res.json({ success: true, data });

  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: "Server error" });
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


   //=================
    // GET REQUEST REQUEST ID
    //=========================
    
app.get('/requests/:request_id', authenticate, async (req, res) => {
  try {
    const { request_id } = req.params;

    const { data, error } = await supabaseService
      .from('Requests')
      .select('*')
      .eq('request_id', request_id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: 'Request not found.'
      });
    }

    res.json({ data });

  } catch (err) {
    console.error('GET /requests/:request_id error:', err);
    res.status(500).json({
      error: err.message
    });
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


// =========================================
// SAVED DESCRIPTIONS (templates personnels)
// =========================================

app.post('/profile/descriptions', authenticate, async (req, res) => {
  try {
    const description = (req.body.description || '').toString().trim();

    if (!description) {
      return res.status(400).json({ error: 'Description required' });
    }
    if (description.length > 300) {
      return res.status(400).json({ error: 'Description too long (max 200 characters)' });
    }

    const current = req.profile.saved_descriptions || [];

    if (current.includes(description)) {
      return res.status(400).json({ error: 'This description is already saved' });
    }
    if (current.length >= 20) {
      return res.status(400).json({ error: 'Maximum 20 saved descriptions reached' });
    }

    const updated = [...current, description];

    const { error } = await supabaseService
      .from('profiles')
      .update({ saved_descriptions: updated })
      .eq('id', req.user.id);

    if (error) throw error;

    res.json({ success: true, saved_descriptions: updated });

  } catch (err) {
    console.error('POST /profile/descriptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/profile/descriptions', authenticate, async (req, res) => {
  try {
    const description = (req.body.description || '').toString().trim();

    if (!description) {
      return res.status(400).json({ error: 'Description required' });
    }

    const current = req.profile.saved_descriptions || [];
    const updated = current.filter(d => d !== description);

    const { error } = await supabaseService
      .from('profiles')
      .update({ saved_descriptions: updated })
      .eq('id', req.user.id);

    if (error) throw error;

    res.json({ success: true, saved_descriptions: updated });

  } catch (err) {
    console.error('DELETE /profile/descriptions error:', err);
    res.status(500).json({ error: err.message });
  }
});


// =========================================
// ROUTES DEMANDES
// =========================================

app.post('/requests', authenticate, async (req, res) => {
  try {
    // 🔥 Compte partagé (display_names configuré) → le client choisit son prénom
    // Sinon → comportement inchangé, le nom vient du profil (sécurisé)
    let requestor_name = req.profile.name || req.profile.email;

    const allowedDisplayNames = req.profile.display_names || [];
    if (allowedDisplayNames.length > 0) {
      const submittedName = (req.body.requestor_name || '').toString().trim();
      if (!allowedDisplayNames.includes(submittedName)) {
        return res.status(400).json({
          error: 'Please select who is submitting this request.',
          allowed: allowedDisplayNames
        });
      }
      requestor_name = submittedName;
    }
    const amount_requested = Number(req.body.amount_requested);
    const description = (req.body.description || '').toString().trim();
    const payment_method = (req.body.payment_method || '').toString().trim();
    const request_type = (req.body.request_type || '').toString().trim();

    const other_centers = Array.isArray(req.body.other_centers)
  ? req.body.other_centers.map(c => c.trim().toUpperCase())
  : [];

    // ==============================
    // 🔍 VALIDATION
    // ==============================

    const missing = [];
    if (!requestor_name) missing.push('requestor_name');
    if (!Number.isFinite(amount_requested) || amount_requested <= 0)
      missing.push('amount_requested (> 0)');
    if (!description) missing.push('description');
    if (!request_type) missing.push('request_type');

    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Champs obligatoires manquants.',
        missing
      });
    }

    const allowedMethods = ['cash', 'cheque', 'card'];
    if (!allowedMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Mode de paiement invalide.' });
    }

    const allowedTypes = ['CashAdvance', 'FundTransfer'];
    if (!allowedTypes.includes(request_type)) {
      return res.status(400).json({ error: 'Type de demande invalide.' });
    }

    // ==============================
    // 📍 CENTER (depuis le front)
    // ==============================

    let center_name = (req.body.center_name || '')
      .toString()
      .trim()
      .toUpperCase();

    // ==============================
    // 🔐 PERMISSIONS (CLEAN)
    // ==============================

    const role = (req.profile.role || '').toLowerCase();
    const perms = req.profile.permissions || {};

    // 👤 REQUESTER → libre
    if (role === 'requester') {
      // ✅ autorisé partout
    }

    // 🏠 CC → limité

    else if (role === 'cc') {
      const allowedCenters = req.profile.permissions?.allowed_centers;

      const centers = (Array.isArray(allowedCenters) && allowedCenters.length > 0)
        ? allowedCenters.map(c => c.toUpperCase())
        : [req.profile.center];

      if (!centers.includes(center_name)) {
        return res.status(403).json({
          error: "Not allowed to create for this center"
        });
      }

      for (const oc of other_centers) {
        if (!centers.includes(oc)) {
          return res.status(403).json({
            error: `Not allowed to add center: ${oc}`
          });
        }
      }
    }

    // 👑 ADMIN → libre
    else if (role === 'admin') {
      // ✅ autorisé
    }

    // 🔒 fallback sécurité
    else {
      return res.status(403).json({
        error: "User not allowed"
      });
    }

    // ==============================
    // 👁️ VISIBILITY
    // ==============================

    let visibility_scope = "CENTER";

    if (perms.scope === "OWN") {
      visibility_scope = "PRIVATE";
    }

    // ==============================
    // 🔎 VALIDATION CENTRE
    // ==============================

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

    // 🔒 whitelist centres
    const CENTERS = [
      "ADM","CAMP", "ALL CENTERS", "DIB","DIG","NURB","NURG","RB1","RB2","RB3","RB4","RB5","RB6","RB7","RB8","RB9",
      "CARP","SJE","BH","CFH","RG3","RG4","RG5","RG6","JLH","OLG","SAH","SJB","OLMC","SSK",
      "SMG","NBBS","MOB","CLINIC","SEDS","CYDW","ELD"
    ];

    if (!CENTERS.includes(center_name)) {
      return res.status(400).json({ error: 'Invalid center_name.' });
    }

    for (const c of other_centers) {

      if (!CENTERS.includes(c)) {
        return res.status(400).json({
          error: `Invalid other center: ${c}`
        });
      }

    }

    // ==============================
    // 🚀 INSERT (RPC)
    // ==============================

    const { data: insertedRow, error } = await supabaseService.rpc("create_request", {
      p_requestor_name: requestor_name,
      p_center_name: center_name,
      p_center_id: center.id,
      p_amount_requested: amount_requested,
      p_description: description,
      p_payment_method: payment_method,
      p_request_type: request_type,
      p_created_by: req.user.id,
      p_visibility_scope: visibility_scope,
      p_other_centers: other_centers
    });

    if (error) {
      console.error("RPC create_request error:", error);
      return res.status(500).json({ error: error.message });
    }

    const created = Array.isArray(insertedRow) ? insertedRow[0] : insertedRow;

    if (!created) {
      return res.status(500).json({
        error: "RPC create_request did not return a row."
      });
    }

    // ==============================
    // 🔔 SSE + RESPONSE
    // ==============================

    notifyAdmins(created);

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

    console.log("BODY:", req.body);
    console.log("UPDATED:", data);

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

    // 🔒 Autorisation : Admin | CC (centre autorisé) | Requester (créateur uniquement)
    const receivedRole = (req.profile.role || '').toLowerCase();

    if (receivedRole === 'admin') {
      // ✅ autorisé
    } else if (receivedRole === 'cc') {
      const allowedCenters = req.profile.permissions?.allowed_centers;
      const centers = (Array.isArray(allowedCenters) && allowedCenters.length > 0)
        ? allowedCenters.map(c => c.toUpperCase())
        : [req.profile.center];

      if (!centers.includes((existing.center_name || '').toUpperCase())) {
        return res.status(403).json({ error: 'Not allowed for this center' });
      }
    } else if (receivedRole === 'requester') {
      if (existing.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    } else {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (existing.received_confirmed)
      return res.status(400).json({ error: 'This request has already been confirmed.' });

    let statusToSet = existing.status;

if (received_confirmed) {
        if (existing.request_type === 'FundTransfer' || existing.payment_method === 'cheque') {
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

const role = (req.profile.role || '').trim().toLowerCase();

if (!['requester', 'cc', 'admin'].includes(role)) {
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
      .select('created_by, received_confirmed, status, approved_amount, request_type, center_name')
      .eq('request_id', request_id)
      .maybeSingle();

    if (getError) throw getError;
    if (!existing) return res.status(404).json({ error: 'Request not found.' });

    // 🔒 Un Requester ne peut liquider que ses propres demandes
    if (
      role === 'requester' &&
      existing.created_by !== req.user.id
    ) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // 🔒 Un CC ne peut liquider que les demandes de ses centres autorisés
    if (role === 'cc') {
      const allowedCenters = req.profile.permissions?.allowed_centers;
      const centers = (Array.isArray(allowedCenters) && allowedCenters.length > 0)
        ? allowedCenters.map(c => c.toUpperCase())
        : [req.profile.center];

      if (!centers.includes((existing.center_name || '').toUpperCase())) {
        return res.status(403).json({ error: 'Not allowed for this center' });
      }
    }

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
      .select('status, created_by, center_name')
      .eq('request_id', request_id)
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // 🔒 Autorisation : Admin | CC (centre autorisé) | Requester (créateur uniquement)
    const cancelRole = (req.profile.role || '').toLowerCase();

    if (cancelRole === 'admin') {
      // ✅ autorisé
    } else if (cancelRole === 'cc') {
      const allowedCenters = req.profile.permissions?.allowed_centers;
      const centers = (Array.isArray(allowedCenters) && allowedCenters.length > 0)
        ? allowedCenters.map(c => c.toUpperCase())
        : [req.profile.center];

      if (!centers.includes((existing.center_name || '').toUpperCase())) {
        return res.status(403).json({ error: 'Not allowed for this center' });
      }
    } else if (cancelRole === 'requester') {
      if (existing.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    } else {
      return res.status(403).json({ error: 'Not allowed' });
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
          .select('status, created_by, center_name')
          .eq('request_id', request_id)
          .maybeSingle();

        if (!existing) {
          return res.status(404).json({ error: 'Request not found' });
        }

        // 🔒 Autorisation : Admin | CC (centre autorisé) | Requester (créateur uniquement)
        const cancelRole2 = (req.profile.role || '').toLowerCase();

        if (cancelRole2 === 'admin') {
          // ✅ autorisé
        } else if (cancelRole2 === 'cc') {
          const allowedCenters = req.profile.permissions?.allowed_centers;
          const centers = (Array.isArray(allowedCenters) && allowedCenters.length > 0)
            ? allowedCenters.map(c => c.toUpperCase())
            : [req.profile.center];

          if (!centers.includes((existing.center_name || '').toUpperCase())) {
            return res.status(403).json({ error: 'Not allowed for this center' });
          }
        } else if (cancelRole2 === 'requester') {
          if (existing.created_by !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed' });
          }
        } else {
          return res.status(403).json({ error: 'Not allowed' });
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
// 🔑 REQUEST PASSWORD RESET (public)
// =========================================
app.post('/request-password-reset', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const redirectTo = process.env.NODE_ENV === 'production'
      ? 'https://anak-requests-api.onrender.com/reset-password.html'
      : 'http://localhost:5500/reset-password.html';

    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo
    });

    // ⚠️ On répond toujours "success" même si l'email n'existe pas
    // (évite de révéler quels emails sont enregistrés dans le système)
    if (error) console.warn('Reset password warning:', error.message);

    res.json({ success: true, message: 'If this email exists, a reset link has been sent.' });

  } catch (err) {
    console.error('REQUEST PASSWORD RESET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// =========================================
// 🔑 CONFIRM PASSWORD RESET (public)
// =========================================
app.post('/reset-password', async (req, res) => {
  const { access_token, refresh_token, new_password } = req.body;

  if (!access_token || !new_password) {
    return res.status(400).json({ error: 'Missing token or new password' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const { data: sessionData, error: sessionError } = await supabaseAuth.auth.setSession({
      access_token,
      refresh_token
    });

    if (sessionError || !sessionData?.session) {
      return res.status(401).json({ error: 'This reset link is invalid or has expired.' });
    }

    const { error: updateError } = await supabaseAuth.auth.updateUser({
      password: new_password
    });

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    res.json({ success: true });

  } catch (err) {
    console.error('RESET PASSWORD error:', err);
    res.status(500).json({ error: 'Server error' });
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

