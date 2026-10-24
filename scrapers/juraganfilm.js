const axios = require('axios');
const cheerio = require('cheerio');

// juraganfilm mirrors rotate subdomains occasionally (tv48.juragan.film,
// tv53.juragan.film, etc). Dynamically resolve the active mirror from
// https://juragan.film if not specified via environment variable.
const DEFAULT_FALLBACK_URL = 'https://tv53.juragan.film';
let activeBaseUrl = process.env.JURAGANFILM_BASE_URL || null;

async function getBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  try {
    const res = await axios.get('https://juragan.film', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      maxRedirects: 5,
      timeout: 8000
    });
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || DEFAULT_FALLBACK_URL;
    activeBaseUrl = finalUrl.replace(/\/$/, '');
    return activeBaseUrl;
  } catch {
    activeBaseUrl = DEFAULT_FALLBACK_URL;
    return activeBaseUrl;
  }
}

function getHeaders(baseUrl) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': baseUrl
  };
}

// Movie detail pages are at /nonton-<slug>-sub-indo/ — TV series live under
// /film-seri/. Exclude SEO boilerplate like /nonton-film-online-gratis-subtitle-indonesia/.
function isMovieHref(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    if (/film-online-gratis/i.test(u.pathname)) return false;
    return /^\/nonton-[^/]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

function extractListFromHtml(html, badge, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !isMovieHref(href, baseUrl)) return;

    const key = href.split('?')[0];
    if (seen.has(key)) return;

    let img = $(el).find('img').first();
    if (!img.length) {
      const prevImg = $(el).prev('img');
      img = prevImg.length ? prevImg : $(el).parent().find('img').first();
    }

    const title = (img.attr('alt') || $(el).attr('title') || $(el).text() || '')
      .replace(/^Nonton (Film\s*)?/i, '')
      .replace(/\s*Sub Indo.*$/i, '')
      .trim();
    if (!title || /juraganfilm/i.test(title)) return;

    const poster = img.attr('src') || img.attr('data-src') || img.attr('data-litespeed-src') || null;
    const slug = new URL(key, baseUrl).pathname.replace(/^\/|\/$/g, '');

    seen.set(key, { title, poster, slug, type: 'movie', badge });
  });

  return Array.from(seen.values());
}

const genreCache = new Map();
const GENRE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function extractMovieGenres($) {
  let genreContainer = null;
  let smallestLen = Infinity;
  $('*').each((_, el) => {
    const text = $(el).text();
    if (text.includes('Genre:') && text.includes('Duration:') && text.length < smallestLen) {
      genreContainer = el;
      smallestLen = text.length;
    }
  });
  return genreContainer
    ? $(genreContainer)
        .find('a[href*="/kategori-film/"]')
        .map((_, a) => $(a).text().trim())
        .get()
        .filter(Boolean)
    : [];
}

async function fetchMovieGenres(slug, baseUrl, headers) {
  const cached = genreCache.get(slug);
  if (cached && cached.expires > Date.now()) return cached.data;

  let genres = [];
  try {
    const cleanSlug = slug.replace(/^\/|\/$/g, '');
    const { data } = await axios.get(`${baseUrl}/${cleanSlug}/`, { headers, timeout: 8000 });
    genres = extractMovieGenres(cheerio.load(data));
  } catch {
    // leave genres empty rather than failing the whole list
  }
  genreCache.set(slug, { data: genres, expires: Date.now() + GENRE_CACHE_TTL_MS });
  return genres;
}

async function enrichWithGenres(list, baseUrl, headers) {
  const settled = await Promise.allSettled(
    list.map(async (item) => ({ ...item, genres: await fetchMovieGenres(item.slug, baseUrl, headers) }))
  );
  return settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { ...list[i], genres: [] }));
}

// 1. Movie Terbaru
async function getLatestMovies() {
  try {
    const baseUrl = await getBaseUrl();
    const headers = getHeaders(baseUrl);
    const { data } = await axios.get(baseUrl, { headers, timeout: 10000 });
    const list = extractListFromHtml(data, 'Movie', baseUrl).slice(0, 20);
    return await enrichWithGenres(list, baseUrl, headers);
  } catch (error) {
    console.error('❌ Error JuraganFilm Latest:', error.message);
    activeBaseUrl = null; // reset cache to re-resolve on next attempt
    return [];
  }
}

