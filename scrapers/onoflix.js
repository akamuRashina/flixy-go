const { withPage } = require('./browserpool');

const BASE_URL = 'https://onoflix.com';

// onoflix is a client-rendered Next.js app — the raw HTML response is an
// empty shell, and all movie data is fetched by JS in the browser after
// load. axios+cheerio can never see that content, so we spin up a real
// (headless) Chromium via Puppeteer to render the page first.
//
// Movie links follow the pattern /en/movie/<title-slug>/<tmdb-id>, e.g.
// https://onoflix.com/en/movie/turbulence/1401778 — the trailing number
// is a TMDB id. We match on that URL pattern rather than guessed CSS
// classes, same approach as the dramaid scraper, since it's far more
// resistant to the frontend's class names changing on a redeploy.
const CONTENT_LINK_RE = /\/en\/movie\/([^/]+)\/(\d+)/;


async function extractMovieLinks(page, badge) {
  // Wait for at least one movie link to show up client-side, with a
  // generous timeout since Next.js hydration + data fetch can be slow.
  await page.waitForSelector('a[href*="/en/movie/"]', { timeout: 15000 }).catch(() => null);

  return page.evaluate((badgeArg) => {
    const seen = new Map();
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/en\/movie\/([^/]+)\/(\d+)/);
      if (!match) return;
      const key = match[0];
      if (seen.has(key)) return;

      const titleSlug = match[1];
      const tmdbId = match[2];

      // Title: prefer alt text of a poster image, else visible text, else
      // derive a readable title from the slug as a last resort.
      const img = a.querySelector('img');
      let title = (img && (img.getAttribute('alt') || '')) || a.textContent || '';
      title = title.trim();
      if (!title) {
        title = titleSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }

      const poster = img ? (img.getAttribute('src') || img.getAttribute('data-src') || null) : null;

      seen.set(key, {
        title,
        poster,
        slug: `${titleSlug}/${tmdbId}`,
        type: 'movie',
        badge: badgeArg
      });
    });
    return Array.from(seen.values());
  }, badge);
}

// 1. Movie Terbaru
async function getLatestMovies() {
  try {
    return await withPage(async (page) => {
      await page.goto(`${BASE_URL}/en`, { waitUntil: 'networkidle2', timeout: 30000 });
      return (await extractMovieLinks(page, 'Movie')).slice(0, 20);
    });
  } catch (error) {
    console.error('❌ Error Onoflix Latest:', error.message);
    return [];
  }
}

// 2. Movie Populer
// NOTE: I couldn't confirm a distinct "popular" route without being able to
// render the site myself — this currently reuses the homepage and just
// relabels the badge. If onoflix has a dedicated trending/popular page
// (check the site nav for something like /en/trending or /en/popular),
// swap the URL below to point at it.
async function getPopularMovies() {
  try {
    return await withPage(async (page) => {
      await page.goto(`${BASE_URL}/en`, { waitUntil: 'networkidle2', timeout: 30000 });
      return (await extractMovieLinks(page, 'Populer')).slice(0, 20);
    });
  } catch (error) {
    console.error('❌ Error Onoflix Popular:', error.message);
    return [];
  }
}

// 3. Cari Movie
// NOTE: search URL guessed as /en/search?q= — confirm against the site's
// actual search box network request (DevTools > Network while searching)
// and adjust if it differs.
async function searchMovies(query) {
  try {
    return await withPage(async (page) => {
      await page.goto(`${BASE_URL}/en/search?q=${encodeURIComponent(query)}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      return await extractMovieLinks(page, undefined);
    });
  } catch (error) {
    console.error('❌ Error Onoflix Search:', error.message);
    return [];
  }
}

// 4. Detail & Stream Movie
// `slug` is expected as "<title-slug>/<tmdb-id>", matching what the list
// functions above produce, e.g. "turbulence/1401778".
async function getMovieDetailAndStream(slug) {
  try {
    return await withPage(async (page) => {
      const url = `${BASE_URL}/en/movie/${slug}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Try to grab an iframe player if it's already in the DOM.
      let streamUrl = await page
        .$eval('iframe', (el) => el.getAttribute('src') || el.getAttribute('data-src'))
        .catch(() => null);

      // If not present, the player may be gated behind a "play" click —
      // try common play-button patterns and wait for an iframe to appear.
      if (!streamUrl) {
        const playSelector = [
          'button[aria-label*="play" i]',
          '[class*="play" i] button',
          'button[class*="play" i]',
          '[data-testid*="play" i]'
        ].join(', ');
        const playBtn = await page.$(playSelector).catch(() => null);
        if (playBtn) {
          await playBtn.click().catch(() => null);
          await page.waitForSelector('iframe', { timeout: 8000 }).catch(() => null);
          streamUrl = await page
            .$eval('iframe', (el) => el.getAttribute('src') || el.getAttribute('data-src'))
            .catch(() => null);
        }
      }

      const title = await page.$eval('h1', (el) => el.textContent.trim()).catch(() => '');
      const poster = await page
        .$eval('img[alt]', (el) => el.getAttribute('src'))
        .catch(() => '');
      const synopsis = await page
        .$eval('p', (el) => el.textContent.trim())
        .catch(() => '');

      return {
        title,
        poster,
        synopsis,
        episodes: [],
        stream_url: streamUrl || null
      };
    });
  } catch (error) {
    console.error('❌ Error Onoflix Detail:', error.message);
    throw error;
  }
}

module.exports = {
  getLatestMovies,
  getPopularMovies,
  searchMovies,
  getMovieDetailAndStream
};