import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** Register after all API routes; only extensionless HTML routes receive the SPA. */
export function registerStaticRoutes(app: Hono, root = './dist'): void {
  app.use('*', async (context, next) => {
    let path: string;
    try { path = decodeURIComponent(context.req.path); }
    catch { return context.notFound(); }
    // Even encoded API paths and the bare prefix must never fall through to HTML.
    if (/^\/api(?:\/|$)/i.test(path)) return context.notFound();
    context.header('Cache-Control', 'no-cache');
    if (path === '/sw.js') {
      context.header('Service-Worker-Allowed', '/');
    }
    // Bundles can render authenticated data: don't persist them in the HTTP cache either.
    if (path.startsWith('/assets/')) context.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', serveStatic({ root }));
  app.get('*', async context => {
    const path = context.req.path;
    const accept = context.req.header('Accept') ?? '*/*';
    const destination = context.req.header('Sec-Fetch-Dest');
    if (extname(path) || /^\/(?:assets|icons)(?:\/|$)/.test(path) || path.includes('%') ||
        (destination && destination !== 'document' && destination !== 'iframe') ||
        (!accept.includes('text/html') && !accept.includes('*/*'))) {
      return context.notFound();
    }
    context.header('Cache-Control', 'no-cache');
    return context.html(await readFile(join(root, 'index.html'), 'utf8'));
  });
}
