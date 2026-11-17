'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

/* ====================================================================== */
/* Configuration                                                          */
/* ====================================================================== */

const BASE_URL = (process.env.CINEFREAK_BASE_URL || 'https://cinefreak.net').replace(/\/+$/, '');
const BASE_HOST = new URL(BASE_URL).hostname.replace(/^www\./, '');
const ID_PREFIX = 'cf:';

const PAGE_LIMIT = 20;            // items returned per Stremio catalog page
const MAX_LISTING_PAGES = 8;      // max site pages fetched for one catalog request
const MAX_INTERSTITIALS = 6;      // max "download/watch" intermediate pages followed per stream request

const TTL = {
  listing: 10 * 60 * 1000,
  post: 30 * 60 * 1000,
  links: 15 * 60 * 1000
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Where each Stremio catalog reads from. Override with env vars in Vercel if the
// site has dedicated category pages (e.g. CF_MOVIES_PATH=/category/movies/).
// When the path is "/" (home page) items are split into movie/series by title heuristics.
const CATALOGS = {
  movie: {
    id: 'cinefreak-movies',
    name: 'CineFreak Movies',
    path: process.env.CF_MOVIES_PATH || '/',
    strict: !process.env.CF_MOVIES_PATH
  },
  series: {
    id: 'cinefreak-series',
    name: 'CineFreak Series',
    path: process.env.CF_SERIES_PATH || '/',
    strict: !process.env.CF_SERIES_PATH
  }
};

// All CSS selectors live here so they are easy to tune once you know the site's markup.
const SELECTORS = {
  // Containers that represent one post card on listing pages (tried in order).
  cards: ['article', '.post', '.post-item', '.item', '.movie-item', '.grid-item', 'li.post', '.card'],
  // Title link inside a card.
  cardTitleLink: 'h1 a, h2 a, h3 a, h4 a, h5 a, .entry-title a, .post-title a, .title a, .name a',
  // Post title on a single post page.
  postTitle: 'h1.entry-title, h1.post-title, .entry-header h1, article h1, h1',
  // Main content container on a single post page (tried in order).
  contentRoots: [
    '.entry-content', '.post-content', '.post-body', '.single-content',
    '.entry', 'article .content', 'article', 'main', '#content', '.content'
  ],
  // Elements stripped before scanning a post page for links.
  noise: [
    'script', 'style', 'noscript', '.sharedaddy', '.share', '.social', '.related',
    '.related-posts', '.yarpp-related', '.comments', '#comments', '.comment-respond',
    '.post-navigation', '.widget', '.sidebar', 'nav', 'footer'
  ].join(', '),
  // Genre-ish links.
  genreLinks: 'a[rel~="tag"], a[rel~="category"], .cat-links a, .genres a, .genre a'
};

/* ====================================================================== */
/* HTTP + cache                                                           */
/* ====================================================================== */

const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  responseType: 'text',
  decompress: true,
  validateStatus: (s) => s >= 200 && s < 400,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1'
  }
});

async function fetchHtml(url, referer = BASE_URL + '/') {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await http.get(url, {
        headers: { 'User-Agent': USER_AGENT, Referer: referer }
      });
      if (typeof res.data !== 'string' || !res.data.length) {
        throw new Error('Empty response from ' + url);
      }
      return res.data;
    } catch (err) {
      lastError = err;
      const status = err.response && err.response.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastError;
}

const cache = new Map();

function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = Promise.resolve().then(loader);
  cache.set(key, { promise, exp: Date.now() + ttl });
  promise.catch(() => {
    const current = cache.get(key);
    if (current && current.promise === promise) cache.delete(key);
  });
  if (cache.size > 400) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.exp <= now) cache.delete(k);
    }
    while (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return promise;
}

/* ====================================================================== */
/* Generic helpers                                                        */
/* ====================================================================== */

