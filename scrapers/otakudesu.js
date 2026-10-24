const axios = require('axios');
const cheerio = require('cheerio');
const { withPage, gotoWithRetry } = require('./browserpool');

const BASE_URL = 'https://otakudesu.blog';
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'id,en-US;q=0.9,en;q=0.8',
  'Referer': BASE_URL
};

// Genre isn't shown on the list cards themselves — only each
// anime's own detail page has it — so getting genre onto home
// results means fetching each item's page. Cache by slug (genre never
// changes for a given anime) so repeated home-page loads don't re-fetch
// the same anime over and over.
const genreCache = new Map(); // slug -> { data, expires }
const GENRE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function extractAnimeGenres($) {
  const paragraphs = $('p').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const genreIdx = paragraphs.findIndex((t) => /^Genre\s*:/i.test(t));
  return genreIdx !== -1
    ? paragraphs[genreIdx].split(':').slice(1).join(':').split(',').map((g) => g.trim()).filter(Boolean)
    : [];
}

async function fetchAnimeGenres(slug) {
  const cached = genreCache.get(slug);
  if (cached && cached.expires > Date.now()) return cached.data;

  let genres = [];
  try {
    const cleanSlug = slug.replace(/^\/|\/$/g, '');
    const { data } = await axios.get(`${BASE_URL}/anime/${cleanSlug}/`, { headers });
    genres = extractAnimeGenres(cheerio.load(data));
  } catch {
    // leave genres empty rather than failing the whole list
  }
  genreCache.set(slug, { data: genres, expires: Date.now() + GENRE_CACHE_TTL_MS });
  return genres;
}

async function enrichWithGenres(list) {
  const settled = await Promise.allSettled(
    list.map(async (item) => ({ ...item, genres: await fetchAnimeGenres(item.slug) }))
  );
  return settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { ...list[i], genres: [] }));
}

