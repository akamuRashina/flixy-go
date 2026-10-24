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
const EPISODE_LINK_RE = /\/([a-z0-9-]+)-episode-(\d+)[a-z0-9-]*\.html$/i;

// Given either an episode slug ("payback-2026-episode-9.html") or a series
// root slug ("payback-2026"), return the series root slug.
function toSeriesSlug(slug) {
  const clean = slug.replace(/^\/|\/$/g, '');
  const match = clean.match(/^(.+?)-episode-\d+/i);
  return match ? match[1] : clean;
}

function extractGenres($, bodyText) {
  if ($) {
    const genreP = $('p').filter((_, el) => /Genres?:/i.test($(el).text())).first();
    if (genreP.length) {
      const raw = genreP.text().replace(/Genres?:/i, '').trim();
      return raw.split(',').map((g) => g.trim()).filter((g) => g && g.length < 30);
    }
  }
  const genreMatch = (bodyText || '').match(/Genres?:\s*([A-Za-z, -]+?)(?=\s+[A-Z][a-zA-Z ]{2,20}:|$)/);
  return genreMatch ? genreMatch[1].split(',').map((g) => g.trim()).filter((g) => g && g.length < 30) : [];
}

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
    const genres = extractGenres($, $('body').text().replace(/\s+/g, ' ').trim());
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

  const container = $('.tab-recent-episode, main, .content-area').first();
  const scope = container.length ? container : $('body');

  scope.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !EPISODE_LINK_RE.test(href)) return;
    if (seen.has(href)) return;

    const title = ($(el).attr('title') || $(el).text() || '').trim();
    if (!title) return;

    const slug = href.split('/').filter(Boolean).pop();
    seen.set(href, { title, poster: null, slug, type: 'kdrama', badge });
  });

  return Array.from(seen.values());
}

// 1. KDrama Terbaru
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
    const list = [];
    const seen = new Set();

    $('main.site-main ul.box li, .switch-block ul.box li').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href');
      if (!href) return;
      const slug = href.replace(BASE_URL, '').replace(/^\/|\/$/g, '');
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('h3').text().trim() || a.attr('title') || slug;
      const poster = $(el).find('img').attr('data-original') || $(el).find('img').attr('src') || null;

      list.push({ title, poster, slug, type: 'kdrama', badge: 'Populer' });
    });

    return await enrichWithExtras(list.slice(0, 20));
  } catch (error) {
    console.error('❌ Error Dramacool Popular:', error.message);
    return [];
  }
}

// 3. Cari KDrama
async function searchKDrama(query) {
  try {
    const { data } = await axios.get(`${BASE_URL}/?s=${encodeURIComponent(query)}`, { headers });
    const $ = cheerio.load(data);
    const list = [];
    const seen = new Set();

    $('main.site-main ul.box li, .switch-block ul.box li').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href');
      if (!href) return;
      const slug = href.replace(BASE_URL, '').replace(/^\/|\/$/g, '');
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('h3').text().trim() || a.attr('title') || slug;
      const poster = $(el).find('img').attr('data-original') || $(el).find('img').attr('src') || null;

      list.push({ title, poster, slug, type: 'kdrama' });
    });

    if (list.length > 0) {
      return await enrichWithExtras(list.slice(0, 20));
    }

    return [];
  } catch (error) {
    console.error('❌ Error Dramacool Search:', error.message);
    return [];
  }
}

