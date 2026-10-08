function decodeEmbedText(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .trim();
}

/** A real playlist or file. Rejects OK.ru JSON that merely contains ".m3u8" later. */
function isDirectMediaUrl(value) {
  const text = decodeEmbedText(value);
  if (!text || text.length > 4000 || /["<>\s]/.test(text)) return '';
  try {
    const parsed = new URL(text);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    if (!/\.(?:m3u8|mp4)$/i.test(parsed.pathname)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function unwrapEmbedTarget(url) {
  const text = decodeEmbedText(url);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (/dasfootball\.com$/i.test(parsed.hostname)) {
      const src = parsed.searchParams.get('src');
      if (src) return unwrapEmbedTarget(src);
    }
  } catch {
    /* keep the raw text */
  }
  const streamable = text.match(/https?:\/\/streamable\.com\/(?:e|o)\/[a-z0-9]+/i);
  return streamable ? streamable[0] : text;
}

function extractOkCdnUrl(html) {
  const text = decodeEmbedText(html);
  const match =
    text.match(/hlsManifestUrl"\s*:\s*"(https:\/\/[^"]+)"/i) ||
    text.match(/https:\/\/[^"'\\\s<>]+?\.okcdn\.ru\/video\.m3u8\?[^"'\\\s<>]+/i);
  return isDirectMediaUrl(match ? match[1] || match[0] : '');
}

module.exports = {
  isDirectMediaUrl,
  unwrapEmbedTarget,
  extractOkCdnUrl,
};