// 1. Anime Terbaru
async function getLatestAnime() {
  try {
    const { data } = await axios.get(BASE_URL, { headers });
    const $ = cheerio.load(data);
    const list = [];

    $('.venz ul li, .rlist .ven_ul li').each((_, el) => {
      const title = $(el).find('.jdlflm').text().trim();
      const poster = $(el).find('img').attr('src') || $(el).find('img').attr('data-src');
      const epText = $(el).find('.epz').text().trim();
      const href = $(el).find('a').attr('href');
      const slug = href ? href.split('/anime/')[1]?.replace(/\//g, '') : '';

      if (slug && title) {
        list.push({ title, poster, slug, type: 'anime', badge: epText || 'Anime' });
      }
    });
    return await enrichWithGenres(list);
  } catch (error) {
    console.error('❌ Error Otakudesu Latest:', error.message);
    return [];
  }
}

// 2. Anime Populer
async function getPopularAnime() {
  try {
    const { data } = await axios.get(BASE_URL, { headers });
    const $ = cheerio.load(data);
    const list = [];

    $('.series_gen li, .topten li, .rlist ul li').each((_, el) => {
      const title = $(el).find('a').text().trim();
      const href = $(el).find('a').attr('href');
      const poster = $(el).find('img').attr('src') || '';
      const slug = href ? href.split('/anime/')[1]?.replace(/\//g, '') : '';

      if (slug && title) {
        list.push({ title, poster, slug, type: 'anime', badge: 'Populer' });
      }
    });
    return await enrichWithGenres(list);
  } catch (error) {
    console.error('❌ Error Otakudesu Popular:', error.message);
    return [];
  }
}

// 3. Cari Anime
async function searchAnime(query) {
  try {
    const { data } = await axios.get(`${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=anime`, { headers });
    const $ = cheerio.load(data);
    const list = [];

    $('ul.chivsrc li, .chlist li, .ulannim li, .venz li').each((_, el) => {
      const a = $(el).find('h2 a, a').first();
      const title = a.text().trim() || $(el).find('h2').text().trim();
      const href = a.attr('href');
      const poster = $(el).find('img').attr('src') || '';
      const slug = href ? href.split('/anime/')[1]?.replace(/\//g, '') : '';

      // Check if genres are already in search result card
      const genreText = $(el).find('.set:contains("Genres")').text().replace(/Genres?\s*:/i, '').trim();
      const genres = genreText ? genreText.split(',').map((g) => g.trim()).filter(Boolean) : [];

      if (slug && title) {
        list.push({ title, poster, slug, type: 'anime', genres });
      }
    });

    if (list.length > 0 && list[0].genres && list[0].genres.length > 0) {
      return list;
    }
    return await enrichWithGenres(list);
  } catch (error) {
    console.error('❌ Error Otakudesu Search:', error.message);
    return [];
  }
}

// 4. Detail Anime
async function getAnimeDetail(slug) {
  try {
    const cleanSlug = slug.replace(/^\/|\/$/g, '');
    const targetUrl = `${BASE_URL}/anime/${cleanSlug}/`;
    console.log(`🔍 [Otakudesu Fetching Detail]: ${targetUrl}`);

    const { data } = await axios.get(targetUrl, { headers });
    const $ = cheerio.load(data);

    const title = $('.fotoanime .infozin p').first().text().split(':')[1]?.trim() 
                  || $('.entry-title').text().trim() 
                  || 'Judul Tidak Ditemukan';

    const poster = $('meta[property="og:image"]').attr('content')
                  || $('.fotoanime img').attr('src')
                  || $('.infozin img').attr('src')
                  || '';

    const paragraphs = $('p').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const genreIdx = paragraphs.findIndex((t) => /^Genre\s*:/i.test(t));

    const genres = genreIdx !== -1
      ? paragraphs[genreIdx].split(':').slice(1).join(':').split(',').map((g) => g.trim()).filter(Boolean)
      : [];
    genreCache.set(cleanSlug, { data: genres, expires: Date.now() + GENRE_CACHE_TTL_MS });

    let synopsis = '';
    if (genreIdx !== -1) {
      const synParas = [];
      for (let i = genreIdx + 1; i < paragraphs.length; i++) {
        const t = paragraphs[i];
        if (/batch|episode list|lengkap|bantuan|share|rekomendasi anime/i.test(t)) break;
        if (/^\(Info:/i.test(t)) continue;
        synParas.push(t);
      }
      synopsis = synParas.join(' ').trim();
    }
    if (!synopsis) {
      synopsis = $('.sinopc, .sinopsc, .entry-content').first().text().trim();
    }

    const episodes = [];
    $('.episodelist ul li').each((_, el) => {
      const aTag = $(el).find('a').first();
      const epTitle = aTag.text().trim();
      const epHref = aTag.attr('href') || '';
      
      if (epHref && epHref.includes('/episode/')) {
        const epSlug = epHref.split('/episode/')[1]?.replace(/\//g, '');
        const epNum = parseInt(epTitle.match(/\d+/)?.[0] || '1', 10);
        
        if (epSlug) {
          episodes.push({ number: epNum, title: epTitle, slug: epSlug });
        }
      }
    });

    return { title, poster, synopsis, genres, episodes: episodes.reverse() };
  } catch (error) {
    console.error(`❌ [Otakudesu Detail Error]: ${error.message}`);
    throw error;
  }
}

// 5. Stream Anime
async function getAnimeStream(episodeSlug, requestedQuality) {
  const targetUrl = `${BASE_URL}/episode/${episodeSlug}/`;

  let staticEmbedFallback = null;
  try {
    const { data } = await axios.get(targetUrl, { headers });
    const $ = cheerio.load(data);
    staticEmbedFallback = $('#embed_holder iframe, .responsive-embed-stream iframe').attr('src') || null;
  } catch (error) {
    console.error('❌ Error Otakudesu Stream (static):', error.message);
  }

  let defaultVideo = null;
  let defaultSubtitle = null;
  let qualities = [];

  // 1. Static MP4 extraction from default embed (e.g. desustream.net)
  if (staticEmbedFallback) {
    try {
      const embedRes = await axios.get(staticEmbedFallback, {
        headers: {
          'User-Agent': headers['User-Agent'],
          'Referer': targetUrl
        },
        timeout: 8000
      });
      const videoMatch = embedRes.data.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/i);
      if (videoMatch) {
        defaultVideo = videoMatch[1];
      }
    } catch {
      // ignore
    }
  }

  // 2. Headless Browser fallback if video isn't found statically
  if (!defaultVideo) {
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
            .$eval('#embed_holder iframe, .responsive-embed-stream iframe, iframe', (el) => {
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
        if (result.video) defaultVideo = result.video;
        if (result.subtitle) defaultSubtitle = result.subtitle;
      }
    } catch (error) {
      console.error('❌ Error Otakudesu Stream (browser):', error.message);
    }
  }

  const stream_url = defaultVideo || staticEmbedFallback;
  const embed_url = staticEmbedFallback;

  return {
    episode_slug: episodeSlug,
    stream_url,
    embed_url,
    subtitle_url: defaultSubtitle,
    requested_quality: requestedQuality || null,
    qualities: qualities.length ? qualities : undefined
  };
}

module.exports = { getLatestAnime, getPopularAnime, searchAnime, getAnimeDetail, getAnimeStream };