// 4. Detail KDrama
async function getKDramaDetail(slug) {
  try {
    const cleanSlug = toSeriesSlug(slug);
    const { data } = await axios.get(`${BASE_URL}/${cleanSlug}`, { headers });
    const $ = cheerio.load(data);

    const title = $('h1').first().text().replace(/English SUB.*$/i, '').trim();
    const ogImageWidth = parseInt($('meta[property="og:image:width"]').attr('content') || '0', 10);
    const poster = ogImageWidth >= 100
      ? ($('meta[property="og:image"]').attr('content') || '')
      : '';

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const synMatch = bodyText.match(
      /Synopsis:\s*(.*?)\s*(?:Also known as:|Country:|Status:|Release Year:|Genres:)/
    );
    const synopsis = synMatch
      ? synMatch[1].trim()
      : ($('meta[property="og:description"]').attr('content') || '');

    const genres = extractGenres($, bodyText);
    seriesExtrasCache.set(cleanSlug, { data: { poster, genres }, expires: Date.now() + SERIES_EXTRAS_CACHE_TTL_MS });

    const episodes = [];
    $('ul.list li a, .list-episode-item-2 li a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !EPISODE_LINK_RE.test(href)) return;
      const epSlug = href.split('/').filter(Boolean).pop();

      const match = href.match(EPISODE_LINK_RE);
      const epNum = parseInt(match[2], 10);
      if (!episodes.find((e) => e.slug === epSlug)) {
        episodes.push({ number: epNum, title: $(el).text().trim() || `Episode ${epNum}`, slug: epSlug });
      }
    });

    // Fallback if ul.list not found
    if (episodes.length === 0) {
      const baseParts = cleanSlug.split('-');
      const basePrefix = baseParts.length > 1 ? baseParts.slice(0, 2).join('-') : cleanSlug;
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || !EPISODE_LINK_RE.test(href)) return;
        const epSlug = href.split('/').filter(Boolean).pop();
        if (!epSlug.toLowerCase().includes(basePrefix.toLowerCase())) return;

        const match = href.match(EPISODE_LINK_RE);
        const epNum = parseInt(match[2], 10);
        if (!episodes.find((e) => e.slug === epSlug)) {
          episodes.push({ number: epNum, title: $(el).text().trim() || `Episode ${epNum}`, slug: epSlug });
        }
      });
    }

    episodes.sort((a, b) => a.number - b.number);

    return { title, poster, synopsis, genres, episodes };
  } catch (error) {
    console.error('❌ Error Dramacool Detail:', error.message);
    throw error;
  }
}

// 5. Stream KDrama
async function getKDramaStream(episodeSlug) {
  const cleanSlug = episodeSlug.replace(/^\//, '');
  const targetUrl = `${BASE_URL}/${cleanSlug}`;

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
          return false;
        }
      });
    }
  } catch (error) {
    console.error('❌ Error Dramacool Stream (static):', error.message);
  }

  let videoUrl = null;
  let subtitleUrl = null;

  if (embedUrl) {
    try {
      const playerRes = await axios.get(embedUrl, {
        headers: {
          'User-Agent': headers['User-Agent'],
          'Referer': BASE_URL
        },
        timeout: 8000
      });
      const $$ = cheerio.load(playerRes.data);
      const payloadText = $$('#player-payload').html();
      if (payloadText) {
        const payload = JSON.parse(payloadText);
        if (payload.source) videoUrl = payload.source;
        if (payload.tracks && payload.tracks.length) {
          const idSub = payload.tracks.find(t => /indonesia|id/i.test(t.label || ''));
          const enSub = payload.tracks.find(t => /english|en/i.test(t.label || ''));
          subtitleUrl = (idSub || enSub || payload.tracks[0])?.file || null;
        }
      } else {
        const match = playerRes.data.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/i);
        if (match) videoUrl = match[1];
      }
    } catch {
      // ignore
    }
  }

  if (!videoUrl) {
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

        for (let attempt = 0; attempt < 2; attempt++) {
          const box = await page
            .$eval('iframe', (el) => {
              el.scrollIntoView({ block: 'center' });
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })
            .catch(() => null);
          if (box) await page.mouse.click(box.x, box.y);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (videoHits.length) break;
        }

        page.off('response', onResponse);
        return {
          video: videoHits.length ? videoHits[videoHits.length - 1] : null,
          subtitle: subtitleHits.length ? subtitleHits[subtitleHits.length - 1] : null
        };
      });
      if (result) {
        if (result.video) videoUrl = result.video;
        if (result.subtitle) subtitleUrl = result.subtitle;
      }
    } catch {
      // browser fallback failed or puppeteer disabled
    }
  }

  return {
    episode_slug: episodeSlug,
    stream_url: videoUrl || embedUrl,
    embed_url: embedUrl,
    subtitle_url: subtitleUrl
  };
}

module.exports = { getLatestKDrama, getPopularKDrama, searchKDrama, getKDramaDetail, getKDramaStream };
