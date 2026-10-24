const axios = require('axios');
const cheerio = require('cheerio');
const { withPage, gotoWithRetry } = require('./browserpool');

const BASE_URL = 'https://dramacool9.com.ro';
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': BASE_URL
};

// Episode pages look like /<slug>-episode-<n>.html — series root pages are
// just /<slug>. Matching on that trailing pattern lets us tell them apart
// without guessing CSS classes.
const EPISODE_LINK_RE = /\/([a-z0-9-]+)-episode-(\d+)\.html$/i;

// Given either an episode slug ("payback-2026-episode-9.html") or a series
// root slug ("payback-2026"), return the series root slug.
function toSeriesSlug(slug) {
  const clean = slug.replace(/^\/|\/$/g, '');
  const match = clean.match(/^(.+?)-episode-\d+\.html$/i);
  return match ? match[1] : clean;
}

// Confirmed live format: "Genres: [Historical], [Romance]" — a single line
// with comma-separated genre links, followed by the next field label
// (usually "Starring:"). Stop at the next generic "Label:" pattern rather
// than hardcoding which label comes next, since that varies per drama.
function extractGenresFromBodyText(bodyText) {
  const genreMatch = bodyText.match(/Genres?:\s*(.*?)(?=\s+[A-Z][a-zA-Z ]{2,20}:|$)/);
  return genreMatch ? genreMatch[1].split(',').map((g) => g.trim()).filter(Boolean) : [];
}

// List/search pages (homepage rails, search results, popular-drama page)
// contain NO <img> tags at all for their items, and don't show genre
// either — confirmed directly against the live HTML, not a scraping miss.
// Both only exist on each drama's own series page, so fetch that once per
// item and pull both out together (rather than two separate requests).
// Cache by slug since neither poster nor genre changes for a given drama,
// so repeated home-page loads don't keep re-fetching the same series.
const seriesExtrasCache = new Map(); // seriesSlug -> { data: {poster, genres}, expires }
const SERIES_EXTRAS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchSeriesExtras(seriesSlug) {
  const cached = seriesExtrasCache.get(seriesSlug);
  if (cached && cached.expires > Date.now()) return cached.data;

  let extras = { poster: null, genres: [] };
  try {
    const { data } = await axios.get(`${BASE_URL}/${seriesSlug}`, { headers });
    const $ = cheerio.load(data);
    const width = parseInt($('meta[property="og:image:width"]').attr('content') || '0', 10);
    const poster = width >= 100 ? ($('meta[property="og:image"]').attr('content') || null) : null;
    const genres = extractGenresFromBodyText($('body').text().replace(/\s+/g, ' ').trim());
    extras = { poster, genres };
  } catch {
    // leave defaults rather than failing the whole list
  }
  seriesExtrasCache.set(seriesSlug, { data: extras, expires: Date.now() + SERIES_EXTRAS_CACHE_TTL_MS });
  return extras;
}

async function enrichWithExtras(list) {
  const settled = await Promise.allSettled(
    list.map(async (item) => ({ ...item, ...(await fetchSeriesExtras(toSeriesSlug(item.slug))) }))
  );
  return settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { ...list[i], genres: [] }));
}

function extractEpisodeListFromHtml(html, badge) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !EPISODE_LINK_RE.test(href)) return;
    if (seen.has(href)) return;

    const title = ($(el).attr('title') || $(el).text() || '').trim();
    if (!title) return;

    const slug = href.split('/').filter(Boolean).pop(); // e.g. "payback-2026-episode-9.html"

    seen.set(href, { title, poster: null, slug, type: 'kdrama', badge });
  });

  return Array.from(seen.values());
}

// 1. KDrama Terbaru (latest episode updates, straight off the homepage)
async function getLatestKDrama() {
  try {
    const { data } = await axios.get(BASE_URL, { headers });
    const list = extractEpisodeListFromHtml(data, 'KDrama').slice(0, 20);
    return await enrichWithExtras(list);
  } catch (error) {
    console.error('❌ Error Dramacool Latest:', error.message);
    return [];
  }
}

// 2. KDrama Populer
async function getPopularKDrama() {
  try {
    const { data } = await axios.get(`${BASE_URL}/all-most-popular-dramaz`, { headers });
    const $ = cheerio.load(data);
    const seen = new Map();

    // This page lists drama *series* (no -episode-N suffix), not episodes.
    // Confirmed directly against the live HTML: there are no <img> tags on
    // this page at all (same as the homepage rails), so posters are filled
    // in below via enrichWithExtras rather than scraped here.
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const path = href.replace(BASE_URL, '');
      if (!/^\/[a-z0-9-]+$/i.test(path)) return; // series root pages only
      if (seen.has(href)) return;

      const title = ($(el).attr('title') || $(el).text() || '').trim();
      if (!title) return;

      const slug = path.replace(/^\//, '');

      seen.set(href, { title, poster: null, slug, type: 'kdrama', badge: 'Populer' });
    });

    const list = Array.from(seen.values()).slice(0, 20);
    return await enrichWithExtras(list);
  } catch (error) {
    console.error('❌ Error Dramacool Popular:', error.message);
    return [];
  }
}

