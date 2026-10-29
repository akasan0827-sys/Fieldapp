#!/usr/bin/env node
/*
 * Builds the files you copy into Google Apps Script, plus the stand-alone demo:
 *   dist/Code.gs          engine + seed + server (paste into Code.gs)
 *   dist/Index.html       the app (paste into a new HTML file named "Index")
 *   dist/appsscript.json  project settings (time zone Asia/Bangkok, web app access)
 *   dist/demo.html        the same app running in the browser with sample data (no Google needed)
 *
 * Usage: npm install && npm run build
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const dir = (...p) => path.join(__dirname, ...p);
const read = (p) => fs.readFileSync(dir(p), 'utf8');
const inline = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap';

function page({ title, css, scripts }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="theme-color" content="#1c2b3f">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${css}</style>
</head>
<body>
<div id="app"><div class="loading">Loading… · กำลังโหลด…</div></div>
<noscript>This app needs JavaScript.</noscript>
${scripts.map((s) => `<script>${inline(s)}</script>`).join('\n')}
</body>
</html>
`;
}

// The page inside Google Apps Script talks to Code.gs through google.script.run.
const GS_SHIM = `
window.STOCK_HOST = { kind: 'gs', canPrint: true, pollMs: 30000 };
window.STOCK_TRANSPORT = function (method, url, body, token) {
  return new Promise(function (resolve, reject) {
    google.script.run
      .withSuccessHandler(function (s) { resolve(JSON.parse(s)); })
      .withFailureHandler(reject)
      .api(JSON.stringify({ method: method, url: url, body: body, token: token }));
  });
};
// let the phone's back button move between pages
window.STOCK_HOST.onNavigate = function (path) { try { google.script.history.push({ path: path }, null, path); } catch (e) { /* ignore */ } };
try {
  google.script.history.setChangeHandler(function (e) {
    var p = (e.state && e.state.path) || (e.location && e.location.hash) || '/dashboard';
    window.dispatchEvent(new CustomEvent('app:history', { detail: p }));
  });
} catch (e) { /* ignore */ }
`;

// The demo runs the same engine in the browser; data is kept in this browser (localStorage).
const DEMO_SHIM = `
(function () {
  'use strict';
  // small synchronous SHA-256 (hex) for the demo's password hashing / token signing
  var K = [];
  (function () {
    var n = 2, c = 0;
    while (c < 64) {
      var prime = true;
      for (var f = 2; f * f <= n; f++) if (n % f === 0) { prime = false; break; }
      if (prime) { K[c++] = (Math.pow(n, 1 / 3) * 4294967296) | 0; }
      n++;
    }
  })();
  function sha256(str) {
    var bytes = unescape(encodeURIComponent(String(str)));
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, words = [];
    for (var i = 0; i < l; i++) words[i >> 2] |= bytes.charCodeAt(i) << (24 - (i % 4) * 8);
    words[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
    var total = ((l + 8) >> 6) * 16 + 16;
    for (var j = words.length; j < total; j++) words[j] = words[j] | 0;
    words[total - 1] = l * 8;
    var w = new Array(64);
    for (var b = 0; b < total; b += 16) {
      var a0 = H[0], a1 = H[1], a2 = H[2], a3 = H[3], a4 = H[4], a5 = H[5], a6 = H[6], a7 = H[7];
      for (var t = 0; t < 64; t++) {
        if (t < 16) w[t] = words[b + t] | 0;
        else {
          var x = w[t - 15], y = w[t - 2];
          var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
          var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
          w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        var S1 = ((a4 >>> 6) | (a4 << 26)) ^ ((a4 >>> 11) | (a4 << 21)) ^ ((a4 >>> 25) | (a4 << 7));
        var ch = (a4 & a5) ^ (~a4 & a6);
        var t1 = (a7 + S1 + ch + K[t] + w[t]) | 0;
        var S0 = ((a0 >>> 2) | (a0 << 30)) ^ ((a0 >>> 13) | (a0 << 19)) ^ ((a0 >>> 22) | (a0 << 10));
        var mj = (a0 & a1) ^ (a0 & a2) ^ (a1 & a2);
        var t2 = (S0 + mj) | 0;
        a7 = a6; a6 = a5; a5 = a4; a4 = (a3 + t1) | 0; a3 = a2; a2 = a1; a1 = a0; a0 = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a0) | 0; H[1] = (H[1] + a1) | 0; H[2] = (H[2] + a2) | 0; H[3] = (H[3] + a3) | 0;
      H[4] = (H[4] + a4) | 0; H[5] = (H[5] + a5) | 0; H[6] = (H[6] + a6) | 0; H[7] = (H[7] + a7) | 0;
    }
    return H.map(function (h) { return ('00000000' + (h >>> 0).toString(16)).slice(-8); }).join('');
  }
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var env = {
    today: function () { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); },
    now: function () { return new Date().toISOString(); },
    sha256: sha256,
    sign: function (s) { return sha256('demo-only-secret|' + s).slice(0, 40); },
    randomId: function (n) { var s = ''; while (s.length < (n || 16)) s += Math.random().toString(16).slice(2); return s.slice(0, n || 16); },
  };
  window.__demoSha256 = sha256;

  var KEY = 'stock_demo_data_v1';
  function load() { try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && v.data ? v.data : null; } catch (e) { return null; } }
  function persist(data) { try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* storage blocked: demo still works until reload */ } }
  function fresh() {
    var b = MemoryBackend(env, {}, null);
    b.run(function (store) {
      Engine.ensureAdmin(store, env, 'demo1234');
      store.update('users', store.t('users')[0], { name: 'Owner (Admin)', must_change: 0 });
      store.setSetting('company_name', 'Demo Solid Surface Co.');
      Seed.demo(store, env);
    });
    return b.data();
  }
  var saved = load();
  var backend = MemoryBackend(env, saved || fresh(), persist);
  if (!saved) persist(backend.data());
  // a second tab with the demo open (e.g. "Sales") sees changes made in the first tab ("SCM")
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY || !e.newValue) return;
    try { backend.reset(JSON.parse(e.newValue).data); } catch (err) { /* ignore */ }
  });
  window.STOCK_HOST = {
    kind: 'demo', canPrint: false, pollMs: 4000,
    reset: function () { backend.reset(fresh()); persist(backend.data()); return Promise.resolve(); },
  };
  window.STOCK_TRANSPORT = function (method, url, body, token) {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(backend.call(method, url, body, token)); }, 40);
    });
  };
})();
`;

async function main() {
  fs.mkdirSync(dir('dist'), { recursive: true });
  const client = await esbuild.build({
    entryPoints: [dir('src/client/app.js')], bundle: true, format: 'iife', target: 'es2019', minify: true, write: false, legalComments: 'none', charset: 'utf8',
  });
  const clientJs = client.outputFiles[0].text;
  const css = (await esbuild.transform(read('src/client/app.css'), { loader: 'css', minify: true, charset: 'utf8' })).code;
  const lower = async (code, minify) => (await esbuild.transform(code, {
    loader: 'js', target: 'es2019', charset: 'utf8', minifyWhitespace: minify, minifySyntax: minify, legalComments: 'none',
  })).code;

  const header = '// Stock manager — Google Sheets edition. Generated by build.js: edit the files in src/, not this file.\n';
  const codeGs = header + await lower([read('src/engine.js'), read('src/seed.js'), read('src/server.gs.js')].join('\n'), false);
  const engineJs = await lower([read('src/engine.js'), read('src/seed.js'), read('src/memory-backend.js')].join('\n'), true);

  fs.writeFileSync(dir('dist/Code.gs'), codeGs);
  fs.writeFileSync(dir('dist/Index.html'), page({ title: 'Stock manager', css, scripts: [GS_SHIM, clientJs] }));
  fs.writeFileSync(dir('dist/demo.html'), page({ title: 'Slab Stock Manager', css, scripts: [engineJs, DEMO_SHIM, clientJs] }));
  // optional: the demo as a page fragment for hosts that add their own <html>/<head> (e.g. a claude.ai artifact)
  const artifactArg = process.argv.find((a) => a.startsWith('--artifact='));
  if (artifactArg) {
    const full = page({ title: 'Slab Stock Manager', css, scripts: [engineJs, DEMO_SHIM, clientJs] });
    const head = full.slice(full.indexOf('<title>'), full.indexOf('</head>'));
    const body = full.slice(full.indexOf('<body>') + 6, full.indexOf('</body>'));
    fs.writeFileSync(artifactArg.slice(11), head.replace(/<meta name="theme-color"[^>]*>\n/, '') + body);
  }
  fs.writeFileSync(dir('dist/appsscript.json'), `${JSON.stringify({
    timeZone: 'Asia/Bangkok',
    dependencies: {},
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
    webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
  }, null, 2)}\n`);

  // translation coverage: every t('...') text and every server message needs a Thai entry
  const { TH } = await import(dir('src/client/th.js'));
  const missing = new Set();
  const scan = (file, re) => { for (const m of read(file).matchAll(re)) if (!(m[1].replace(/\\'/g, "'") in TH)) missing.add(m[1]); };
  for (const f of fs.readdirSync(dir('src/client/pages')).map((x) => `src/client/pages/${x}`).concat(['src/client/app.js', 'src/client/ui.js', 'src/client/api.js', 'src/client/i18n.js'])) {
    scan(f, /\bt\(\s*'((?:[^'\\]|\\.)*)'/g);
  }
  scan('src/engine.js', /\b(?:bad|forbidden|notFound)\(\s*'((?:[^'\\]|\\.)*)'/g);
  for (const f of ['dist/Code.gs', 'dist/Index.html', 'dist/demo.html', 'dist/appsscript.json']) {
    console.log(`${f.padEnd(22)} ${(fs.statSync(dir(f)).size / 1024).toFixed(0).padStart(5)} KB`);
  }
  if (missing.size) {
    console.warn(`\n${missing.size} text(s) have no Thai translation yet (English is shown):`);
    for (const m of missing) console.warn(`  ${m}`);
  } else console.log('Thai translation: complete');
}

main().catch((e) => { console.error(e); process.exit(1); });
