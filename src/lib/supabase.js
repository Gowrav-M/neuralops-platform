import { createClient } from '@supabase/supabase-js';

export const AUTH_ENABLED = import.meta.env.VITE_REQUIRE_AUTH === 'true';
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = AUTH_ENABLED && supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;
