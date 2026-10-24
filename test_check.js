const assert = require('assert');
const { getLatestMovies, getMovieDetailAndStream } = require('./scrapers/juraganfilm');
const { getLatestAnime, getAnimeDetail } = require('./scrapers/otakudesu');
const { getLatestKDrama, getKDramaDetail } = require('./scrapers/dramaid');

async function runSelfCheck() {
  console.log('🧪 Menjalankan self-check backend scraper FlixyGo...');

  // 1. Check Movies (JuraganFilm)
  console.log('1. Memeriksa Scraper Film (JuraganFilm)...');
  const movies = await getLatestMovies();
  assert(Array.isArray(movies) && movies.length > 0, 'getLatestMovies harus mengembalikan array tidak kosong');
  const sampleMovie = movies[0];
  assert(sampleMovie.slug && sampleMovie.title, 'Item film harus memiliki slug dan title');
  console.log(`   ✓ getLatestMovies: ${movies.length} film ditemukan (${sampleMovie.title})`);

  const movieDetail = await getMovieDetailAndStream(sampleMovie.slug);
  assert(movieDetail.title, 'Detail film harus memiliki title');
  assert(movieDetail.stream_url || movieDetail.embed_url, 'Film harus memiliki stream_url atau embed_url');
  console.log(`   ✓ getMovieDetailAndStream: stream_url=${movieDetail.stream_url ? 'OK' : 'null'}, embed_url=${movieDetail.embed_url ? 'OK' : 'null'}`);

  // 2. Check Anime (Otakudesu)
  console.log('2. Memeriksa Scraper Anime (Otakudesu)...');
  const anime = await getLatestAnime();
  assert(Array.isArray(anime) && anime.length > 0, 'getLatestAnime harus mengembalikan array tidak kosong');
  console.log(`   ✓ getLatestAnime: ${anime.length} anime ditemukan (${anime[0].title})`);

  const animeDetail = await getAnimeDetail(anime[0].slug);
  assert(animeDetail.title && Array.isArray(animeDetail.episodes), 'Detail anime harus memiliki episodes');
  console.log(`   ✓ getAnimeDetail: ${animeDetail.episodes.length} episode ditemukan`);

  // 3. Check KDrama (Dramacool)
  console.log('3. Memeriksa Scraper KDrama (Dramacool)...');
  const kdrama = await getLatestKDrama();
  assert(Array.isArray(kdrama) && kdrama.length > 0, 'getLatestKDrama harus mengembalikan array tidak kosong');
  console.log(`   ✓ getLatestKDrama: ${kdrama.length} kdrama ditemukan (${kdrama[0].title})`);

  const kdramaDetail = await getKDramaDetail(kdrama[0].slug);
  assert(kdramaDetail.title && Array.isArray(kdramaDetail.episodes), 'Detail kdrama harus memiliki episodes');
  console.log(`   ✓ getKDramaDetail: ${kdramaDetail.episodes.length} episode ditemukan`);

  console.log('\n🎉 SEMUA CHECK LULUS! Backend siap digunakan oleh FlixyGo.');
}

runSelfCheck().catch((err) => {
  console.error('❌ Self-check gagal:', err);
  process.exit(1);
});
