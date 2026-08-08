import adapter from '@sveltejs/adapter-static';
// Catalog detail URLs are client-routed so the web container remains static and is the only
// published Compose service.
export default { kit: { adapter: adapter({ fallback: '200.html' }) } };
