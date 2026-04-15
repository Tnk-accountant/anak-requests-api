require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error('❌ SUPABASE_URL manquant dans .env');
}

if (!anonKey) {
  throw new Error('❌ SUPABASE_ANON_KEY manquant dans .env');
}

if (!serviceKey) {
  throw new Error('❌ SUPABASE_SERVICE_ROLE_KEY manquant dans .env');
}

// 🔹 Client AUTH (login uniquement)
const supabaseAuth = createClient(supabaseUrl, anonKey);

// 🔹 Client ADMIN (auth admin + DB)
const supabaseAdmin = createClient(supabaseUrl, serviceKey);

// 🔹 Client SERVICE (DB)
const supabaseService = createClient(supabaseUrl, serviceKey);

module.exports = {
  supabaseAuth,
  supabaseAdmin,
  supabaseService
};