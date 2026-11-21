// Public frontend configuration.
// The publishable key below is safe to ship in the browser: all data access
// is enforced by Row Level Security. NEVER put the service-role / secret key
// in this file or anywhere in the frontend.
export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://kghigkregadnunaqnefy.supabase.co';

export const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_MMrjU4Bu4v1g071k-gxFVA_ajObo1AU';

// Internal compatibility mapping only: Supabase Auth requires passwords of at
// least 6 characters, so the user-facing 4-digit PIN is stored as PIN + suffix.
// Members never see or type this suffix.
export const PIN_SUFFIX = 'MD';

export const TIME_ZONE = 'Asia/Riyadh';
