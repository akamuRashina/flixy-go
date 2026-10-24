const axios = require('axios');
const cheerio = require('cheerio');
const { withPage, gotoWithRetry } = require('./browserPool');

const BASE_URL = 'https://otakudesu.blog';
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': BASE_URL
};

// Genre isn't shown on the list/search cards themselves — only each
// anime's own detail page has it — so getting genre onto home/search
// results means fetching each item's page. Cache by slug (genre never
// changes for a given anime) so repeated home-page loads don't re-fetch
// the same anime over and over.
const genreCache = new Map(); // slug -> { data, expires }
const GENRE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Lean genre-only extractor, reused by both the full detail endpoint and
// list enrichment — the same paragraph-position approach as the synopsis
// boundary (see getAnimeDetail below), without the extra synopsis work
// list enrichment doesn't need.
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
      const slug = href ? href.split('/anime/')[1]?.replace('/', '') : '';

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
      const slug = href ? href.split('/anime/')[1]?.replace('/', '') : '';

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

    $('.chlist li, .ulannim li, .venz li').each((_, el) => {
      const title = $(el).find('h2 a, a').first().text().trim();
      const href = $(el).find('a').attr('href');
      const poster = $(el).find('img').attr('src') || '';
      const slug = href ? href.split('/anime/')[1]?.replace('/', '') : '';

      if (slug && title) {
        list.push({ title, poster, slug, type: 'anime' });
      }
    });
    return await enrichWithGenres(list);
  } catch (error) {
    console.error('❌ Error Otakudesu Search:', error.message);
    return [];
  }
}

