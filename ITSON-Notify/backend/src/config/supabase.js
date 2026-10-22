// ITN-27 - Cliente de Supabase con la service_role.
// SOLO se crea en el backend: la service_role se salta RLS (las tablas tienen
// RLS activado y sin políticas), así que nunca debe llegar al worker ni al
// frontend. No loguear la llave ni el cliente.
const { createClient } = require("@supabase/supabase-js");

function createSupabaseClient({ supabaseUrl, supabaseServiceRoleKey }) {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

module.exports = { createSupabaseClient };
