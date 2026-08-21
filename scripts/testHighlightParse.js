/**
 * Highlight1 (Hoofoot) / Highlight2 (Socolive) list parsers.
 * Run: node scripts/testHighlightParse.js
 */
const { HighlightSource, parseDayMonthDate } = require('../src/sources/highlight');

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

if (process.exitCode) {
  console.error('highlight parse tests failed');
  process.exit(1);
}
console.log('highlight parse tests passed');