// 4. Detail Anime
async function getAnimeDetail(slug) {
  try {
    // Bersihkan slug dari slash atau karakter tak terpakai
    const cleanSlug = slug.replace(/^\/|\/$/g, '');
    const targetUrl = `${BASE_URL}/anime/${cleanSlug}/`;
    console.log(`🔍 [Otakudesu Fetching Detail]: ${targetUrl}`);

    const { data } = await axios.get(targetUrl, { headers });
    const $ = cheerio.load(data);

    // Selector fleksibel untuk judul
    const title = $('.fotoanime .infozin p').first().text().split(':')[1]?.trim() 
                  || $('.entry-title').text().trim() 
                  || 'Judul Tidak Ditemukan';

    // og:image reliably points at the real poster on this site (confirmed
    // against live pages, no site-logo-fallback trap like dramacool has).
    const poster = $('meta[property="og:image"]').attr('content')
                  || $('.fotoanime img').attr('src')
                  || $('.infozin img').attr('src')
                  || '';

    // `.sinopsc` never matches anything real on this theme (confirmed
    // against live HTML) and og:description is generic site boilerplate
    // repeated on every anime page here, NOT the actual story synopsis.
    // The real synopsis has no reliably-guessable class, but it always
    // sits as a run of plain <p> tags right after the "Genre: ..." info
    // line and before the next section (Batch/Episode List) — walk
    // paragraphs in DOM order and grab that run instead.
    const paragraphs = $('p').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const genreIdx = paragraphs.findIndex((t) => /^Genre\s*:/i.test(t));

    // The "Genre : Action, Adventure, ..." line is the same paragraph we
    // locate above as the synopsis boundary — split it on the colon, then
    // on commas, to get the individual genre names.
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
        if (/^\(Info:/i.test(t)) continue; // skip the "episodes added periodically" note
        synParas.push(t);
      }
      synopsis = synParas.join(' ').trim();
    }
    if (!synopsis) {
      // Last-resort fallback in case a different theme variant does use a
      // dedicated class.
      synopsis = $('.sinopc, .sinopsc, .entry-content').first().text().trim();
    }

    const episodes = [];
    $('.episodelist ul li').each((_, el) => {
      const aTag = $(el).find('a').first();
      const epTitle = aTag.text().trim();
      const epHref = aTag.attr('href') || '';
      
      if (epHref) {
        // Ambil slug episode dari URL
        const epSlug = epHref.split('/episode/')[1]?.replace(/\//g, '') || extractSlug(epHref);
        const epNum = parseInt(epTitle.match(/\d+/)?.[0] || '1');
        
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
//
// IMPORTANT: the iframe src the static HTML exposes (e.g.
// desustream.info/dstream/.../index.php?id=...) is NOT a raw video file —
// fetching it directly returns a JS-driven player *page* ("Memuat video…"
// while it loads), which is exactly why it opened as a webpage instead of
// playing in a video player. To get something a native player can actually
// use, we drive a real browser (shared Puppeteer pool) to load that player
// page and sniff the network for the .m3u8/.mp4 request it makes once
// running, rather than just handing back the wrapper page's own URL.
//
// This also still returns:
//   - `qualities`: per-resolution streams captured by clicking through the
//     "Mirror <quality>" tabs, same network-sniffing approach applied to
//     each one. If the browser step fails outright (navigation timeout,
//     site blocking automated traffic, etc.) this comes back empty and
//     `stream_url` falls back to the plain static iframe URL, so the
//     endpoint still returns something instead of erroring out.
async function getAnimeStream(episodeSlug, requestedQuality) {
  const targetUrl = `${BASE_URL}/episode/${episodeSlug}/`;

  // Grab the default iframe src straight off the static HTML — this is the
  // same wrapper-page URL the old code returned as stream_url. It's not a
  // real playable file (see the big comment above), but it's a cheap,
  // reliable fallback so that if the browser step below fails entirely
  // (navigation timeout, crash, etc.) we still return *something* in
  // stream_url instead of null.
  let staticEmbedFallback = null;
  try {
    const { data } = await axios.get(targetUrl, { headers });
    const $ = cheerio.load(data);
    staticEmbedFallback = $('#embed_holder iframe, .responsive-embed-stream iframe').attr('src') || null;
  } catch (error) {
    console.error('❌ Error Otakudesu Stream (static):', error.message);
  }

  let defaultEmbed = null;
  let defaultVideo = null;
  let defaultSubtitle = null;
  let qualities = [];

  // Many embed players wait for an actual user gesture before they start
  // fetching video — headless Puppeteer never generates one on its own, so
  // without this the player can sit idle and never issue the request
  // we're listening for. A real mouse click on the iframe's on-page
  // position lands inside it even cross-origin, unlike page.evaluate which
  // can't reach into a cross-origin iframe's DOM.
  async function clickIframeAndWait(page, videoHits) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const box = await page
        .$eval('#embed_holder iframe, .responsive-embed-stream iframe, iframe', (el) => {
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })
        .catch(() => null);
      if (box) await page.mouse.click(box.x, box.y);

      // Also try triggering playback directly inside the iframe's own
      // frame content — more reliable than a blind coordinate click when
      // the frame isn't sandboxed against being scripted from outside,
      // and doesn't depend on the click landing in the right spot.
      const iframeSrc = await page
        .$eval('#embed_holder iframe, .responsive-embed-stream iframe, iframe', (el) => el.getAttribute('src'))
        .catch(() => null);
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
  }

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
      await clickIframeAndWait(page, videoHits);

      const embedUrl = await page
        .$eval('#embed_holder iframe, .responsive-embed-stream iframe', (el) => el.getAttribute('src'))
        .catch(() => null);
      const videoUrl = videoHits.length ? videoHits[videoHits.length - 1] : null;
      const subtitleUrl = subtitleHits.length ? subtitleHits[subtitleHits.length - 1] : null;
      videoHits.length = 0;
      subtitleHits.length = 0;

      // Find each "Mirror <quality>" label in the page — searching text
      // nodes directly via TreeWalker instead of requiring the label to be
      // a childless element (the previous approach), since that fails if
      // the theme wraps the label text in even one extra <span>/icon and
      // was likely why quality-switching wasn't finding anything to click.
      const tabLabels = await page.evaluate(() => {
        const found = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const text = (node.textContent || '').trim();
          if (/^Mirror\s+\d+p$/i.test(text)) found.push(text);
        }
        return found;
      });

      const mirrors = [];
      for (const tabLabel of tabLabels) {
        const qualityMatch = tabLabel.match(/\d+p/i);
        if (!qualityMatch) continue;
        const quality = qualityMatch[0].toLowerCase();

        const clickedServer = await page.evaluate((label) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let labelEl = null;
          let node;
          while ((node = walker.nextNode())) {
            if ((node.textContent || '').trim() === label) {
              labelEl = node.parentElement;
              break;
            }
          }
          if (!labelEl) return null;

          // The server list (filedon/vidhide/mega/...) is usually the next
          // element after the label, but themes vary — walk forward through
          // siblings first, then fall back to the nearest list inside the
          // shared container.
          let list = labelEl.nextElementSibling;
          let hops = 0;
          while (list && list.tagName !== 'UL' && list.tagName !== 'OL' && hops < 5) {
            list = list.nextElementSibling;
            hops++;
          }
          if (!list) {
            const container = labelEl.closest('div, section') || labelEl.parentElement;
            list = container ? container.querySelector('ul, ol') : null;
          }
          const link = list ? list.querySelector('a') : null;
          if (!link) return null;
          link.click();
          return link.textContent.trim();
        }, tabLabel);

        if (!clickedServer) continue;

        await new Promise((resolve) => setTimeout(resolve, 1000));
        // Clicking the server link swaps in a new iframe, which may again
        // need a user gesture before it actually requests video.
        await clickIframeAndWait(page, videoHits);

        const mirrorEmbed = await page
          .$eval('#embed_holder iframe, .responsive-embed-stream iframe', (el) => el.getAttribute('src'))
          .catch(() => null);
        const mirrorVideo = videoHits.length ? videoHits[videoHits.length - 1] : null;
        const mirrorSubtitle = subtitleHits.length ? subtitleHits[subtitleHits.length - 1] : null;
        videoHits.length = 0;
        subtitleHits.length = 0;

        if (mirrorEmbed || mirrorVideo) {
          mirrors.push({
            quality,
            server: clickedServer,
            stream_url: mirrorVideo || mirrorEmbed,
            embed_url: mirrorEmbed,
            subtitle_url: mirrorSubtitle || null
          });
        }
      }

      page.off('response', onResponse);
      return { embedUrl, videoUrl, subtitleUrl, mirrors, tabLabelsFound: tabLabels.length };
    });

    defaultEmbed = result.embedUrl;
    defaultVideo = result.videoUrl;
    defaultSubtitle = result.subtitleUrl;
    qualities = result.mirrors;

    if (!result.tabLabelsFound) {
      console.warn(`⚠️  Otakudesu: no "Mirror <quality>" tabs found on ${targetUrl} — the theme's markup may not match what the scraper looks for. stream_url will only reflect the default mirror.`);
    } else if (!qualities.length) {
      console.warn(`⚠️  Otakudesu: found ${result.tabLabelsFound} quality tab(s) on ${targetUrl} but couldn't click through any of them — check the server list markup near those tabs.`);
    } else if (qualities.every((q) => q.stream_url === q.embed_url)) {
      console.warn(`⚠️  Otakudesu: found ${qualities.length} quality tab(s) on ${targetUrl} but none resolved to an actual video request — every entry fell back to its embed page URL. These mirrors likely detect automated/headless browsers (confirmed directly on other mirrors used by this codebase) and won't serve real video without deeper stealth or a genuine user-driven WebView.`);
    }
  } catch (error) {
    console.error('❌ Error Otakudesu Stream (browser):', error.message);
  }

  // Default to whatever mirror loaded first (usually 360p). If the browser
  // step failed entirely (navigation timeout, crash, etc. — see the catch
  // above) defaultEmbed stays null, so fall back to the plain static iframe
  // src rather than leaving stream_url empty.
  let stream_url = defaultVideo || defaultEmbed || staticEmbedFallback;
  let embed_url = defaultEmbed || staticEmbedFallback;
  let subtitle_url = defaultSubtitle;

  // If a specific resolution was requested, use the matching entry from
  // the captured qualities instead — this is what actually makes picking
  // 720p return 720p rather than always falling back to the default mirror.
  if (requestedQuality) {
    const normalized = /p$/i.test(requestedQuality)
      ? requestedQuality.toLowerCase()
      : `${requestedQuality}p`.toLowerCase();
    const match = qualities.find((q) => q.quality === normalized);
    if (match) {
      stream_url = match.stream_url;
      embed_url = match.embed_url;
      subtitle_url = match.subtitle_url;
    } else {
      console.warn(
        `⚠️  Otakudesu: requested quality "${requestedQuality}" not found among captured qualities [${qualities.map((q) => q.quality).join(', ') || 'none'}] for ${targetUrl} — returning the default mirror instead.`
      );
    }
  }

  return {
    episode_slug: episodeSlug,
    stream_url,
    embed_url,
    subtitle_url,
    requested_quality: requestedQuality || null,
    qualities: qualities.length ? qualities : undefined
  };
}

module.exports = { getLatestAnime, getPopularAnime, searchAnime, getAnimeDetail, getAnimeStream };