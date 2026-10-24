const express = require('express');
const cors = require('cors');

const {
  getLatestAnime,
  getPopularAnime,
  searchAnime,
  getAnimeDetail,
  getAnimeStream
} = require('./scrapers/otakudesu');

const {
  getLatestKDrama,
  getPopularKDrama,
  searchKDrama,
  getKDramaDetail,
  getKDramaStream
} = require('./scrapers/dramaid');

const {
  getLatestMovies,
  getPopularMovies,
  searchMovies,
  getMovieDetailAndStream
} = require('./scrapers/juraganfilm');

const { syncMovies, syncAnime, syncKDrama } = require('./syncSupabase');

const { closeBrowser: closeSharedBrowser } = require('./scrapers/browserpool');

const app = express();
app.use(cors());
app.use(express.json());

// Helper untuk menggabungkan & menyelang-selingkan list
function combineLists(list1, list2, list3) {
  const combined = [];
  const max = Math.max(list1.length, list2.length, list3.length);
  for (let i = 0; i < max; i++) {
    if (list1[i]) combined.push(list1[i]);
    if (list2[i]) combined.push(list2[i]);
    if (list3[i]) combined.push(list3[i]);
  }
  return combined;
}

// ================= 0. ENDPOINT ROOT / STATUS =================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 FlixyGo Scraper API is Live!',
    endpoints: {
      home: '/api/home',
      search: '/api/search?q=demon',
      movie_detail: '/api/movie/detail/:slug',
      movie_stream: '/api/movie/stream/:slug',
      anime_detail: '/api/anime/detail/:slug',
      anime_stream: '/api/anime/stream/:slug',
      kdrama_detail: '/api/kdrama/detail/:slug',
      kdrama_stream: '/api/kdrama/stream/:slug'
    }
  });
});

let homeCache = null;
let homeCacheExpiry = 0;
const HOME_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ================= 1. ENDPOINT HOME =================
app.get('/api/home', async (req, res) => {
  try {
    if (homeCache && Date.now() < homeCacheExpiry && !req.query.refresh) {
      return res.json({ success: true, data: homeCache, cached: true });
    }

    const [
      animeLatest, kdramaLatest, movieLatest,
      animePopular, kdramaPopular, moviePopular
    ] = await Promise.all([
      getLatestAnime(), getLatestKDrama(), getLatestMovies(),
      getPopularAnime(), getPopularKDrama(), getPopularMovies()
    ]);

    const feedData = {
      latest_all: combineLists(animeLatest, kdramaLatest, movieLatest).slice(0, 15),
      popular_all: combineLists(animePopular, kdramaPopular, moviePopular).slice(0, 15),
      anime: animeLatest.slice(0, 10),
      kdrama: kdramaLatest.slice(0, 10),
      movies: movieLatest.slice(0, 10)
    };

    homeCache = feedData;
    homeCacheExpiry = Date.now() + HOME_CACHE_TTL;

    res.json({
      success: true,
      data: feedData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 2. ENDPOINT PENCARIAN GLOBAL =================
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ success: false, message: 'Query parameter ?q= wajib diisi' });
    }

    const [anime, kdrama, movies] = await Promise.all([
      searchAnime(query),
      searchKDrama(query),
      searchMovies(query)
    ]);

    const allResults = [...anime, ...kdrama, ...movies];

    res.json({
      success: true,
      query,
      total_results: allResults.length,
      data: allResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 3. ENDPOINT DETAIL & STREAM =================

// Anime
app.get('/api/anime/detail/:slug', async (req, res) => {
  try {
    const data = await getAnimeDetail(req.params.slug);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/anime/stream/:slug', async (req, res) => {
  try {
    const data = await getAnimeStream(req.params.slug, req.query.quality);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// KDrama
app.get('/api/kdrama/detail/:slug', async (req, res) => {
  try {
    const data = await getKDramaDetail(req.params.slug);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/kdrama/stream/:slug', async (req, res) => {
  try {
    const data = await getKDramaStream(req.params.slug);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Movie
app.get('/api/movie/detail/:slug', async (req, res) => {
  try {
    const data = await getMovieDetailAndStream(req.params.slug);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/movie/stream/:slug', async (req, res) => {
  try {
    const data = await getMovieDetailAndStream(req.params.slug);
    res.json({
      success: true,
      data: {
        episode_slug: req.params.slug,
        stream_url: data.stream_url,
        embed_url: data.embed_url,
        qualities: data.qualities || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 4. ENDPOINT SYNC KE SUPABASE =================
app.all('/api/sync/movies', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || req.body?.limit || '10', 10);
    const data = await syncMovies(limit);
    res.json({ success: true, message: `Berhasil sinkronisasi ${data.length} film ke Supabase`, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.all('/api/sync/all', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || req.body?.limit || '10', 10);
    const [movies, anime, kdrama] = await Promise.all([
      syncMovies(limit),
      syncAnime(limit),
      syncKDrama(limit)
    ]);
    res.json({
      success: true,
      message: 'Berhasil sinkronisasi semua konten ke Supabase',
      synced: {
        movies: movies.length,
        anime: anime.anime.length,
        kdrama: kdrama.kdrama.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Port Server
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 FlixyGo Server running on http://localhost:${PORT}`);
  });
}

// Puppeteer keeps one shared browser instance alive across requests (see
// scrapers/browserPool.js) for performance — close it cleanly on shutdown.
if (!process.env.VERCEL) {
  process.on('SIGINT', async () => {
    await closeSharedBrowser();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeSharedBrowser();
    process.exit(0);
  });
}

module.exports = app;
