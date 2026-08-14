import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL and Key must be provided in environment variables');
  }

  supabaseInstance = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseInstance;
}
