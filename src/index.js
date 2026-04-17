export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/config.js') {
      const supabaseUrl = env.SUPABASE_URL || '';
      const supabaseKey = env.SUPABASE_ANON_KEY || '';

      const js = `window.__SUPABASE_URL__ = '${supabaseUrl}';
window.__SUPABASE_ANON_KEY__ = '${supabaseKey}';
`;

      return new Response(js, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-store'
        }
      });
    }

    return await env.ASSETS.fetch(request);
  }
}
