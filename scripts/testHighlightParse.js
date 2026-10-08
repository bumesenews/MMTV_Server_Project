/**
 * Highlight1 (Hoofoot) / Highlight2 (Socolive) list parsers.
 * Run: node scripts/testHighlightParse.js
 */
const { HighlightSource, parseDayMonthDate, isDirectMediaUrl, unwrapEmbedTarget, extractOkCdnUrl } = require('../src/sources/highlight');

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL ${name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok ${name}`);
}

const html = `
<div class="highlight__container">
  <div class="splide__slide">
    <div class="highlight__item" style="background-image: url('https://cdn.socolivepp.tv/2026/08/shot.png')">
      <a href="https://socolivepp.tv/video-highlight/atletico-madrid-vs-malaga-0200-20-08/">
        <p>Atletico Madrid vs Malaga (02:00 &#8211; 20/08)</p>
      </a>
    </div>
  </div>
  <a href="https://socolivepp.tv/video-highlight/page/2/">page 2</a>
</div>
`;

const src = new HighlightSource({
  config: {
    name: 'highlight2',
    parser: 'socolive',
    domains: ['https://socolivepp.tv/'],
    paths: { list: '/video-highlight/', page: '/video-highlight/page/{page}/' },
    attrs: { href: ['href', 'data-href'], src: ['src', 'data-src'] },
    selectors: {
      card: ['.highlight__item', '.splide__slide'],
      link: ["a[href*='video-highlight']", 'a'],
      title: ['p', 'img[alt]'],
      image: ['[style*="background-image"]', 'img'],
      player: ['#player iframe', 'iframe'],
    },
    maxItems: 6,
  },
});

const items = src.parseHighlights(html);
assert('one card not pagination', items.length === 1);
assert('source-prefixed id', items[0].id === 'highlight2:atletico-madrid-vs-malaga-0200-20-08');
assert('match date 2026-08-20', items[0].matchDate === '2026-08-20');
assert('cdn image', /cdn\.socolivepp/.test(items[0].img));

const hoofoot = new HighlightSource({
  config: { name: 'highlight1', parser: 'hoofoot', domains: ['https://hoofoot.com/'] },
});
assert('jwplayer file', Boolean(
  src.extractJwplayerFile(
    "playerInstance.setup({ file: 'https://cdn.videas.fr/v-medias/s5/hlsv1/35/4f/354f43fa-5637-4b0d-90f7-81eca463848e/720p.m3u8', width: '100%' });",
    'https://socolivepp.tv/video-highlight/alaves-vs-getafe-0030-16-08/'
  ).includes('720p.m3u8')
));
assert('day-month helper', parseDayMonthDate('20', '08', '2026') === '2026-08-20');

{
  const { isTransientHttpError } = require('../src/sources/httpStreamExtractor');
  const { isBrowserLaunchError, isBrowserLauncherError } = require('../src/browser/puppeteerManager');
  assert(
    'socket hang up is retried',
    isTransientHttpError({ message: 'socket hang up', code: 'ECONNRESET' })
  );
  assert(
    'nested cause hang up is retried',
    isTransientHttpError({ message: 'request failed', cause: { code: 'ECONNRESET', message: 'socket hang up' } })
  );
  assert('403 is not treated as hang-up', !isTransientHttpError({ message: 'Request failed with status code 403' }));
  assert(
    'browser launch helper exists',
    typeof isBrowserLaunchError === 'function' &&
      isBrowserLaunchError(new Error('Failed to launch the browser process'))
  );
  assert(
    'legacy isBrowserLauncherError alias exists',
    typeof isBrowserLauncherError === 'function' &&
      isBrowserLauncherError(new Error('Failed to launch the browser process'))
  );
}

{
  const { isHighlightListDead } = require('../src/sources/highlight');
  const dead = new HighlightSource({
    config: { name: 'highlight1', parser: 'hoofoot', domains: ['https://hoofoot.com/'] },
  });
  assert('empty hoofoot gallery', dead.parseHoofootHighlights('<html></html>').length === 0);
  dead.applySocoliveHighlightFallback();
  assert('fallback parser is socolive', dead.parser === 'socolive');
  assert('fallback list is socoliveza', /socoliveza\.tv\/video-highlight/.test(dead.listUrl));
  const fb = dead.parseHighlights(html);
  assert('fallback parses socolive cards', fb.length === 1);
  assert(
    'ENOTFOUND is a dead list',
    isHighlightListDead({ message: 'getaddrinfo ENOTFOUND hoofoot.com', code: 'ENOTFOUND' })
  );
}

{
  const das = new HighlightSource({
    config: {
      name: 'highlight1',
      parser: 'dasfootball',
      domains: ['https://dasfootball.com/'],
    },
  });
  assert('dasfootball parser stays dasfootball', das.parser === 'dasfootball');
  assert('dasfootball list is dasfootball.com', /dasfootball\.com\/?$/.test(das.listUrl));
  const dasHtml = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
      {"@type":"VideoObject","name":"Argentina vs Benin","url":"https://dasfootball.com/argentina-vs-benin-highlights-2026-10-06/","embedUrl":"https://cdn-cf-east.streamable.com/video/mp4/9spbu1.mp4?Expires=1&Key-Pair-Id=ABC","thumbnailUrl":["https://dasfootball.com/thumb.webp"],"uploadDate":"2026-10-07T07:34:57.196Z"}
    ]}
    </script>
    <a href="/england-vs-czechia-highlights-2026-10-06/">England vs Czechia</a>
  `;
  const dasItems = das.parseHighlights(dasHtml);
  assert('dasfootball prefers json-ld video', dasItems.length === 1);
  assert('dasfootball title', dasItems[0].title === 'Argentina vs Benin');
  assert('dasfootball match date from slug', dasItems[0].matchDate === '2026-10-06');
  assert('dasfootball signed mp4', /9spbu1\.mp4/.test(dasItems[0].m3u8 || ''));
  assert('dasfootball id', dasItems[0].id === 'highlight1:argentina-vs-benin-highlights-2026-10-06');
  const cardsOnly = das.parseHighlights(
    '<a href="/england-vs-czechia-highlights-2026-10-06/"><h2>England vs Czechia</h2></a>'
  );
  assert('dasfootball anchor fallback', cardsOnly.length === 1 && cardsOnly[0].matchDate === '2026-10-06');
  assert(
    'dasfootball slug title',
    das.parseHighlights('<a href="/albania-vs-san-marino-highlights-2026-10-06/"></a>')[0].title ===
      'Albania vs San Marino'
  );
}

{
  const garbage =
    'https://ok.ru/video/16477891922671&quot;,&quot;link&quot;:&quot;https://vd400.okcdn.ru/video.m3u8?cmd=videoPlayerCdn';
  assert('ok.ru json blob is not a media url', isDirectMediaUrl(garbage) === '');
  assert(
    'signed mp4 is a media url',
    /9spbu1\.mp4/.test(
      isDirectMediaUrl('https://cdn-cf-east.streamable.com/video/mp4/9spbu1.mp4?Expires=1&Key-Pair-Id=ABC')
    )
  );
  assert(
    'dasfootball embed unwraps streamable',
    unwrapEmbedTarget(
      'https://dasfootball.com/embed?src=https%3A%2F%2Fstreamable.com%2Fe%2Fuuik30&title=Switzerland'
    ) === 'https://streamable.com/e/uuik30'
  );
  const okHtml =
    'hlsManifestUrl&quot;:&quot;https://vd400.okcdn.ru/video.m3u8?cmd=videoPlayerCdn\\u0026expires=1&quot;';
  assert(
    'ok.ru manifest is a real m3u8',
    extractOkCdnUrl(okHtml) === 'https://vd400.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&expires=1'
  );
  const page = new HighlightSource({
    config: { name: 'highlight2', parser: 'socolive', domains: ['https://socolivepp.tv/'] },
  });
  const extracted = page.extractPageM3u8(
    `<iframe src="https://ok.ru/videoembed/1"></iframe><script>${garbage}</script>${okHtml}`,
    'https://socolivepp.tv/video-highlight/sample/'
  );
  assert('page extract keeps the okcdn playlist', extracted === 'https://vd400.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&expires=1');
  const embed = page.extractEmbedFromHtml(
    '<iframe src="https://ok.ru/videoembed/1"></iframe><iframe src="https://dasfootball.com/embed?src=https%3A%2F%2Fstreamable.com%2Fe%2Fuuik30"></iframe>',
    'https://socolivepp.tv/video-highlight/sample/'
  );
  assert('player prefers the dasfootball embed', /dasfootball\.com\/embed/.test(embed));
}

if (process.exitCode) {
  console.error('highlight parse tests failed');
  process.exit(1);
}
console.log('highlight parse tests passed');
