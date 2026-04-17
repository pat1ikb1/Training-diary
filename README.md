# OmegaHRV Training Diary

## Setup

1. Copy `.env.example` to `.env`.
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env` with your Supabase project values.
3. Ensure your deployment/runtime injects these into the frontend as:
   - `window.__SUPABASE_URL__`
   - `window.__SUPABASE_ANON_KEY__`

Without valid values, cloud sync/auth will gracefully stay disabled and local/offline mode still works.
