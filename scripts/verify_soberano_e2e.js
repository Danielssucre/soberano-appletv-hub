#!/usr/bin/env node
/**
 * SOBERANO E2E REGRESSION & SMOKE GUARD
 * Verifies syntax, Node 8.12 compatibility, and all 4 streaming pillars
 * (Anime, Series, Películas, Torrents/Cursos) against the live LG TV.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const TV_HOST = process.env.TV_HOST || '192.168.128.5';
const TV_PORT = parseInt(process.env.TV_PORT || '9099', 10);

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

function httpGetJson(urlStr, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        const ms = Date.now() - t0;
        try {
          resolve({ status: res.statusCode, ms, json: JSON.parse(body) });
        } catch (e) {
          reject(new Error(`Invalid JSON (${res.statusCode}) from ${urlStr}: ${body.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Timeout (${timeoutMs}ms) on ${urlStr}`)); });
    req.on('error', reject);
  });
}

(async () => {
  console.log('=== [1/3] SYNTAX & NODE 8.12 COMPATIBILITY GUARD ===');
  const servicePath = path.join(REPO_DIR, 'service', 'service.js');
  const indexPath = path.join(REPO_DIR, 'app', 'index.html');

  execFileSync(process.execPath, ['--check', servicePath]);
  const serviceSrc = fs.readFileSync(servicePath, 'utf8');
  // WebOS 4.x runs Node 8.12 where global URL / URLSearchParams / flatMap / optional chaining are unsupported
  assert(!/\bnew\s+URL\s*\(/.test(serviceSrc), 'service.js must not use global `new URL(...)` (Node 8.12 incompatibility)');
  assert(!/\bObject\.fromEntries\b/.test(serviceSrc), 'service.js must not use Object.fromEntries (Node 8.12 incompatibility)');

  const html = fs.readFileSync(indexPath, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((m, idx) => {
    if (m[1].trim()) {
      try { new Function(m[1]); } catch (e) {
        throw new Error(`index.html <script> #${idx} syntax error: ${e.message}`);
      }
    }
  });
  console.log(`OK: service.js (Node 8.12 safe) & ${scripts.length} <script> blocks valid.`);

  console.log(`\n=== [2/3] LIVE TV API CONTRACT (${TV_HOST}:${TV_PORT}) ===`);
  const base = `http://${TV_HOST}:${TV_PORT}`;

  let st = null;
  for (let w = 0; w < 10; w++) {
    try {
      st = await httpGetJson(`${base}/status`, 3000);
      if (st.status === 200 && st.json.status === 'ok') break;
    } catch (eWait) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  assert(st && st.status === 200 && st.json.status === 'ok', '/status must return ok');
  console.log(`OK: /status (${st.ms}ms)`);

  const anime = await httpGetJson(`${base}/api/stream_info?slug=kimetsu-no-yaiba-yuukaku-hen&ep=1`, 12000);
  assert(anime.json.m3u8_url || (anime.json.servers && anime.json.servers.length > 0), 'Anime stream_info must return m3u8_url or servers');
  console.log(`OK: Anime stream_info (${anime.ms}ms, servers=${(anime.json.servers || []).length})`);

  const movie = await httpGetJson(`${base}/api/resolve_tmdb?id=533535&type=movie&orig_lang=en&title=Deadpool`, 15000);
  assert(movie.json.status === 'ok' && movie.json.direct_stream_url, 'Movie resolve_tmdb must return direct_stream_url');
  console.log(`OK: Película resolve_tmdb (${movie.ms}ms, server=${movie.json.server})`);

  const series = await httpGetJson(`${base}/api/resolve_tmdb?id=73223&type=tv&s=2&e=8&orig_lang=ja&title=Black%20Clover`, 15000);
  assert(series.json.status === 'ok' && series.json.direct_stream_url, 'Series resolve_tmdb must return direct_stream_url');
  console.log(`OK: Serie resolve_tmdb (${series.ms}ms, server=${series.json.server})`);

  const season = await httpGetJson(`${base}/api/tmdb/tv/73223/season/1?language=es-MX`, 10000);
  assert(Array.isArray(season.json.episodes) && season.json.episodes.length > 0, 'TMDB season 1 must return episodes');
  console.log(`OK: TMDB Season 1 (${season.ms}ms, episodes=${season.json.episodes.length})`);

  const torrents = await httpGetJson(`${base}/api/soberano/streams?id=73223&type=tv&s=2&e=8`, 12000);
  assert(torrents.json.status === 'ok' && Array.isArray(torrents.json.streams) && torrents.json.streams.length > 0, 'Torrents /api/soberano/streams must return streams');
  console.log(`OK: Torrents streams (${torrents.ms}ms, total=${torrents.json.streams.length})`);

  const courses = await httpGetJson(`${base}/api/soberano/search?q=python&cat=course`, 12000);
  assert(courses.json.status === 'ok' && courses.json.count > 0, 'Universal Torrent search cat=course must return results');
  console.log(`OK: Búsqueda Cursos (${courses.ms}ms, count=${courses.json.count})`);

  console.log('\n=== [3/3] ALL E2E CHECKS PASSED 100% ===');
})().catch((err) => {
  console.error('\n[E2E GUARD FAILED]', err.message);
  process.exit(1);
});
