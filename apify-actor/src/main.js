import { Actor } from 'apify';
import { PlaywrightCrawler, log } from '@crawlee/playwright';
import pdf from 'pdf-parse/lib/pdf-parse.js';

// ── Keyword lijsten voor link-filtering ────────────────────────────
const FOLLOW_KEYWORDS = [
  'aanvragen','subsidie','regeling','fonds','programma','criteria',
  'voorwaarden','deadline','openstelling','download','documenten',
  'pdf','reglement','wie-kan','doelgroep','bedrag','beurs','residency',
  'open-call','toekenning','bijdrage',
];

const SKIP_KEYWORDS = [
  'contact','over-ons','about','nieuws','blog','vacature','privacy',
  'cookie','sitemap','login','zoeken','agenda','evenement','pers',
  'colofon','disclaimer','archief','jaarverslag','medewerker','team',
  'english','en/',
];

// ── Subsidie-relevante woorden voor tekst extractie ────────────────
const RELEVANCE_WORDS = [
  'deadline','sluitingsdatum','maximaal','max','euro','€',
  'wie kan aanvragen','doelgroep','voorwaarden','criteria',
  'aanvraagperiode','openstelling','open voor','indienen',
  'bijdrage','beurs','subsidie','regeling','budget',
  'individuele kunstenaar','zzp','stichting','instelling',
  'residency','werkperiode','verblijf',
  'niet voor','uitgesloten','alleen voor','vereist',
];

await Actor.init();

const input = await Actor.getInput() || {};
const startUrls = (input.startUrls || []).map((u) => (typeof u === 'string' ? { url: u } : u));

const maxRequestsPerCrawl = Number(input.maxRequestsPerCrawl ?? 50);
const maxDepth = Number(input.maxDepth ?? 3);
const relevantKeywords = input.relevantKeywords || RELEVANCE_WORDS;

if (!startUrls.length) {
  throw new Error('No startUrls provided in input. Expected input.startUrls = [{ "url": "https://..." }]');
}

const requestQueue = await Actor.openRequestQueue();
for (const su of startUrls) {
  await requestQueue.addRequest({ url: su.url, userData: { depth: 0 } });
}

// ── Link filter: alleen relevante links volgen ─────────────────────
function shouldFollowLink(url) {
  const lower = url.toLowerCase();
  if (SKIP_KEYWORDS.some((kw) => lower.includes(kw))) return false;
  // PDF links altijd volgen
  if (lower.endsWith('.pdf')) return true;
  // Links met relevante keywords volgen
  if (FOLLOW_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  // Algemene pagina's op depth 0-1 ook toestaan
  return false;
}

// ── Relevante secties extraheren ───────────────────────────────────
function extractRelevantSections(text, keywords) {
  const lines = text.split(/\n/);
  const sections = [];
  const found = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 10) continue;

    const lower = line.toLowerCase();
    const matchedKw = keywords.filter((kw) => lower.includes(kw.toLowerCase()));
    if (matchedKw.length > 0) {
      // Neem context mee: 1 regel ervoor, de regel zelf, 2 regels erna
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length - 1, i + 2);
      const block = lines
        .slice(start, end + 1)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ');
      sections.push(block);
      matchedKw.forEach((kw) => found.add(kw.toLowerCase()));
    }
  }

  // Dedupliceer overlappende secties
  const unique = [];
  for (const s of sections) {
    if (!unique.some((u) => u.includes(s) || s.includes(u))) {
      unique.push(s);
    }
  }

  return { sections: unique.slice(0, 30), foundKeywords: Array.from(found) };
}

const crawler = new PlaywrightCrawler({
  requestQueue,
  maxRequestsPerCrawl,
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 120,
  headless: true,

  launchContext: {
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },

  async requestHandler({ request, page, enqueueLinks }) {
    const depth = request.userData?.depth ?? 0;
    const url = request.url;
    const lowerUrl = url.toLowerCase();

    // ── PDF afhandeling ──────────────────────────────────────────
    if (lowerUrl.endsWith('.pdf')) {
      try {
        const response = await page.context().request.get(url);
        const buffer = await response.body();
        const pdfData = await pdf(buffer);
        const text = (pdfData.text || '').substring(0, 15000);
        const { sections, foundKeywords } = extractRelevantSections(text, relevantKeywords);

        await Actor.pushData({
          url,
          title: `PDF: ${url.split('/').pop()}`,
          text,
          relevant_sections: sections,
          contentType: 'application/pdf',
          depth,
          foundKeywords,
          isPdf: true,
        });
        log.info(`PDF saved: ${url} (${foundKeywords.length} keywords)`);
      } catch (err) {
        log.warning(`PDF failed: ${url} - ${err.message}`);
      }
      return;
    }

    // ── HTML pagina afhandeling ──────────────────────────────────
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // networkidle timeout is ok, pagina is waarschijnlijk al geladen
    }

    // Verwijder ruis-elementen
    await page.evaluate(() => {
      const selectors = [
        'nav','header','footer',
        '[class*="cookie"]','[id*="cookie"]',
        '[class*="banner"]','[class*="sidebar"]',
        '[class*="menu"]','[class*="nav"]',
        '[role="navigation"]','[role="banner"]',
        '.social-share','#comments',
      ];
      selectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      });
    });

    const title = await page.title();
    const contentType = 'text/html';

    // Tekst extractie uit gezuiverde pagina
    const text = await page.evaluate(() => {
      const body = document.querySelector('body');
      if (!body) return '';
      return body.innerText || '';
    });

    const cleanText = text
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 15000);

    const { sections, foundKeywords } = extractRelevantSections(cleanText, relevantKeywords);

    await Actor.pushData({
      url,
      title,
      text: cleanText,
      relevant_sections: sections,
      contentType,
      depth,
      foundKeywords,
      isPdf: false,
    });

    log.info(`Saved: ${url} (depth ${depth}, ${foundKeywords.length} keywords, ${sections.length} sections)`);

    // ── Links volgen met filtering ───────────────────────────────
    if (depth < maxDepth) {
      await enqueueLinks({
        strategy: 'same-hostname',
        transformRequestFunction: (req) => {
          // Filter: alleen relevante links volgen, of depth 0-1 voor brede dekking
          if (depth >= 1 && !shouldFollowLink(req.url)) return false;
          req.userData = { ...(req.userData || {}), depth: depth + 1 };
          return req;
        },
      });
    }
  },

  failedRequestHandler({ request, error }) {
    log.error(`Failed: ${request.url} - ${error?.message || error}`);
  },
});

await crawler.run();

await Actor.exit();