// 2. Movie Populer
async function getPopularMovies() {
  try {
    const baseUrl = await getBaseUrl();
    const headers = getHeaders(baseUrl);
    const { data } = await axios.get(`${baseUrl}/kategori-film/box-office/`, { headers, timeout: 10000 });
    const list = extractListFromHtml(data, 'Populer', baseUrl).slice(0, 20);
    return await enrichWithGenres(list, baseUrl, headers);
  } catch (error) {
    console.error('❌ Error JuraganFilm Popular:', error.message);
    activeBaseUrl = null;
    return [];
  }
}

// 3. Cari Movie
async function searchMovies(query) {
  try {
    const baseUrl = await getBaseUrl();
    const headers = getHeaders(baseUrl);
    const { data } = await axios.get(`${baseUrl}/?s=${encodeURIComponent(query)}`, { headers, timeout: 10000 });
    const list = extractListFromHtml(data, undefined, baseUrl);
    return await enrichWithGenres(list, baseUrl, headers);
  } catch (error) {
    console.error('❌ Error JuraganFilm Search:', error.message);
    activeBaseUrl = null;
    return [];
  }
}

// 4. Detail & Stream Movie
async function getMovieDetailAndStream(slug) {
  try {
    const baseUrl = await getBaseUrl();
    const headers = getHeaders(baseUrl);
    const cleanSlug = slug.replace(/^\/|\/$/g, '');
    const movieUrl = `${baseUrl}/${cleanSlug}/`;
    const { data } = await axios.get(movieUrl, { headers, timeout: 10000 });
    const $ = cheerio.load(data);

    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const title = ogTitle
      .replace(/^Nonton\s*/i, '')
      .replace(/\s*Di Situs Nonton Film.*$/i, '')
      .trim();

    const poster = $('meta[property="og:image"]').attr('content') || '';

    let synopsis = '';
    $('em, i').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > synopsis.length) synopsis = text;
    });

    const bodyText = $('body').text();
    const isRemoved = /Video Tidak Tersedia|Dihapus/i.test(bodyText);

    const genres = extractMovieGenres($);
    genreCache.set(cleanSlug, { data: genres, expires: Date.now() + GENRE_CACHE_TTL_MS });

    // JuraganFilm embeds its player via an iframe at /embed/<id>/<post_id>/
    // Or legacy static iframe matching /file/?id=
    const rawIframeSrc = $('iframe[src*="/embed/"]').attr('src')
      || $('.gmr-embed-responsive iframe').attr('src')
      || $('#player-1 iframe').attr('src')
      || $('iframe[src*="/file/?id="]').attr('src')
      || $('iframe').attr('src')
      || $('iframe').attr('data-src')
      || $('iframe').attr('data-litespeed-src')
      || null;

    let streamUrl = null;
    let embedUrl = null;
    let qualities = [];

    if (rawIframeSrc && !isRemoved) {
      embedUrl = new URL(rawIframeSrc, baseUrl).href;
      try {
        const embedRes = await axios.get(embedUrl, {
          headers: {
            ...headers,
            'Referer': movieUrl
          },
          timeout: 8000
        });

        // The embed page includes an inline JS block defining `const SOURCES = [...]`
        // which contains direct playable video links (.mp4 / .m3u8).
        const match = embedRes.data.match(/const\s+SOURCES\s*=\s*(\[[\s\S]*?\]);/);
        if (match) {
          const sources = JSON.parse(match[1]);
          if (Array.isArray(sources) && sources.length > 0) {
            qualities = sources
              .filter((s) => s.link)
              .map((s) => ({
                quality: s.label || s.res || 'HD',
                server: s.serverLabel || s.server || 'Direct',
                stream_url: s.link,
                embed_url: embedUrl
              }));

            // Prioritize playable MP4 or HLS
            const preferred = sources.find((s) => s.type === 'mp4' && s.link) || sources.find((s) => s.link);
            if (preferred) {
              streamUrl = preferred.link;
            }
          }
        }
      } catch (embedError) {
        console.warn(`⚠️ [JuraganFilm] Embed parse warning for ${cleanSlug}:`, embedError.message);
      }

      // If direct video stream sniffing didn't resolve, fall back to embedUrl
      // so playback via WebView / iframe player always works.
      if (!streamUrl && embedUrl) {
        streamUrl = embedUrl;
      }
    }

    return {
      title,
      poster,
      synopsis,
      genres,
      episodes: [],
      stream_url: isRemoved ? null : streamUrl,
      embed_url: isRemoved ? null : embedUrl,
      qualities: isRemoved ? [] : qualities,
      unavailable: isRemoved
    };
  } catch (error) {
    console.error('❌ Error JuraganFilm Detail:', error.message);
    activeBaseUrl = null;
    throw error;
  }
}

module.exports = { getLatestMovies, getPopularMovies, searchMovies, getMovieDetailAndStream };