// 3. Cari KDrama
async function searchKDrama(query) {
  try {
    const { data } = await axios.get(`${BASE_URL}/?s=${encodeURIComponent(query)}`, { headers });
    const list = extractEpisodeListFromHtml(data, undefined);
    return await enrichWithExtras(list);
  } catch (error) {
    console.error('❌ Error Dramacool Search:', error.message);
    return [];
  }
}

// 4. Detail KDrama
// `slug` is a series root slug, e.g. "payback-2026" (no .html)
async function getKDramaDetail(slug) {
  try {
    // Callers may hand this either a series root slug ("payback-2026") or
    // an episode slug ("payback-2026-episode-9.html") — the latter is what
    // getLatestKDrama/searchKDrama's `slug` field actually contains. That
    // mismatch was the real cause of "poster is the site logo": episode
    // pages don't carry their own poster/full synopsis at all, only the
    // series root page does, so fetching an episode slug here always hit
    // a page with nothing real to scrape. Normalize down to the series
    // root regardless of which shape came in.
    const cleanSlug = toSeriesSlug(slug);
    const { data } = await axios.get(`${BASE_URL}/${cleanSlug}`, { headers });
    const $ = cheerio.load(data);

    const title = $('h1').first().text().replace(/English SUB.*$/i, '').trim();

    // The SEO plugin falls og:image back to the site's own tiny default
    // logo (32x32) whenever a page has no dedicated poster set. Real
    // posters here are ~300x420ish, so use the width the same plugin
    // emits alongside it (og:image:width) to filter that fallback out
    // instead of trusting og:image blindly.
    const ogImageWidth = parseInt($('meta[property="og:image:width"]').attr('content') || '0', 10);
    const poster = ogImageWidth >= 100
      ? ($('meta[property="og:image"]').attr('content') || '')
      : '';

    // meta og:description is truncated to ~155 chars by the SEO plugin —
    // the FULL synopsis lives in the page body right after a "Synopsis:"
    // label. Pull that instead, and only fall back to the (possibly
    // truncated) meta tag if the label isn't found for some reason.
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const synMatch = bodyText.match(
      /Synopsis:\s*(.*?)\s*(?:Also known as:|Country:|Status:|Release Year:|Genres:)/
    );
    const synopsis = synMatch
      ? synMatch[1].trim()
      : ($('meta[property="og:description"]').attr('content') || '');

    const genres = extractGenresFromBodyText(bodyText);
    seriesExtrasCache.set(cleanSlug, { data: { poster, genres }, expires: Date.now() + SERIES_EXTRAS_CACHE_TTL_MS });

    const episodes = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !EPISODE_LINK_RE.test(href)) return;
      const epSlug = href.split('/').filter(Boolean).pop();

      // The page often has a "Related/Recommended Dramas" sidebar whose
      // episode links match this same pattern but belong to a COMPLETELY
      // DIFFERENT drama — scanning the whole page for any episode-shaped
      // link (as this used to) mixed those in, which is exactly why the
      // wrong episode would sometimes play, or a single-episode drama
      // would appear to have extra episodes. Only keep links whose slug
      // is actually prefixed with this series' own slug.
      if (!epSlug.toLowerCase().startsWith(`${cleanSlug.toLowerCase()}-episode-`)) return;

      const match = href.match(EPISODE_LINK_RE);
      const epNum = parseInt(match[2], 10);
      if (!episodes.find((e) => e.slug === epSlug)) {
        episodes.push({ number: epNum, title: `Episode ${epNum}`, slug: epSlug });
      }
    });
    episodes.sort((a, b) => a.number - b.number);

    return { title, poster, synopsis, genres, episodes };
  } catch (error) {
    console.error('❌ Error Dramacool Detail:', error.message);
    throw error;
  }
}

