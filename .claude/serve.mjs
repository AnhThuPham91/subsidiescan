import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const envPath = join(root, '.env');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

/** Parse .env file into { KEY: value } object */
async function loadEnv() {
  try {
    const text = await readFile(envPath, 'utf-8');
    const env = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // API endpoint: serve keys from .env (localhost only)
  if (urlPath === '/api/keys') {
    const env = await loadEnv();
    const keys = {
      claudeApiKey: env.CLAUDE_API_KEY || '',
      apifyToken:   env.APIFY_TOKEN || '',
      serpApiKey:    env.SERPAPI_KEY || '',
    };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(keys));
    return;
  }

  // Static file serving
  const filePath = urlPath === '/' ? '/index.html' : urlPath;
  try {
    const data = await readFile(join(root, filePath));
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(8080, () => console.log('Serving on http://localhost:8080'));
