/*
 * Sanity connection settings.
 * Paste the project ID from https://www.sanity.io/manage (same one as studio/.env).
 * While projectId is empty, the blog shows the sample posts from js/demo-data.js.
 */
window.SANITY_CONFIG = {
  projectId: 'cvycqoxz',
  dataset: 'production',
  apiVersion: '2025-02-19',
  useCdn: true, // fast cached reads; new posts appear within about a minute
};

/*
 * Cloudflare Stream customer code: the `customer-xxxxxxxx` part of the embed
 * host (Cloudflare dashboard → Stream → any video → Embed). A public value,
 * not a secret. The site rebuilds every Stream player URL from the video uid
 * plus this code and never trusts the host in a pasted link. Stream is not
 * set up (clips go to R2, long videos to YouTube), so this stays empty and
 * Stream video blocks are skipped (with a console warning).
 */
window.STREAM_CUSTOMER_CODE = '';
