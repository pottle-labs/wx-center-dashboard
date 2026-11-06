// WX Center Central Settings on a phone (GitHub Pages, docs/). It stands in for the Windows app's host (window.dashHost)
// under the same settings page (settings.html), so the phone shows exactly the PC's central settings editor:
//  - Setup: the phone makes its own keys with Web Crypto (the private keys can't be copied out, even by this page) and
//    shows a request to send to the publisher's PC ("Add a phone" there). The PC puts the phone on the signed people
//    list and leaves its GitHub token in central/phone-<id>.json, encrypted with the phone's RSA-OAEP key; this page
//    picks it up, keeps it, and deletes that file.
//  - Every time it opens, and again right before publishing, it reads the latest central/people.json and
//    central/settings.json from GitHub and checks their signatures, so it always shows (and builds on) what's published.
//  - Publishing signs on the phone (RSASSA-PKCS1-v1_5, SHA-256, like the PC) and writes through the GitHub contents API.
// A phone can only change settings: it can't sign app updates or change who has access.
(function () {
  'use strict';
  window.WXC_PHONE = true;
  var CFG = window.WXC_PHONE_CONFIG || {}; // made by shell/phone-site.ps1: updateKey, version, published, allowed
  var q = new URLSearchParams(location.search);
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname); // testing overrides only work on this computer
  var API = (LOCAL && q.get('api')) || 'https://api.github.com';
  function repoFromUrl() {
    var m = location.hostname.match(/^([^.]+)\.github\.io$/i), seg = location.pathname.split('/').filter(Boolean)[0];
    return m && seg ? m[1] + '/' + seg : '';
  }
  var PAGE_REPO = (LOCAL && q.get('repo')) || repoFromUrl();
  var SETTINGS = 'central/settings.json', PEOPLE = 'central/people.json';
  var SET_PREFIX = 'WXCenterDashboard-central|', PEOPLE_PREFIX = 'WXCenterDashboard-people|';
  var LOCAL_ONLY = ['tab', 'wbScreen', 'singleScreen', 'autoUpdate', 'repo'];
  var ALLOWED = (CFG.allowed || []).filter(function (k) { return LOCAL_ONLY.indexOf(k) < 0; });
  var subtle = window.crypto && window.crypto.subtle;

  // ---------- small helpers ----------
  function b64ToB64u(s) { return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64uToB64(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; }
  function bytesToB64(b) { var s = ''; b = new Uint8Array(b); for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function b64ToBytes(s) { var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function fromUtf8B64(s) { return new TextDecoder().decode(b64ToBytes(s.replace(/\s+/g, ''))); }
  function toUtf8B64(s) { return bytesToB64(utf8(s)); }
  function xmlPart(xml, tag) { var m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(xml || ''); return m ? m[1] : ''; }
  function hex(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function clean(v) { return String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim(); } // like CentralSettings.Clean
  function nowUtc() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }   // yyyy-MM-ddTHH:mm:ssZ
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }

  // ---------- this phone's saved state (IndexedDB; the CryptoKeys are stored as keys, never as exportable data) ----------
  function db() {
    return new Promise(function (ok, bad) {
      var r = indexedDB.open('wxc-phone', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { bad(r.error); };
    });
  }
  function load() { return db().then(function (d) { return new Promise(function (ok, bad) { var t = d.transaction('kv').objectStore('kv').get('me'); t.onsuccess = function () { ok(t.result || null); }; t.onerror = function () { bad(t.error); }; }); }); }
  function save(v) { return db().then(function (d) { return new Promise(function (ok, bad) { var t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, 'me'); t.oncomplete = function () { ok(v); }; t.onerror = function () { bad(t.error); }; }); }); }
  function forget() { return db().then(function (d) { return new Promise(function (ok) { var t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete('me'); t.oncomplete = function () { ok(); }; }); }); }

  // ---------- GitHub contents API ----------
  function gh(method, path, token, body) {
    var h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (body) h['Content-Type'] = 'application/json';
    var url = API + '/repos/' + repoOf() + '/contents/' + path + (method === 'GET' ? '?ref=main&t=' + Date.now() : '');
    return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  }
  var meNow = null;
  function repoOf() { return (meNow && meNow.repo) || PAGE_REPO; }
  function getFile(path, token) { // { text, sha } (text null when the file doesn't exist)
    return gh('GET', path, token).then(function (r) {
      if (r.status === 404) return { text: null, sha: null };
      if (!r.ok) throw new Error('GitHub answered ' + r.status + (r.status === 401 ? ' (this phone’s token was deleted or has expired: set the phone up again)' : ''));
      return r.json().then(function (j) { return { text: fromUtf8B64(j.content || ''), sha: j.sha }; });
    });
  }
  function putFile(path, token, text, sha, message) {
    var body = { message: message, content: toUtf8B64(text), branch: 'main' };
    if (sha) body.sha = sha;
    return gh('PUT', path, token, body).then(function (r) {
      if (r.status === 409 || r.status === 422) throw new Error('The central settings changed somewhere else since this page loaded. Reload to see the latest.');
      if (!r.ok) throw new Error('GitHub answered ' + r.status + ' (the phone’s token needs Contents: Read and write on ' + repoOf() + ')');
      return r.json();
    });
  }
  function deleteFile(path, token, sha, message) {
    return gh('DELETE', path, token, { message: message, sha: sha, branch: 'main' });
  }

  // ---------- signatures (the same formats the Windows app reads and writes) ----------
  function jwkFromXml(xml) {
    return { kty: 'RSA', n: b64ToB64u(xmlPart(xml, 'Modulus')), e: b64ToB64u(xmlPart(xml, 'Exponent')), alg: 'RS256', ext: true };
  }
  function xmlFromJwk(j) { return '<RSAKeyValue><Modulus>' + b64uToB64(j.n) + '</Modulus><Exponent>' + b64uToB64(j.e) + '</Exponent></RSAKeyValue>'; }
  function verify(xml, data, sigB64) {
    if (!xml) return Promise.resolve(false);
    return subtle.importKey('jwk', jwkFromXml(xml), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      .then(function (k) { return subtle.verify('RSASSA-PKCS1-v1_5', k, b64ToBytes(sigB64), utf8(data)); })
      .catch(function () { return false; });
  }
  // A signed file { payload, signature }: the payload object if the key keyFor(payload) signed it, else null
  function signed(text, prefix, keyFor) {
    var w; try { w = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return Promise.resolve(null); }
    if (!w || typeof w.payload !== 'string' || typeof w.signature !== 'string') return Promise.resolve(null);
    var d; try { d = JSON.parse(w.payload); } catch (e) { return Promise.resolve(null); }
    return verify(keyFor(d), prefix + w.payload, w.signature).then(function (ok) { return ok ? d : null; });
  }
  function keyFor(settings, people) {
    var s = settings && settings.signer;
    if (!s || s === 'publisher') return CFG.updateKey;
    var p = people.filter(function (x) { return x.id === s; })[0];
    return p ? p.key : null;
  }

  // ---------- the editor's working copy ----------
  var edit = { doc: null, serial: 0, sha: null, people: [] };
  function loadCentral(me) {
    return getFile(PEOPLE, me.token).then(function (pf) {
      return (pf.text ? signed(pf.text, PEOPLE_PREFIX, function () { return CFG.updateKey; }) : Promise.resolve(null)).then(function (pd) {
        edit.people = pd && Array.isArray(pd.people) ? pd.people : [];
        return getFile(SETTINGS, me.token);
      });
    }).then(function (sf) {
      edit.sha = sf.sha; edit.doc = null; edit.serial = 0; edit.warning = '';
      if (!sf.text) return;
      return signed(sf.text, SET_PREFIX, function (d) { return keyFor(d, edit.people); }).then(function (d) {
        if (!d) edit.warning = 'The published central settings aren’t signed by anyone who has access, so dashboards ignore them. Publishing replaces them.';
        else { edit.doc = d; edit.serial = +d.serial || 0; }
      });
    });
  }
  function getCentral() {
    var r = { role: 'none', doc: null, serial: 0, people: [], canPublish: false, why: '', version: CFG.version, published: CFG.published, pending: false };
    if (!subtle || !window.indexedDB) { r.role = 'helper'; r.why = 'This browser can’t keep a signing key. Use Safari (iPhone) or Chrome (Android).'; return Promise.resolve(r); }
    return load().then(function (me) {
      meNow = me;
      if (!me || !me.token) { setTimeout(function () { drawSetup(me); }, 0); return r; }
      r.role = 'helper'; r.name = me.name; r.repo = me.repo;
      return loadCentral(me).then(function () {
        var mine = edit.people.filter(function (x) { return x.id === me.id; })[0];
        if (!mine || xmlPart(mine.key, 'Modulus') !== xmlPart(me.signXml, 'Modulus')) {
          r.why = 'This phone’s access to the central settings has been removed. Ask the publisher, or set this phone up again.';
          setTimeout(function () { offerReset(); }, 0);
          return r;
        }
        if (edit.warning) r.warning = edit.warning;
        if (edit.doc) { r.doc = edit.doc; r.serial = edit.serial; r.by = edit.doc.by; }
        r.canPublish = true;
        return r;
      });
    });
  }
  // Like CentralSettings.Publish on the PC: only known settings and shapes go in, earlier pushes carry over (minus what
  // a push in this publish replaces), and the latest published file is read again first so nothing newer is overwritten.
  function saveCentral(given) {
    var me = meNow;
    if (!me || !me.token) return Promise.reject(new Error('This phone isn’t set up yet.'));
    var loadedSha = edit.sha;
    return loadCentral(me).then(function () {
      if (edit.sha !== loadedSha) throw new Error('Someone published a newer version' + (edit.doc && edit.doc.by ? ' (by ' + edit.doc.by + ')' : '') + ' since this page loaded. Reload to see it, then make your change again.');
      var allowed = function (k) { return ALLOWED.indexOf(k) >= 0; };
      var cleanSect = function (s) { var o = {}; Object.keys(s || {}).forEach(function (k) { if (allowed(k) && s[k] != null) o[k] = clean(s[k]); }); return o; };
      var d = { serial: edit.serial + 1, published: nowUtc(), signer: me.id, by: me.name, sameForAll: given.sameForAll === true };
      d.all = cleanSect(given.all);
      d.bases = {};
      Object.keys(given.bases || {}).forEach(function (k) {
        var b = given.bases[k], n = k.trim().toUpperCase();
        if (!b || !/^[A-Z0-9]{2,8}$/.test(n)) return;
        d.bases[n] = { central: b.central === true, settings: cleanSect(b.settings) };
      });
      var fresh = [];
      Object.keys(given.push || {}).sort(function (a, b) { return (a === 'all' ? 0 : 1) - (b === 'all' ? 0 : 1); }).forEach(function (k) {
        var scope = k === 'all' ? 'all' : k.trim().toUpperCase();
        if (scope !== 'all' && !/^[A-Z0-9]{2,8}$/.test(scope)) return;
        var s = cleanSect(given.push[k]);
        if (!Object.keys(s).length) return;
        fresh.push({ at: d.published, by: me.name, serial: d.serial, scope: scope, settings: s });
      });
      var pushes = [];
      ((edit.doc && edit.doc.pushes) || []).forEach(function (old) {
        var keep = {};
        Object.keys(old.settings || {}).forEach(function (k) {
          if (!fresh.some(function (f) { return (f.scope === old.scope || f.scope === 'all') && k in f.settings; })) keep[k] = old.settings[k];
        });
        if (!Object.keys(keep).length) return;
        var p = JSON.parse(JSON.stringify(old)); p.settings = keep; pushes.push(p);
      });
      d.pushes = pushes.concat(fresh);
      d.defaults = { all: cleanSect((given.defaults || {}).all) }; // new-install settings, kept until changed

      if (given.updateCheck === true) d.updateCheck = d.published;
      var payload = JSON.stringify(d);
      return subtle.sign('RSASSA-PKCS1-v1_5', me.signKey, utf8(SET_PREFIX + payload)).then(function (sig) {
        var text = JSON.stringify({ format: 'WXC-CENTRAL-1', payload: payload, signature: bytesToB64(sig) });
        return putFile(SETTINGS, me.token, text, edit.sha, 'Central settings #' + d.serial + ' by ' + me.name + ' (phone)');
      }).then(function (res) {
        edit.sha = res && res.content ? res.content.sha : null; edit.serial = d.serial; edit.doc = d;
        return d.serial;
      });
    });
  }

  // ---------- setup: make the keys, show the request, wait for the PC ----------
  function deviceGuess() {
    var u = navigator.userAgent;
    return /iPhone/.test(u) ? 'iPhone' : /iPad|Macintosh/.test(u) && 'ontouchend' in document ? 'iPad' : /Android/.test(u) ? 'Android' : /Macintosh/.test(u) ? 'Mac' : 'Phone';
  }
  function makeKeys(name, device) {
    var sign, enc;
    return subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign', 'verify'])
      .then(function (k) { sign = k; return subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, false, ['encrypt', 'decrypt']); })
      .then(function (k) { enc = k; return Promise.all([subtle.exportKey('jwk', sign.publicKey), subtle.exportKey('jwk', enc.publicKey)]); })
      .then(function (j) {
        var id = hex(6);
        var req = 'WXPHONE1.' + b64ToB64u(toUtf8B64(JSON.stringify({ v: 1, id: id, name: name, device: device, sign: { n: j[0].n, e: j[0].e }, enc: { n: j[1].n, e: j[1].e } })));
        return save({ id: id, name: name, device: device, repo: PAGE_REPO, signKey: sign.privateKey, signXml: xmlFromJwk(j[0]), encKey: enc.privateKey, request: req, made: nowUtc() });
      });
  }
  // The PC's reply: central/phone-<id>.json = { format: "WXC-PHONE-1", id, data: base64(RSA-OAEP(JSON { id, token, repo })) }
  var etag = '';
  function checkMailbox(me) {
    var h = { Accept: 'application/vnd.github+json' };
    if (etag) h['If-None-Match'] = etag; // unchanged answers don't count against GitHub's limit for unsigned-in requests
    return fetch(API + '/repos/' + PAGE_REPO + '/contents/central/phone-' + me.id + '.json?ref=main', { headers: h, cache: 'no-store' }).then(function (r) {
      if (r.status === 304 || r.status === 404) return false;
      if (!r.ok) throw new Error('GitHub answered ' + r.status);
      etag = r.headers.get('ETag') || '';
      return r.json().then(function (j) {
        var box = JSON.parse(fromUtf8B64(j.content || ''));
        if (box.format !== 'WXC-PHONE-1' || box.id !== me.id) return false;
        return subtle.decrypt({ name: 'RSA-OAEP' }, me.encKey, b64ToBytes(box.data)).then(function (plain) {
          var s = JSON.parse(new TextDecoder().decode(plain));
          if (s.id !== me.id || !s.token) return false;
          me.token = s.token; me.repo = s.repo || PAGE_REPO; delete me.request;
          return save(me).then(function () {
            return deleteFile('central/phone-' + me.id + '.json', me.token, j.sha, 'Phone set up: ' + me.name + (me.device ? ' (' + me.device + ')' : '')).catch(function () {});
          }).then(function () { return true; });
        });
      });
    });
  }
  var pollTimer = 0;
  function drawSetup(me) {
    var box = $('setup');
    $('form').hidden = true; $('save').hidden = true; $('cancel').hidden = true;
    // keep the ids settings.html touches for the PC's setup screen (hidden here)
    var keep = '<div hidden><span id="setupNote"></span><div id="fileRow"></div><input id="accessFile" type="file"><input id="pass"><button id="importBtn" type="button"></button></div>';
    if (!PAGE_REPO) { box.innerHTML = keep + '<fieldset><legend>Phone setup</legend><div class="row wide"><label>Open this page from its GitHub Pages address<small>It couldn’t tell which repository this is.</small></label></div></fieldset>'; box.hidden = false; return; }
    // A phone makes its key only in the Home Screen copy: on iPhone/iPad, Safari and the Home Screen app keep separate
    // storage (a key made in Safari never reaches the app) and Safari can clear it after about a week
    // A Mac likewise sets up only in its Dock app (Safari: File → Add to Dock, which also keeps its own storage) or an
    // installed Chrome/Edge app
    if (!me && mustInstall()) {
      var ios = isIos(), mac = isMac(), mb = mac ? macBrowser() : null, li = function (t) { return '<li>' + t + '</li>'; };
      var steps, title, why, button = !ios, alt;
      if (ios) {
        steps = iosSteps();
        title = 'Add to Home Screen first (required)';
        why = 'This phone can only be set up from the Home Screen app, not from ' + iosBrowser().name + '. ' +
          (iosBrowser().safari ? 'Safari keeps its own separate storage and can erase this phone’s key after about a week, so a key made here wouldn’t last.'
            : iosBrowser().name + ' keeps its own separate storage, so a key made here wouldn’t reach the Home Screen app.');
      } else if (mac) {
        title = mb.safari ? 'Add to Dock first (required)' : 'Install the app first (required)';
        why = 'This Mac can only be set up from the WX Central app, not from a browser tab. ' +
          (mb.safari ? 'Safari keeps the Dock app’s storage separate and safe from its cleanup, so the key lasts.' : 'The installed app keeps this Mac’s key safe from the browser clearing its data.');
        button = mb.install;
        if (mb.safari && mb.ver >= 17) steps = ['In the menu bar, choose <b>File → Add to Dock…</b> (or click the <b>Share</b> button ' + icon('share') + ' in Safari’s toolbar, then <b>Add to Dock</b>).',
          'Click <b>Add</b>.', 'Open <b>WX Central</b> from the Dock (it’s also in Launchpad and your Applications folder). Setup continues there.'];
        else if (mb.safari) steps = ['This Safari is too old to add apps to the Dock (it needs macOS Sonoma or later). Update the Mac, or open this page in <b>Chrome</b> or <b>Edge</b>.'];
        else if (mb.install) steps = ['Click <b>Install</b> below, then <b>Install</b> again to confirm.', '<b>WX Central</b> opens in its own window and setup continues there. Later, open it from the Dock, Launchpad or your Applications folder.'];
        else steps = [mb.name + ' can’t install web apps on a Mac. Open this page in <b>Safari</b> (File → Add to Dock), <b>Chrome</b> or <b>Edge</b>.'];
        alt = mb.name === 'Edge' ? 'Click the <b>•••</b> menu, then <b>Apps → Install this site as an app</b>.'
          : 'Click the <b>⋮</b> menu, then <b>Cast, save, and share → Install page as app…</b>';
        alt = 'This browser didn’t offer one-tap install. ' + alt + ' Already installed? Open <b>WX Central</b> from the Dock or Launchpad.';
      } else {
        title = 'Install the app first (required)';
        why = 'This phone can only be set up from the installed app, not from the browser. The installed app keeps this phone’s key safe from the browser clearing its data.';
        steps = ['Tap <b>Install</b> below, then <b>Install</b> again to confirm.', 'Open <b>WX Central</b> from your Home Screen or app list. Setup continues there.'];
        alt = 'This browser doesn’t offer one-tap install. Tap its menu <span aria-hidden="true">(⋮)</span> and choose <b>Install app</b> or <b>Add to Home screen</b>. Already installed? Open <b>WX Central</b> from your app list.';
      }
      box.innerHTML = keep + '<fieldset id="phNeedHome"><legend>Set up this ' + (mac ? 'Mac' : 'phone') + '</legend>' +
        '<div class="row wide"><label>' + title + '<small>' + why + '</small>' +
        '<ol class="steps">' + steps.map(li).join('') + '</ol></label></div>' +
        // Android and Chrome/Edge on a Mac: always an Install button. The browser's one-tap install
        // (beforeinstallprompt) when it offers it; otherwise (no support, or already installed) it explains the menu way
        (button ? '<div class="row wide"><span class="inline" style="justify-content:flex-end"><button type="button" class="primary" id="phHomeBtn">Install</button></span>' +
          '<small id="phHomeAlt" hidden style="color:var(--muted);font-size:15px">' + alt + '</small></div>' : '') +
        '</fieldset>';
      box.hidden = false;
      if ($('phHomeBtn')) $('phHomeBtn').addEventListener('click', function () {
        if (!installEvt) { $('phHomeAlt').hidden = false; return; }
        installEvt.prompt();
        installEvt.userChoice.then(function (c) {
          installEvt = null;
          if (c && c.outcome === 'accepted') { $('phHomeBtn').disabled = true; $('phHomeBtn').textContent = 'Installed'; msg(mac ? 'Installed. Setup continues in the WX Central window.' : 'Installed. Open WX Central from your Home Screen to finish setup.'); }
        });
      });
      drawInstall();
      return;
    }
    if (!me) {
      var dev = isMac() ? 'Mac' : 'phone';
      box.innerHTML = keep + '<fieldset><legend>Set up this ' + dev + '</legend>' +
        (!mobile() && !isMac() && !standalone() ? '<div class="row wide"><label>On a computer?<small>Setting up in a browser works, but clearing the browser’s data removes the key. On a Windows PC, the Central Settings app is the better fit.</small></label></div>' : '') +
        '<div class="row"><label for="phName">Your name<small>Shown as who published a change, e.g. “by Blake”.</small></label><input type="text" id="phName" maxlength="40" spellcheck="false"></div>' +
        '<div class="row"><label for="phDevice">This ' + dev + '’s label<small>Shown in the publisher’s access list, e.g. “Blake · ' + (dev === 'Mac' ? 'MacBook' : 'iPhone') + '”.</small></label><input type="text" id="phDevice" maxlength="30" spellcheck="false" value="' + esc(deviceGuess()) + '"></div>' +
        '<div class="row wide"><span class="inline" style="justify-content:flex-end"><button type="button" class="primary" id="phMake">Make this ' + dev + '’s key</button></span></div></fieldset>';
      box.hidden = false;
      $('phMake').addEventListener('click', function () {
        var n = $('phName').value.trim(), dv = $('phDevice').value.trim();
        if (n.length < 2) { msg('Type your name.', true); return; }
        $('phMake').disabled = true; msg('Making this phone’s key… (a few seconds)');
        makeKeys(n, dv).then(function (m) { msg(''); drawSetup(m); }, function (e) { $('phMake').disabled = false; msg('Couldn’t make a key: ' + e.message, true); });
      });
      return;
    }
    box.innerHTML = keep + '<fieldset><legend>Waiting for the publisher</legend>' +
      '<div class="row wide"><label>1. Send this request to the publisher’s PC<small>Text or email it to the PC with Central Settings. It holds only this phone’s public keys, so it’s safe to send. On the PC: Central Settings → People → <b>Add a phone</b>, then paste it.</small></label></div>' +
      '<div class="row wide"><textarea id="phReqOut" rows="5" readonly spellcheck="false">' + esc(me.request || '') + '</textarea></div>' +
      '<div class="row wide"><span class="inline" style="justify-content:flex-end">' + (navigator.share ? '<button type="button" id="phShare">Share…</button>' : '') + '<button type="button" id="phCopy">Copy</button></span></div>' +
      '<div class="row wide"><label>2. This page finishes by itself<small id="phWait">Once the PC adds this phone, setup completes here within about a minute. Leave this page open, or come back to it later.</small></label></div>' +
      '<div class="row wide"><span class="inline" style="justify-content:flex-end"><button type="button" id="phStart" class="quiet">Start over</button><button type="button" id="phCheck">Check now</button></span></div></fieldset>';
    box.hidden = false;
    var text = me.request || '';
    if ($('phShare')) $('phShare').addEventListener('click', function () { navigator.share({ title: 'WX Center phone request', text: text }).catch(function () {}); });
    $('phCopy').addEventListener('click', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { $('phCopy').textContent = 'Copied'; },
        function () { $('phReqOut').select(); try { document.execCommand('copy'); $('phCopy').textContent = 'Copied'; } catch (e) {} });
    });
    $('phStart').addEventListener('click', function () { if (confirm('Start over with a new key? Send the new request to the PC instead.')) forget().then(function () { location.reload(); }); });
    var check = function () {
      $('phWait').textContent = 'Checking…';
      checkMailbox(me).then(function (done) {
        if (done) { clearInterval(pollTimer); msg('This phone is set up.'); location.reload(); return; }
        $('phWait').textContent = 'Not added yet (checked ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '). Once the PC adds this phone, setup completes here within about a minute.';
      }, function (e) { $('phWait').textContent = 'Couldn’t check just now (' + e.message + '). It tries again by itself.'; });
    };
    $('phCheck').addEventListener('click', check);
    clearInterval(pollTimer); pollTimer = setInterval(check, 45000); check();
  }
  function offerReset() {
    var n = $('cnote'); if (!n) return;
    n.insertAdjacentHTML('beforeend', ' <button type="button" id="phReset" class="quiet">Set this phone up again</button>');
    $('phReset').addEventListener('click', function () { if (confirm('Remove this phone’s key and set it up again?')) forget().then(function () { location.reload(); }); });
  }
  function msg(t, bad) { var m = $('msg'); if (m) { m.textContent = t; m.className = 'msg' + (bad ? ' bad' : ''); } }

  // ---------- "Add to Home Screen" ----------
  // Android Chrome: its own install prompt (beforeinstallprompt). iPhone/iPad Safari has none, so the banner says how.
  // On iPhone the Home Screen copy also keeps this phone's key: Safari can clear a website's saved data after about a
  // week without a visit, but not a Home Screen app's.
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; if ($('phNeedHome')) drawSetup(null); else drawInstall(); });
  function standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
  function isIos() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document); }
  // Phones and tablets set up only from the Home Screen copy (see drawSetup); a computer's browser may still set up
  function mobile() { return isIos() || /Android/i.test(navigator.userAgent); }
  // A Mac (not an iPad, which also says Macintosh but has touch)
  function isMac() { return /Macintosh/.test(navigator.userAgent) && !isIos(); }
  function macBrowser() {
    var ua = navigator.userAgent, v = /Version\/(\d+)/.exec(ua);
    if (/Edg\//.test(ua)) return { name: 'Edge', install: true };
    if (/Firefox\//.test(ua)) return { name: 'Firefox' };
    if (/Chrome\//.test(ua)) return { name: 'Chrome', install: true };
    return { name: 'Safari', safari: true, ver: v ? +v[1] : 0 };
  }
  function mustInstall() { return (mobile() || isMac()) && !standalone(); }
  // Which browser and version on iPhone/iPad, for the right Add to Home Screen steps. Safari froze the iOS version in its
  // user agent at 18.x from iOS 26 on, but its Version/NN still matches the iOS major version. Chrome (CriOS), Edge
  // (EdgiOS) and Firefox (FxiOS) report the real iOS version.
  function iosBrowser() {
    var ua = navigator.userAgent, os = /OS (\d+)_(\d+)/.exec(ua), osv = os ? +os[1] + +os[2] / 100 : 0;
    var other = /CriOS/.test(ua) ? 'Chrome' : /EdgiOS/.test(ua) ? 'Edge' : /FxiOS/.test(ua) ? 'Firefox' : '';
    if (other) return { name: other, safari: false, ver: Math.floor(osv), old: osv && osv < 16.04 };
    var v = /Version\/(\d+)/.exec(ua);
    return { name: 'Safari', safari: true, ver: v ? +v[1] : 0 };
  }
  // Small pictures of the buttons to tap, drawn like Safari's own (they follow the text colour)
  function icon(kind) {
    var p = kind === 'menu' ? '<path d="M3 5h14M3 10h14M3 15h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : kind === 'dots' ? '<circle cx="4" cy="10" r="1.8" fill="currentColor"/><circle cx="10" cy="10" r="1.8" fill="currentColor"/><circle cx="16" cy="10" r="1.8" fill="currentColor"/>'
      : '<path d="M10 2.5v10M6.5 6 10 2.5 13.5 6M7 8.5H5.5A1.5 1.5 0 0 0 4 10v6.5A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5V10a1.5 1.5 0 0 0-1.5-1.5H13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
    return '<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:1.7em;height:1.7em;margin:0 .15em;vertical-align:-.45em;border:1px solid currentColor;border-radius:50%;opacity:.85"><svg viewBox="0 0 20 20" width="1.05em" height="1.05em">' + p + '</svg></span>';
  }
  function iosSteps() {
    var b = iosBrowser(), add = 'Scroll down and tap <b>Add to Home Screen</b>. If you don’t see it, tap <b>View More</b> or <b>Edit Actions</b> first.';
    var finish = ['If there’s an <b>Open as Web App</b> switch, leave it on. Tap <b>Add</b>.', 'Go to your Home Screen and open <b>WX Central</b>. Setup continues there.'];
    var first;
    if (!b.safari) {
      if (b.old) return ['This iOS version can only add pages to the Home Screen from <b>Safari</b>. Open this page in Safari, or update the iPhone.'];
      first = 'Tap the <b>Share</b> button ' + icon('share') + ' in ' + b.name + '’s address bar (or in its menu).';
    }
    else if (b.ver >= 27) first = 'Tap the menu button ' + icon('menu') + ' at the left of the address bar at the bottom, then tap <b>Share</b>.';
    else if (b.ver === 26) first = 'Tap the ' + icon('dots') + ' button next to the address bar, then tap <b>Share</b>.';
    else if (b.ver) first = 'Tap the <b>Share</b> button ' + icon('share') + ' in Safari’s toolbar (at the bottom on iPhone, top right on iPad).';
    else first = 'Tap the <b>Share</b> button ' + icon('share') + '. If you don’t see it, tap the menu ' + icon('menu') + ' or <b>•••</b> button next to the address bar first.';
    return [first, add].concat(finish);
  }
  function installHow() {
    return isIos() ? iosSteps()[0].replace(/\.$/, '') + ', then <b>Add to Home Screen</b>, and open it from there.'
      : installEvt ? 'Tap <b>Install</b>, then open it from your Home Screen.'
      : 'In the browser menu <span aria-hidden="true">(⋮)</span>, choose <b>Add to Home screen</b> or <b>Install app</b>, then open it from there.';
  }
  function drawInstall() {
    var el = $('phInstall');
    // Hidden from the Home Screen copy, and while the setup screen itself asks for it (it has the same steps)
    if (!el || standalone() || $('phNeedHome')) { if (el) el.hidden = true; return; }
    var how = installHow() + (isIos() ? ' Safari can clear this page’s saved key after about a week, but not the Home Screen app’s.' : '');
    el.innerHTML = '<div><b>Add this to your Home Screen</b><span>' + how + '</span></div>' +
      (installEvt ? '<button type="button" class="primary" id="phInstallBtn">Install</button>' : '') + '<button type="button" class="quiet" id="phInstallX" aria-label="Hide for now">✕</button>';
    el.hidden = false;
    if ($('phInstallBtn')) $('phInstallBtn').addEventListener('click', function () { installEvt.prompt(); installEvt.userChoice.then(function () { installEvt = null; drawInstall(); }); });
    $('phInstallX').addEventListener('click', function () { el.hidden = true; try { sessionStorage.setItem('wxc-install-x', '1'); } catch (e) {} });
    try { if (sessionStorage.getItem('wxc-install-x')) el.hidden = true; } catch (e) {}
  }
  // Light or dark like the phone (settings.html's light look), also when the phone switches while this is open
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: light)');
    var look = function () { if (mq.matches) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme; };
    look();
    if (mq.addEventListener) mq.addEventListener('change', look); else if (mq.addListener) mq.addListener(look);
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.body.insertAdjacentHTML('afterbegin', '<div class="ph-install" id="phInstall" hidden></div>');
    drawInstall();
    if ($('cancel')) $('cancel').hidden = true; // nothing to close: it's a page
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register('sw.js').catch(function () {});
  });

  // ---------- the host the settings page talks to ----------
  window.dashHost = {
    call: function (cmd, a) {
      try {
        if (cmd === 'getCentral') return getCentral();
        if (cmd === 'saveCentral') return saveCentral((a && a.doc) || {});
      } catch (e) { return Promise.reject(e); }
      return Promise.reject(new Error('That isn’t available on the phone.'));
    },
    send: function () {},
    on: function () {}
  };
})();
