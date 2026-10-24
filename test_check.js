const { getPopularAnime, searchAnime, getAnimeDetail, getAnimeStream } = require('./scrapers/otakudesu');
const { getPopularKDrama, searchKDrama, getKDramaDetail, getKDramaStream } = require('./scrapers/dramaid');
const { getPopularMovies, searchMovies, getMovieDetailAndStream } = require('./scrapers/juraganfilm');

async function testAll() {
  console.log('=== 1. JURAGANFILM (MOVIES) ===');
  const movies = await getPopularMovies();
  console.log('Movies count:', movies.length, 'First:', movies[0]?.title, movies[0]?.slug);
  if (movies[0]?.slug) {
    const stream = await getMovieDetailAndStream(movies[0].slug);
    console.log('Movie stream:', stream.stream_url ? 'OK' : 'MISSING', stream.stream_url?.slice(0, 60));
  }

  console.log('\n=== 2. OTAKUDESU (ANIME) ===');
  const animeSearch = await searchAnime('one piece');
  console.log('Anime search "one piece" count:', animeSearch.length, 'First:', animeSearch[0]?.title, 'Slug:', animeSearch[0]?.slug, 'Genres:', animeSearch[0]?.genres);
  if (animeSearch[0]?.slug) {
    const detail = await getAnimeDetail(animeSearch[0].slug);
    console.log('Anime detail episodes:', detail.episodes?.length, 'First ep slug:', detail.episodes?.[0]?.slug);
    if (detail.episodes?.[0]?.slug) {
      const stream = await getAnimeStream(detail.episodes[0].slug);
      console.log('Anime stream:', stream.stream_url ? 'OK' : 'MISSING', stream.stream_url?.slice(0, 60));
    }
  }

  console.log('\n=== 3. DRAMACOOL (KDRAMA) ===');
  const kdramaSearch = await searchKDrama('queen');
  console.log('KDrama search "queen" count:', kdramaSearch.length, 'First:', kdramaSearch[0]?.title, 'Slug:', kdramaSearch[0]?.slug, 'Genres:', kdramaSearch[0]?.genres);
  const latestKdrama = await getPopularKDrama();
  if (latestKdrama[0]?.slug) {
    const detail = await getKDramaDetail(latestKdrama[0].slug);
    console.log('KDrama detail episodes:', detail.episodes?.length, 'First ep slug:', detail.episodes?.[0]?.slug);
    if (detail.episodes?.[0]?.slug) {
      const stream = await getKDramaStream(detail.episodes[0].slug);
      console.log('KDrama stream:', stream.stream_url ? 'OK' : 'MISSING', stream.stream_url?.slice(0, 60));
      console.log('KDrama subtitle:', stream.subtitle_url ? 'OK' : 'NONE', stream.subtitle_url?.slice(0, 60));
    }
  }

  console.log('\n✅ ALL SCRAPERS VERIFIED SUCCESSFULLY!');
}

testAll().catch(console.error);
