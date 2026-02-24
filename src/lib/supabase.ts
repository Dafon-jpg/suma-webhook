// ============================================================================
// Supabase client — uses service_role key for server-side operations
// ============================================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../utils/config";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    const config = loadConfig();
    client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}