const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function absoluteUrl(href, base = BASE_URL + '/') {
  if (!href) return null;
  const h = String(href).trim();
  if (!h || /^(javascript:|mailto:|tel:|#|data:)/i.test(h)) return null;
  try {
    return new URL(h, base).href;
  } catch (e) {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

const sameSite = (url) => hostOf(url) === BASE_HOST;

const NON_POST_PATH =
  /^\/(?:category|tag|tags|author|page|wp-[^/]*|feed|search|genre|genres|year|country|quality|about|about-us|contact|contact-us|dmca|privacy-policy|disclaimer|request|faq|login|register|cdn-cgi)(?:\/|$)/i;

function isPostUrl(url) {
  if (!url || !sameSite(url)) return false;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (u.pathname === '/' || u.pathname === '') return false;
  if (NON_POST_PATH.test(u.pathname)) return false;
  if (u.searchParams.has('s')) return false;
  if (/\.(?:jpe?g|png|gif|webp|svg|css|js|zip|rar|xml)$/i.test(u.pathname)) return false;
  return true;
}

function firstSrcset(value) {
  if (!value) return null;
  const last = String(value).split(',').pop().trim().split(/\s+/)[0];
  return last || null;
}

function imageFrom($, img) {
  const $img = $(img);
  const candidates = [
    $img.attr('data-src'),
    $img.attr('data-lazy-src'),
    $img.attr('data-original'),
    $img.attr('data-lazy'),
    firstSrcset($img.attr('data-srcset')),
    firstSrcset($img.attr('srcset')),
    $img.attr('src')
  ];
  for (const c of candidates) {
    const abs = absoluteUrl(c);
    if (abs && /^https?:/i.test(abs) && !/(placeholder|blank\.|spacer|loading|1x1|lazy\.|admin-ajax\.php|rank_math|download\.gif|logo\.gif)/i.test(abs)) {
      return abs;
    }
  }
  return null;
}

/* ---- ids ------------------------------------------------------------- */

function encodeId(url) {
  const u = new URL(url);
  return ID_PREFIX + Buffer.from(u.pathname + u.search, 'utf8').toString('base64url');
}

function decodeId(id) {
  const body = String(id).slice(ID_PREFIX.length).split(':')[0];
  const path = Buffer.from(body, 'base64url').toString('utf8');
  const u = new URL(path, BASE_URL + '/');
  if (hostOf(u.href) !== BASE_HOST) throw new Error('Invalid item id');
  return u.href;
}

/* ---- title / quality parsing ---------------------------------------- */

const SERIES_RE = /\b(?:S\d{1,2}(?:\s?E\d{1,3})?|seasons?|episodes?|web[\s-]?series|tv[\s-]?series|complete\s+series|mini[\s-]?series)\b/i;
const isSeriesText = (t) => SERIES_RE.test(t || '');

function parseTitle(raw) {
  const text = cleanText(raw)
    .replace(/^download\s+/i, '')
    .replace(/\s*[-–|]\s*cine\s?freak.*$/i, '');
  const yearMatch =
    text.match(/[(\[]\s*((?:19|20)\d{2})\s*[)\]]/) || text.match(/\b((?:19|20)\d{2})\b/);
  const cutPatterns = [
    /[(\[]/,
    /\b(?:19|20)\d{2}\b/,
    /\bS\d{1,2}\b/i,
    /\bseasons?\b/i,
    /\b(?:480|720|1080|2160)p\b/i,
    /\b(?:WEB-?DL|WEB-?Rip|Blu-?Ray|BRRip|BDRip|HDRip|HDTC|HDCAM|DVDRip)\b/i,
    /\b(?:dual audio|hindi|bengali|bangla|tamil|telugu)\b/i
  ];
  let cut = text.length;
  for (const re of cutPatterns) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  let name = text.slice(0, cut).replace(/[\s\-–|:,]+$/, '').trim();
  if (!name) name = text;
  return { name, year: yearMatch ? yearMatch[1] : null };
}

const QUALITY_RANK = { '2160p': 6, '1440p': 5, '1080p': 4, '720p': 3, '576p': 2, '540p': 2, '480p': 1, '360p': 0 };

function detectQuality(t) {
  const m = String(t || '').match(/\b(2160p|4k|uhd|1440p|1080p|720p|576p|540p|480p|360p)\b/i);
  if (!m) return null;
  const q = m[1].toLowerCase();
  return q === '4k' || q === 'uhd' ? '2160p' : q;
}

function detectSize(t) {
  const m = String(t || '').match(/(\d+(?:\.\d+)?)\s?(GB|MB)\b/i);
  return m ? m[1] + m[2].toUpperCase() : null;
}

function detectInfo(t) {
  const text = String(t || '');
  const parts = [];
  const source = text.match(/\b(WEB-?DL|WEB-?Rip|Blu-?Ray|BRRip|BDRip|HDRip|HDTC|HDCAM|DVDRip)\b/i);
  const codec = text.match(/\b(x265|HEVC|x264|H\.?264|H\.?265|10-?bit)\b/i);
  const audio = text.match(/\b(dual audio|multi audio|hindi|bengali|bangla|tamil|telugu|english)\b/i);
  if (source) parts.push(source[1].toUpperCase());
  if (codec) parts.push(codec[1].toUpperCase());
  if (audio) parts.push(audio[1].replace(/\b\w/g, (c) => c.toUpperCase()));
  return parts.join(' • ');
}

function detectSeason(t) {
  const text = String(t || '');
  const m = text.match(/\bseason[\s._-]*0*(\d{1,2})\b/i) || text.match(/\bS0*(\d{1,2})(?:\s?E\d+|\b)/i);
  return m ? parseInt(m[1], 10) : null;
}

function detectEpisode(t) {
  const text = String(t || '');
  if (/\bepisodes?[\s._-]*\d{1,3}\s*(?:-|–|to|&)\s*\d{1,3}\b/i.test(text)) return null; // ranges are packs
  const m =
    text.match(/\bS\d{1,2}[\s._-]*E0*(\d{1,3})\b/i) ||
    text.match(/\b(?:episode|epi|ep)[\s._-]*0*(\d{1,3})\b/i) ||
    text.match(/\bE0*(\d{1,3})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/* ====================================================================== */
/* Listing pages (catalog)                                                */
/* ====================================================================== */

function makeItem(url, rawTitle, poster) {
  const parsed = parseTitle(rawTitle);
  return {
    url,
    rawTitle,
    name: parsed.name,
    year: parsed.year,
    poster: poster || null,
    type: isSeriesText(rawTitle) ? 'series' : 'movie'
  };
}

function parseCard($, $card) {
  let $link = $card.find(SELECTORS.cardTitleLink).first();
  if (!$link.length) {
    $link = $card
      .find('a[href]')
      .filter((_, a) => isPostUrl(absoluteUrl($(a).attr('href'))))
      .first();
  }
  if (!$link.length) return null;
  const url = absoluteUrl($link.attr('href'));
  if (!isPostUrl(url)) return null;
  const $img = $card.find('img').first();
  const rawTitle =
    cleanText($link.text()) ||
    cleanText($link.attr('title')) ||
    cleanText($img.attr('alt')) ||
    cleanText($card.find('h1,h2,h3,h4').first().text());
  if (!rawTitle) return null;
  return makeItem(url, rawTitle, $img.length ? imageFrom($, $img) : null);
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

function parseListing(html) {
  const $ = cheerio.load(html);
  for (const sel of SELECTORS.cards) {
    const items = [];
    $(sel).each((_, el) => {
      const item = parseCard($, $(el));
      if (item) items.push(item);
    });
    const unique = dedupeItems(items);
    if (unique.length >= 3) return unique;
  }
  // Fallback: any poster image wrapped in a link to a post.
  const items = [];
  $('a[href] img').each((_, img) => {
    const $img = $(img);
    const $a = $img.closest('a');
    const url = absoluteUrl($a.attr('href'));
    if (!isPostUrl(url)) return;
    const rawTitle = cleanText($a.attr('title')) || cleanText($img.attr('alt')) || cleanText($a.text());
    if (!rawTitle) return;
    items.push(makeItem(url, rawTitle, imageFrom($, img)));
  });
  return dedupeItems(items);
}

function buildListUrl(path, page, search) {
  let p = path.startsWith('/') ? path : '/' + path;
  if (!p.endsWith('/')) p += '/';
  let url = BASE_URL + p + (page > 1 ? 'page/' + page + '/' : '');
  if (search) url += '?s=' + encodeURIComponent(search);
  return url;
}

function fetchListing(url) {
  return cached('listing:' + url, TTL.listing, async () => parseListing(await fetchHtml(url)));
}

async function collectCatalog(type, skip, search) {
  const cfg = CATALOGS[type];
  const path = search ? '/' : cfg.path;
  const strict = search ? true : cfg.strict;
  const need = skip + PAGE_LIMIT;
  const collected = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_LISTING_PAGES && collected.length < need; page++) {
    let items;
    try {
      items = await fetchListing(buildListUrl(path, page, search));
    } catch (err) {
      if (page === 1) throw err;
      break;
    }
    if (!items.length) break;
    let added = 0;
    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      added++;
      if (!strict || item.type === type) collected.push(item);
    }
    if (!added) break;
  }

  return collected.slice(skip, skip + PAGE_LIMIT).map((item) => {
    const meta = {
      id: encodeId(item.url),
      type,
      name: item.name,
      posterShape: 'poster'
    };
    if (item.poster) meta.poster = item.poster;
    if (item.year) meta.releaseInfo = item.year;
    return meta;
  });
}

/* ====================================================================== */
/* Post pages: content root, links, metadata                              */
/* ====================================================================== */

function getPostHtml(url) {
  return cached('post:' + url, TTL.post, () => fetchHtml(url));
}

function pickContentRoot($) {
  $(SELECTORS.noise).remove();
  for (const sel of SELECTORS.contentRoots) {
    const el = $(sel).first();
    if (el.length && (el.find('a[href]').length > 0 || cleanText(el.text()).length > 200)) return el;
  }
  return $('body');
}

const JUNK_HOSTS =
  /(?:^|\.)(?:facebook\.com|fb\.com|twitter\.com|x\.com|instagram\.com|t\.me|telegram\.(?:me|org)|whatsapp\.com|youtube\.com|youtu\.be|imdb\.com|wikipedia\.org|themoviedb\.org|gravatar\.com|wp\.me|schema\.org|pinterest\.com|reddit\.com|tiktok\.com|linkedin\.com|googletagmanager\.com|google-analytics\.com|doubleclick\.net|googlesyndication\.com|disqus\.com)$/i;

const DOWNLOADISH =
  /(download|watch|play|stream|server|mirror|g-?drive|drive|direct|links?|\b(?:2160|1080|720|480|360)p|4k|episode|\bep\b)/i;

function gdriveId(url) {
  const m = String(url).match(/\/file\/d\/([\w-]{10,})/) || String(url).match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : null;
}

function classifyUrl(url) {
  const host = hostOf(url);
  const lower = url.toLowerCase();
  if ((host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') && gdriveId(url)) {
    return 'gdrive';
  }
  if (host.includes('vidzer.me') || lower.includes('vidzer.me')) {
    return 'vidzer';
  }
  if (/\.m3u8(?:[?#]|$)/.test(lower)) return 'hls';
  if (/\.(?:mp4|mkv|webm|avi|mov|m4v)(?:[?#]|$)/.test(lower)) return 'direct';
  if (sameSite(url)) return 'internal';
  return 'other';
}

function scanContent($, root, pageUrl, inherited = {}) {
  const found = [];
  const seen = new Set();
  const state = {
    season: inherited.season != null ? inherited.season : null,
    episode: inherited.episode != null ? inherited.episode : null,
    heading: inherited.heading || ''
  };

  const push = (entry) => {
    if (!entry.url || seen.has(entry.url)) return;
    seen.add(entry.url);
    found.push(entry);
  };

  const nodes = root.find('h1,h2,h3,h4,h5,h6,p,strong,b,div,span,li,a[href],iframe,video,source');

  nodes.each((_, el) => {
    const $el = $(el);
    const tag = (el.tagName || el.name || '').toLowerCase();

    /* ---- context-carrying text nodes ---- */
    if (!['a', 'iframe', 'video', 'source'].includes(tag)) {
      if ($el.find('a, iframe, video').length) return;
      const text = cleanText($el.text());
      if (!text || text.length > 220) return;
      const s = detectSeason(text);
      const e = detectEpisode(text);
      if (s != null) {
        state.season = s;
        if (e == null) state.episode = null;
      }
      if (e != null) state.episode = e;
      if (detectQuality(text) || detectSize(text)) state.heading = text;
      return;
    }

    /* ---- embeds / video elements ---- */
    if (tag === 'iframe' || tag === 'video' || tag === 'source') {
      const src = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src');
      const url = absoluteUrl(src, pageUrl);
      if (!url || JUNK_HOSTS.test(hostOf(url))) return;
      let kind = classifyUrl(url);
      if (kind === 'internal' || kind === 'other') kind = tag === 'iframe' ? 'embed' : 'direct';
      const ctx = cleanText(state.heading + ' ' + ($el.attr('title') || ''));
      push({
        url,
        kind,
        label: kind === 'embed' ? 'Embedded player (' + hostOf(url) + ')' : 'Video source',
        quality: detectQuality(ctx) || detectQuality(url),
        size: detectSize(ctx),
        info: detectInfo(ctx),
        season: state.season,
        episode: state.episode
      });
      return;
    }

    /* ---- anchors ---- */
    const url = absoluteUrl($el.attr('href'), pageUrl);
    if (!url || url === pageUrl || JUNK_HOSTS.test(hostOf(url))) return;

    const label = cleanText($el.text()) || cleanText($el.attr('title')) || cleanText($el.attr('aria-label'));
    const parentRaw = cleanText($el.parent().text());
    const parentText = parentRaw.length <= 120 ? parentRaw : '';
    const blob = [label, parentText, state.heading].join(' ');
    const cls = String($el.attr('class') || '') + ' ' + String($el.parent().attr('class') || '');
    const buttonish = /btn|button|download|watch|dl-?link/i.test(cls);

    const kind = classifyUrl(url);
    const base = {
      url,
      label: label || hostOf(url),
      quality: detectQuality(label) || detectQuality(parentText) || detectQuality(state.heading),
      size: detectSize(label) || detectSize(parentText) || detectSize(state.heading),
      info: detectInfo(blob),
      season: detectSeason(label) != null ? detectSeason(label) : detectSeason(parentText) != null ? detectSeason(parentText) : state.season,
      episode: detectEpisode(label) != null ? detectEpisode(label) : detectEpisode(parentText) != null ? detectEpisode(parentText) : state.episode
    };

    if (kind === 'gdrive' || kind === 'hls' || kind === 'direct' || kind === 'vidzer') {
      push({ ...base, kind });
    } else if (kind === 'internal') {
      if (isPostUrl(url) && (buttonish || DOWNLOADISH.test(label))) {
        push({ ...base, kind: 'interstitial' });
      }
    } else if (buttonish || DOWNLOADISH.test(blob)) {
      push({ ...base, kind: 'external' });
    }
  });

  return found;
}

function getLinks(url, follow) {
  return cached('links:' + (follow ? 'f:' : 'n:') + url, TTL.links, async () => {
    const html = await getPostHtml(url);
    const $ = cheerio.load(html);
    const pageTitle = cleanText($('h1').first().text());
    const root = pickContentRoot($);
    let links = scanContent($, root, url, { season: detectSeason(pageTitle) });

    if (follow) {
      const interstitials = links.filter((l) => l.kind === 'interstitial').slice(0, MAX_INTERSTITIALS);
      const settled = await Promise.allSettled(
        interstitials.map(async (parent) => {
          const subHtml = await fetchHtml(parent.url, url);
          const $$ = cheerio.load(subHtml);
          $$(SELECTORS.noise + ', header').remove();
          const sub = scanContent($$, $$('body'), parent.url, {
            season: parent.season,
            episode: parent.episode,
            heading: [parent.label, parent.quality, parent.size].filter(Boolean).join(' ')
          });
          return sub
            .filter((s) => s.kind !== 'interstitial')
            .map((s) => ({
              ...s,
              season: s.season != null ? s.season : parent.season,
              episode: s.episode != null ? s.episode : parent.episode,
              quality: s.quality || parent.quality,
              size: s.size || parent.size,
              info: s.info || parent.info
            }));
        })
      );
      const resolved = [];
      settled.forEach((r) => {
        if (r.status === 'fulfilled') resolved.push(...r.value);
      });
      links = links.filter((l) => l.kind !== 'interstitial').concat(resolved);
    } else {
      links = links.filter((l) => l.kind !== 'interstitial');
    }

    const seen = new Set();
    links = links.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
    links.forEach((l) => {
      if (l.episode != null && l.season == null) l.season = 1;
    });
    return links;
  });
}

/* ---- metadata ---------------------------------------------------------- */

function rootToText($, root) {
  const html = (root.html() || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n');
  return cheerio.load('<div>' + html + '</div>').root().text();
}

function field(text, labels) {
  const m = text.match(new RegExp('\\b(?:' + labels + ')\\s*[:：]\\s*([^\\n]{2,200})', 'i'));
  return m ? cleanText(m[1]) : null;
}

function splitList(value, max) {
  if (!value) return [];
  return value
    .split(/[,/|•;]+/)
    .map((s) => cleanText(s))
    .filter((s) => s && s.length < 40)
    .slice(0, max);
}

function extractDescription($, root) {
  const paras = root
    .find('p, h2, h3, h4, h5')
    .toArray()
    .map((p) => cleanText($(p).text()))
    .filter(Boolean);
  let desc = '';
  for (let i = 0; i < paras.length; i++) {
    const m = paras[i].match(/^(?:storyline|plot|synopsis|story|overview|description)\s*[:\-–]?\s*(.*)$/i);
    if (m) {
      desc = m[1].length >= 40 ? m[1] : paras[i + 1] || '';
      if (desc) break;
    }
  }
  if (!desc) {
    desc =
      paras.find((p) => p.length >= 120 && !/download|watch online|click here|telegram|join us|subscribe/i.test(p)) || '';
  }
  if (!desc) {
    desc = cleanText($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'));
  }
  return desc.slice(0, 1500);
}

function pickImages($, root) {
  const urls = [];
  root.find('img').each((_, img) => {
    const u = imageFrom($, img);
    if (!u) return;
    if (/(logo|icon|avatar|emoji|gravatar|sprite|favicon)/i.test(u)) return;
    const w = parseInt($(img).attr('width') || '0', 10);
    if (w && w < 120) return;
    if (!urls.includes(u)) urls.push(u);
  });
  return urls;
}

function buildVideos(id, links, fallbackSeasons, baseMs) {
  const seen = new Map();
  for (const l of links) {
    if (l.episode == null) continue;
    const key = l.season + ':' + l.episode;
    if (!seen.has(key)) seen.set(key, { season: l.season, episode: l.episode, pack: false });
  }
  let entries = [...seen.values()];
  if (!entries.length) {
    const seasons = new Set(links.filter((l) => l.season != null).map((l) => l.season));
    fallbackSeasons.forEach((s) => seasons.add(s));
    if (!seasons.size) seasons.add(1);
    entries = [...seasons].map((s) => ({ season: s, episode: 1, pack: true }));
  }
  entries.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return entries.map((e, i) => ({
    id: id + ':' + e.season + ':' + e.episode,
    title: e.pack ? 'Season ' + e.season + ' (all links)' : 'Episode ' + e.episode,
    season: e.season,
    episode: e.episode,
    released: new Date(baseMs + i * 86400000).toISOString()
  }));
}

async function getMeta(type, id) {
  const url = decodeId(id);
  const html = await getPostHtml(url);
  const $ = cheerio.load(html);

  const ogImage = absoluteUrl($('meta[property="og:image"]').attr('content'), url);
  const published =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    '';
  const publishedMs = Date.parse(published);
  const baseMs = Number.isFinite(publishedMs) ? publishedMs : Date.UTC(2000, 0, 1);

  const rawTitle =
    cleanText($(SELECTORS.postTitle).first().text()) ||
    cleanText($('meta[property="og:title"]').attr('content')) ||
    cleanText($('title').text());
  const parsed = parseTitle(rawTitle);

  const $genreScope = $.root();
  const genreLinks = $genreScope
    .find(SELECTORS.genreLinks)
    .toArray()
    .map((a) => cleanText($(a).text()))
    .filter((g) => g && g.length < 25 && !/^(?:movies?|series|tv|download|uncategorized|\d{4})$/i.test(g));

  const root = pickContentRoot($);
  const text = rootToText($, root);
  const images = pickImages($, root);
  const description = extractDescription($, root);

  const genres = [...new Set(genreLinks.concat(splitList(field(text, 'Genres?'), 8)))].slice(0, 8);
  const cast = splitList(field(text, 'Stars|Cast|Starring'), 10);
  const director = splitList(field(text, 'Directors?|Directed by'), 3);
  const runtime = field(text, 'Runtime|Duration');
  const ratingMatch =
    text.match(/IMDb[^\d\n]{0,30}(\d(?:\.\d)?)\s*(?:\/|out of)\s*10/i) ||
    text.match(/IMDb\s*(?:rating)?\s*[:\-–]?\s*(\d(?:\.\d)?)/i);

  // 1. High-resolution poster extraction from CineFreak DOM (avoids watermark GIFs and logos)
  let realPoster = null;
  const $posterImg = $('img.external-img.wp-post-image, .poster-image img, figure img.wp-post-image, article img.wp-post-image').first();
  if ($posterImg.length) {
    const src = imageFrom($, $posterImg);
    if (src && !/(logo|icon|avatar|download\.gif|admin-ajax\.php|rank_math)/i.test(src)) {
      realPoster = src;
    }
  }

  // 2. High-resolution backdrop from #cfClickPlay background-image style
  let realBackground = null;
  const playBtnStyle = $('#cfClickPlay, .cf-click-play, .cf-screen-holder [style*="background-image"]').first().attr('style') || '';
  const bgMatch = playBtnStyle.match(/background-image:\s*url\(['"]?([^'"]+)['"]?\)/i);
  if (bgMatch && !/(logo|icon|avatar|download\.gif|admin-ajax\.php|rank_math)/i.test(bgMatch[1])) {
    realBackground = absoluteUrl(bgMatch[1], url);
  }

  // Filter ogImage to avoid site logo / rank math watermark gif
  let safeOgImage = ogImage;
  if (safeOgImage && /(admin-ajax\.php|rank_math|logo|icon|download\.gif)/i.test(safeOgImage)) {
    safeOgImage = null;
  }

  const primaryPoster = realPoster || images[0] || safeOgImage || undefined;
  const primaryBackground = realBackground || safeOgImage || images[1] || primaryPoster;

  const meta = {
    id,
    type,
    name: parsed.name || rawTitle || 'CineFreak item',
    posterShape: 'poster',
    poster: primaryPoster,
    background: primaryBackground,
    description: description || undefined,
    releaseInfo: parsed.year || undefined,
    genres: genres.length ? genres : undefined,
    cast: cast.length ? cast : undefined,
    director: director.length ? director : undefined,
    runtime: runtime || undefined,
    imdbRating: ratingMatch ? ratingMatch[1] : undefined
  };

  if (type === 'series') {
    const links = await getLinks(url, false);
    const titleSeason = detectSeason(rawTitle);
    meta.videos = buildVideos(id, links, titleSeason != null ? [titleSeason] : [], baseMs);
  } else if (Number.isFinite(publishedMs)) {
    meta.released = new Date(publishedMs).toISOString();
  }

  Object.keys(meta).forEach((k) => meta[k] === undefined && delete meta[k]);
  return meta;
}

/* ====================================================================== */
/* Streams                                                                */
/* ====================================================================== */

const KIND_RANK = { direct: 4, hls: 4, gdrive: 3, embed: 1, external: 0 };

function linkRank(l) {
  return (KIND_RANK[l.kind] || 0) * 100 + (QUALITY_RANK[l.quality] != null ? QUALITY_RANK[l.quality] : -1);
}

function toStreams(links, packNote) {
  const sorted = links.slice().sort((a, b) => linkRank(b) - linkRank(a));
  const streams = [];

  for (const l of sorted) {
    const name = ['CineFreak', l.quality || ''].filter(Boolean).join('\n');
    const detail = [l.size, l.info].filter(Boolean).join(' • ');
    const title = [l.label || hostOf(l.url), detail, packNote && l.episode == null ? 'Season pack' : '']
      .filter(Boolean)
      .join('\n');
    const bingeGroup = 'cinefreak-' + (l.quality || 'auto') + '-' + l.kind;

    if (l.kind === 'gdrive') {
      const fileId = gdriveId(l.url);
      streams.push({
        name: name + '\nGDrive',
        title,
        url: 'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download&confirm=t',
        behaviorHints: { notWebReady: true, bingeGroup }
      });
      streams.push({
        name: name + '\nGDrive (browser)',
        title: title + '\nOpen in Google Drive',
        externalUrl: 'https://drive.google.com/file/d/' + fileId + '/view'
      });
    } else if (l.kind === 'direct' || l.kind === 'hls' || l.kind === 'vidzer') {
      const isVidzer = l.kind === 'vidzer' || /vidzer\.me/i.test(l.url);
      const referer = isVidzer ? 'https://vidzer.me' : BASE_URL + '/';
      streams.push({
        name: isVidzer ? 'Vidzer\n' + (l.quality || 'Stream') : name,
        title,
        url: l.url,
        behaviorHints: {
          notWebReady: true,
          bingeGroup,
          proxyHeaders: { request: { Referer: referer, 'User-Agent': USER_AGENT } }
        }
      });
    } else {
      streams.push({
        name: name + '\n' + (l.kind === 'embed' ? 'Embed' : 'Link'),
        title: title + '\nOpens in browser',
        externalUrl: l.url
      });
    }
  }
  return streams;
}

async function getStreams(type, fullId) {
  const parts = String(fullId).split(':');
  const baseId = parts.slice(0, 2).join(':');
  const season = parts[2] ? parseInt(parts[2], 10) : null;
  const episode = parts[3] ? parseInt(parts[3], 10) : null;

  const url = decodeId(baseId);
  const links = await getLinks(url, true);

  if (type === 'series' && episode != null) {
    const matchSeason = (l) => l.season == null || l.season === season;
    const exact = links.filter((l) => l.episode === episode && matchSeason(l));
    const packs = links.filter((l) => l.episode == null && matchSeason(l));
    return toStreams(exact.length ? exact.concat(packs) : packs, true);
  }
  return toStreams(links, false);
}

/* ====================================================================== */
/* Addon definition                                                       */
/* ====================================================================== */

const manifest = {
  id: 'community.cinefreak.vercel',
  version: '1.0.0',
  name: 'CineFreak',
  description: 'Movies and series from cinefreak.net',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: [ID_PREFIX],
  catalogs: [
    {
      type: 'movie',
      id: CATALOGS.movie.id,
      name: CATALOGS.movie.name,
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: CATALOGS.series.id,
      name: CATALOGS.series.name,
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    if (!CATALOGS[type] || CATALOGS[type].id !== id) return { metas: [] };
    const skip = extra && extra.skip ? parseInt(extra.skip, 10) || 0 : 0;
    const search = extra && extra.search ? cleanText(extra.search) : '';
    const metas = await collectCatalog(type, skip, search);
    return { metas, cacheMaxAge: 600, staleRevalidate: 3600, staleError: 86400 };
  } catch (err) {
    console.error('[catalog]', type, id, err.message);
    return { metas: [], cacheMaxAge: 60 };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const meta = await getMeta(type, id);
    return { meta, cacheMaxAge: 3600, staleRevalidate: 86400, staleError: 86400 };
  } catch (err) {
    console.error('[meta]', type, id, err.message);
    return { meta: { id, type, name: 'CineFreak item' }, cacheMaxAge: 60 };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const streams = await getStreams(type, id);
    return { streams, cacheMaxAge: 900, staleRevalidate: 3600, staleError: 86400 };
  } catch (err) {
    console.error('[stream]', type, id, err.message);
    return { streams: [], cacheMaxAge: 60 };
  }
});

const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

/* ====================================================================== */
/* Vercel serverless export                                               */
/* ====================================================================== */

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  router(req, res, () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  });
};

// Local development: `npm start` -> http://127.0.0.1:7000/manifest.json
if (require.main === module) {
  const { serveHTTP } = require('stremio-addon-sdk');
  serveHTTP(addonInterface, { port: Number(process.env.PORT) || 7000 });
}
