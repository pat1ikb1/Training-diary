export default {
  async fetch(request, env) {
    return await env.ASSETS.fetch(request);
  }
}