// 5. Stream KDrama
// `episodeSlug` is e.g. "payback-2026-episode-9.html"
async function getKDramaStream(episodeSlug) {
  const cleanSlug = episodeSlug.replace(/^\//, '');
  const targetUrl = `${BASE_URL}/${cleanSlug}`;

  // Static extraction: finds the iframe src straight off the page.
  let embedUrl = null;
  try {
    const { data } = await axios.get(targetUrl, { headers });
    const $ = cheerio.load(data);
    embedUrl = $('iframe').attr('src') || $('iframe').attr('data-src') || null;

    if (!embedUrl) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && /\/embed\//i.test(href)) {
          embedUrl = href;
          return false; // break
        }
      });
    }
  } catch (error) {
    console.error('❌ Error Dramacool Stream (static):', error.message);
  }

  // That embed URL is itself a JS-driven *player page* (loads its own UI,
  // then fetches the real video), not a raw video file — opening it
  // directly gets you a webpage, not something a native video player can
  // just play. Drive a real browser to load it and sniff the network for
  // the actual .m3u8/.mp4 request the player makes once it's running,
  // clicking a "Server" button first if present — matching browserPool's
  // original comment about this site's player needing exactly that.
  //
  // The subtitles are a SEPARATE resource (.vtt/.srt/.ass) that the
  // player's own JS loads and attaches to its video element — grabbing
  // only the raw video URL bypasses that entirely, which is why subtitles
  // disappeared once playback moved outside the original player. Sniff
  // for that request too and hand it back so the caller can attach it as
  // its own subtitle track.
  let videoUrl = null;
  let subtitleUrl = null;
  try {
    const result = await withPage(async (page) => {
      const videoHits = [];
      const subtitleHits = [];
      const onResponse = (response) => {
        const url = response.url();
        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        const looksLikeVideo =
          /\.m3u8(\?|$)|\.mp4(\?|$)/i.test(url) ||
          /mpegurl|video\/mp4|application\/dash\+xml|octet-stream.*\.(ts|m3u8)/i.test(contentType);
        const looksLikeSubtitle = /\.vtt(\?|$)|\.srt(\?|$)|\.ass(\?|$)/i.test(url) || /text\/vtt/i.test(contentType);
        if (looksLikeVideo) videoHits.push(url);
        if (looksLikeSubtitle) subtitleHits.push(url);
      };
      page.on('response', onResponse);

      await gotoWithRetry(page, targetUrl);

      const clickedServerButton = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('a, button')).find((el) =>
          /server/i.test((el.textContent || '').trim())
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clickedServerButton) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // Many embed players wait for an actual user gesture (a click)
      // before they start fetching video — headless Puppeteer never
      // generates one on its own, so the player can just sit idle and
      // never issue the request we're listening for. This is very likely
      // why stream_url kept coming back as only the embed page URL. Click
      // the iframe's on-page position: a real mouse event lands inside it
      // even cross-origin, since it doesn't need to reach into the
      // iframe's DOM the way page.evaluate would. Try it a few times,
      // since some players need a first click just to unmute/dismiss an
      // overlay before a second click actually starts playback.
      for (let attempt = 0; attempt < 3; attempt++) {
        const box = await page
          .$eval('iframe', (el) => {
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })
          .catch(() => null);
        if (box) await page.mouse.click(box.x, box.y);

        // Also try triggering playback directly inside the iframe's own
        // frame content — more reliable than a blind coordinate click when
        // the frame isn't sandboxed against being scripted from outside.
        const iframeSrc = await page.$eval('iframe', (el) => el.getAttribute('src')).catch(() => null);
        if (iframeSrc) {
          const frame = page.frames().find((f) => f.url() === iframeSrc || f.url().startsWith(iframeSrc.split('?')[0]));
          if (frame) {
            await frame
              .evaluate(() => {
                const v = document.querySelector('video');
                if (v) {
                  v.muted = true;
                  v.play?.().catch(() => {});
                } else {
                  const playBtn = Array.from(document.querySelectorAll('button, div, a')).find((el) =>
                    /play/i.test(el.className || '') || /play/i.test(el.getAttribute('aria-label') || '')
                  );
                  playBtn?.click();
                }
              })
              .catch(() => {});
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (videoHits.length) break;
      }

      page.off('response', onResponse);
      return {
        video: videoHits.length ? videoHits[videoHits.length - 1] : null,
        subtitle: subtitleHits.length ? subtitleHits[subtitleHits.length - 1] : null
      };
    });
    videoUrl = result.video;
    subtitleUrl = result.subtitle;

    if (!videoUrl) {
      console.warn(`⚠️  Dramacool: no video request caught on ${targetUrl} even after simulating clicks and stealth patches — this mirror likely actively detects automated browsers (confirmed directly elsewhere on this site's mirrors) or loads video through a mechanism with no interceptable direct file URL. embed_url is the fallback and needs to be rendered in a WebView/iframe.`);
    }
    if (!subtitleUrl) {
      console.warn(`⚠️  Dramacool: no subtitle request caught on ${targetUrl} — this mirror may hardsub (burn subtitles into the video) or load subtitles some other way.`);
    }
  } catch (error) {
    console.error('❌ Error Dramacool Stream (browser):', error.message);
  }

  // Prefer the real media URL when we managed to catch one; fall back to
  // the embed page URL (still usable if the caller loads it in a WebView/
  // iframe rather than a native player).
  return {
    episode_slug: episodeSlug,
    stream_url: videoUrl || embedUrl,
    embed_url: embedUrl,
    subtitle_url: subtitleUrl
  };
}

module.exports = { getLatestKDrama, getPopularKDrama, searchKDrama, getKDramaDetail, getKDramaStream };