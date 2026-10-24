const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getLatestMovies, getMovieDetailAndStream } = require('./scrapers/juraganfilm');
const { getLatestAnime, getAnimeDetail } = require('./scrapers/otakudesu');
const { getLatestKDrama, getKDramaDetail } = require('./scrapers/dramaid');

// Resolve Supabase credentials from environment or flixygo/supabase-keys.json
function getSupabaseConfig() {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    const candidatePaths = [
      path.join(__dirname, '..', 'flixygo', 'supabase-keys.json'),
      path.join(__dirname, 'supabase-keys.json'),
      path.join(__dirname, '..', 'supabase-keys.json')
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
          url = url || raw.SUPABASE_URL || raw.supabaseUrl;
          key = key || raw.SUPABASE_SERVICE_ROLE_KEY || raw.SUPABASE_ANON_KEY || raw.supabaseAnonKey;
          if (url && key) break;
        } catch {}
      }
    }
  }

  return { url: (url || '').replace(/\/$/, ''), key };
}

async function upsertToSupabase(table, rows) {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) {
    throw new Error('Supabase URL atau Key belum dikonfigurasi di supabase-keys.json atau variabel lingkungan.');
  }

  // Use PostgREST upsert (merge duplicates based on primary key)
  const endpoint = `${url}/rest/v1/${table}`;
  const response = await axios.post(endpoint, rows, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    timeout: 15000
  });

  return response.status;
}

// 1. Sync Movies
async function syncMovies(limit = 10) {
  console.log(`🎬 Memulai sinkronisasi Film (JuraganFilm) ke Supabase (limit: ${limit})...`);
  const latest = await getLatestMovies();
  const targetList = latest.slice(0, limit);
  console.log(`Ditemukan ${targetList.length} film untuk diproses.`);

  const syncedMovies = [];
  for (const item of targetList) {
    try {
      console.log(`  -> Mengambil detail & stream: ${item.title} (${item.slug})...`);
      const detail = await getMovieDetailAndStream(item.slug);

      const movieRow = {
        slug: item.slug,
        title: detail.title || item.title,
        poster: detail.poster || item.poster || '',
        synopsis: detail.synopsis || '',
        badge: item.badge || 'Movie',
        genres: (detail.genres && detail.genres.length > 0) ? detail.genres : (item.genres || []),
        stream_url: detail.stream_url || null,
        embed_url: detail.embed_url || null,
        unavailable: !!detail.unavailable,
        updated_at: new Date().toISOString()
      };

      syncedMovies.push(movieRow);
      console.log(`     ✅ OK: stream_url=${movieRow.stream_url ? 'tersedia' : 'null'}, embed_url=${movieRow.embed_url ? 'tersedia' : 'null'}`);
    } catch (err) {
      console.warn(`     ⚠️ Gagal memproses ${item.slug}:`, err.message);
    }
  }

  if (syncedMovies.length > 0) {
    console.log(`Menyimpan ${syncedMovies.length} film ke tabel 'movies' di Supabase...`);
    await upsertToSupabase('movies', syncedMovies);
    console.log(`🎉 Berhasil menyinkronkan ${syncedMovies.length} film ke Supabase!`);
  }

  return syncedMovies;
}

// 2. Sync Anime
async function syncAnime(limit = 10) {
  console.log(`🎌 Memulai sinkronisasi Anime (Otakudesu) ke Supabase (limit: ${limit})...`);
  const latest = await getLatestAnime();
  const targetList = latest.slice(0, limit);

  const syncedAnime = [];
  const syncedEpisodes = [];

  for (const item of targetList) {
    try {
      console.log(`  -> Mengambil detail: ${item.title} (${item.slug})...`);
      const detail = await getAnimeDetail(item.slug);

      syncedAnime.push({
        slug: item.slug,
        title: detail.title || item.title,
        poster: detail.poster || item.poster || '',
        synopsis: detail.synopsis || '',
        badge: item.badge || 'Anime',
        genres: (detail.genres && detail.genres.length > 0) ? detail.genres : (item.genres || []),
        updated_at: new Date().toISOString()
      });

      if (detail.episodes && Array.isArray(detail.episodes)) {
        for (const ep of detail.episodes) {
          syncedEpisodes.push({
            slug: ep.slug,
            anime_slug: item.slug,
            number: ep.number || 1,
            title: ep.title || `Episode ${ep.number || 1}`,
            updated_at: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.warn(`     ⚠️ Gagal memproses ${item.slug}:`, err.message);
    }
  }

  if (syncedAnime.length > 0) {
    await upsertToSupabase('anime', syncedAnime);
    if (syncedEpisodes.length > 0) {
      await upsertToSupabase('anime_episodes', syncedEpisodes);
    }
    console.log(`🎉 Berhasil menyinkronkan ${syncedAnime.length} anime ke Supabase!`);
  }

  return { anime: syncedAnime, episodes: syncedEpisodes };
}

// 3. Sync KDrama
async function syncKDrama(limit = 10) {
  console.log(`🇰🇷 Memulai sinkronisasi KDrama (Dramacool) ke Supabase (limit: ${limit})...`);
  const latest = await getLatestKDrama();
  const targetList = latest.slice(0, limit);

  const syncedKDrama = [];
  const syncedEpisodes = [];

  for (const item of targetList) {
    try {
      console.log(`  -> Mengambil detail: ${item.title} (${item.slug})...`);
      const detail = await getKDramaDetail(item.slug);

      syncedKDrama.push({
        slug: item.slug,
        title: detail.title || item.title,
        poster: detail.poster || item.poster || '',
        synopsis: detail.synopsis || '',
        badge: item.badge || 'KDrama',
        genres: (detail.genres && detail.genres.length > 0) ? detail.genres : (item.genres || []),
        updated_at: new Date().toISOString()
      });

      if (detail.episodes && Array.isArray(detail.episodes)) {
        for (const ep of detail.episodes) {
          syncedEpisodes.push({
            slug: ep.slug,
            kdrama_slug: item.slug,
            number: ep.number || 1,
            title: ep.title || `Episode ${ep.number || 1}`,
            updated_at: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.warn(`     ⚠️ Gagal memproses ${item.slug}:`, err.message);
    }
  }

  if (syncedKDrama.length > 0) {
    await upsertToSupabase('kdrama', syncedKDrama);
    if (syncedEpisodes.length > 0) {
      await upsertToSupabase('kdrama_episodes', syncedEpisodes);
    }
    console.log(`🎉 Berhasil menyinkronkan ${syncedKDrama.length} kdrama ke Supabase!`);
  }

  return { kdrama: syncedKDrama, episodes: syncedEpisodes };
}

// If run directly via CLI: node syncSupabase.js
if (require.main === module) {
  const args = process.argv.slice(2);
  const type = args[0] || 'movies';

  (async () => {
    try {
      if (type === 'all') {
        await syncMovies(10);
        await syncAnime(10);
        await syncKDrama(10);
      } else if (type === 'anime') {
        await syncAnime(10);
      } else if (type === 'kdrama') {
        await syncKDrama(10);
      } else {
        await syncMovies(10);
      }
      console.log('✅ Selesai.');
    } catch (e) {
      console.error('❌ Gagal sinkronisasi:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  getSupabaseConfig,
  syncMovies,
  syncAnime,
  syncKDrama
};
