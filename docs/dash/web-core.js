// Settings for the web version of the dashboard (docs/dash), working like a TV dashboard's:
//  - Local settings: this phone's own, kept in localStorage (wxc-web-settings), changed with the gear button.
//  - Central settings: the same signed central/settings.json the TVs read (raw.githubusercontent.com, checked against
//    the update key and the signed people list). A base under central control sets the settings listed for it, and
//    those can't be changed on the phone, exactly like on its TVs.
//  - One-time pushes for this phone's base (or all) are written into its local settings once (pushedAt).
//  - On a phone's first visit, the central "New installs" settings are written into its local settings once (installed).
// What applies = the TVs' defaults (settings.ini) <- phone defaults <- local <- central. pageUrl() turns that into the
// pages' addresses the same way the Windows app's PageUrl does.
(function () {
  'use strict';
  var CFG = window.WXC_WEB || {};
  var LOCAL_ONLY = ['tab', 'wbScreen', 'singleScreen', 'autoUpdate', 'repo'];
  var KEY = 'wxc-web-settings';
  // On a phone some settings start differently from the TVs (before any central or local choice)
  var PHONE_DEFAULTS = { runway: 'table', sun: 'strip' };

  function read() { try { var s = JSON.parse(localStorage.getItem(KEY)); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } }
  function write(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  // Read again each time: the settings window (another page) saves into the same storage
  var store = {};
  function fresh() { store = read(); store.values = store.values || {}; return store; }
  fresh();
  // Nothing stored yet: this phone has never opened the web dashboard (before loading the central file stores its serial)
  var firstVisit = !store.installed && !store.serial && !store.pushedAt && !Object.keys(store.values).length;

  // ---- signed files (same formats and checks as the Windows app) ----
  function b64ToB64u(s) { return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64ToBytes(s) { var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function xmlPart(xml, tag) { var m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(xml || ''); return m ? m[1] : ''; }
  function verify(xml, data, sig) {
    var subtle = window.crypto && crypto.subtle;
    if (!xml || !subtle) return Promise.resolve(false);
    return subtle.importKey('jwk', { kty: 'RSA', n: b64ToB64u(xmlPart(xml, 'Modulus')), e: b64ToB64u(xmlPart(xml, 'Exponent')), alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      .then(function (k) { return subtle.verify('RSASSA-PKCS1-v1_5', k, b64ToBytes(sig), new TextEncoder().encode(data)); })
      .catch(function () { return false; });
  }
  function signed(text, prefix, keyFor) {
    var w, d; try { w = JSON.parse(text.replace(/^﻿/, '')); d = JSON.parse(w.payload); } catch (e) { return Promise.resolve(null); }
    return verify(keyFor(d), prefix + w.payload, w.signature).then(function (ok) { return ok ? d : null; });
  }
  function raw(path) {
    return fetch('https://raw.githubusercontent.com/' + CFG.repo + '/main/' + path + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })
      .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }
  var central = null; // { doc } once loaded (doc null: none published, or not signed by anyone with access)
  function loadCentral() {
    if (central) return Promise.resolve(central);
    if (!CFG.repo || !CFG.updateKey) return Promise.resolve(central = { doc: null });
    return Promise.all([raw('central/people.json'), raw('central/settings.json')]).then(function (f) {
      return (f[0] ? signed(f[0], 'WXCenterDashboard-people|', function () { return CFG.updateKey; }) : Promise.resolve(null)).then(function (pd) {
        var people = pd && Array.isArray(pd.people) ? pd.people : [];
        if (!f[1]) return null;
        return signed(f[1], 'WXCenterDashboard-central|', function (d) {
          if (!d.signer || d.signer === 'publisher') return CFG.updateKey;
          var p = people.filter(function (x) { return x.id === d.signer; })[0]; return p ? p.key : null;
        });
      });
    }).then(function (doc) {
      central = { doc: doc };
      // Serial numbers only go up: an older copy than one already seen is ignored (like the dashboards)
      fresh();
      if (doc && store.serial && +doc.serial < store.serial) central.doc = null;
      else if (doc) { store.serial = +doc.serial; write(store); }
      return central;
    }, function () { return central = { doc: null, failed: true }; });
  }
  function allowed(k) { return (CFG.allowed || []).indexOf(k) >= 0 && LOCAL_ONLY.indexOf(k) < 0; }
  function base() { fresh(); return String(store.values.tab || 'SGU').toUpperCase(); }
  // The settings the central file sets for a base (null when the base is under local control)
  function centralFor(b) {
    var d = central && central.doc; if (!d) return null;
    var sect = (d.bases || {})[b]; if (!sect || sect.central !== true) return null;
    var vals = d.sameForAll === true ? d.all : sect.settings, out = {};
    Object.keys(vals || {}).forEach(function (k) { if (allowed(k) && vals[k] != null) out[k] = String(vals[k]); });
    return out;
  }
  // One-time pushes for this base or all, newer than the last one this phone took
  function applyPushes() {
    var d = central && central.doc; if (!d) return false;
    var b = base(), done = store.pushedAt || '', latest = done, n = 0; // base() reads the saved settings again
    (d.pushes || []).slice().sort(function (x, y) { return (x.at || '') < (y.at || '') ? -1 : (x.at || '') > (y.at || '') ? 1 : (x.scope === 'all' ? -1 : 1); }).forEach(function (p) {
      if (!p.at || p.at <= done) return;
      if (p.at > latest) latest = p.at;
      if (p.scope !== 'all' && String(p.scope).toUpperCase() !== b) return;
      Object.keys(p.settings || {}).forEach(function (k) { if (allowed(k) && p.settings[k] != null) { store.values[k] = String(p.settings[k]); n++; } });
    });
    if (latest === done) return false;
    store.pushedAt = latest; write(store);
    return n > 0;
  }
  // A phone opening the web dashboard for the first time is a new install: it takes the central "New installs" settings
  // once (like a TV's newInstall=1), then they're its own local settings. A phone that used it before this existed
  // (anything already stored) just gets marked. Waits while the central file couldn't be read.
  function applyInstallDefaults() {
    if (!central || central.failed) return false;
    fresh();
    if (store.installed) return false;
    var n = 0, s = firstVisit && central.doc && central.doc.defaults ? central.doc.defaults.all || {} : {};
    Object.keys(s).forEach(function (k) { if (allowed(k) && s[k] != null) { store.values[k] = String(s[k]); n++; } });
    store.installed = new Date().toISOString(); write(store);
    return n > 0;
  }
  function effective() {
    var c = centralFor(base()), v = {}, d = CFG.defaults || {}; // base() reads the saved settings again
    Object.keys(d).forEach(function (k) { v[k] = d[k]; });
    Object.keys(PHONE_DEFAULTS).forEach(function (k) { v[k] = PHONE_DEFAULTS[k]; });
    Object.keys(store.values).forEach(function (k) { v[k] = store.values[k]; });
    if (c) Object.keys(c).forEach(function (k) { v[k] = c[k]; });
    v.tab = base();
    return v;
  }

  // ---- the pages' addresses, as the Windows app builds them (Shell.PageUrl, FeatureQuery, StatusQuery, ThemeQuery) ----
  function light(v) {
    if (v.theme === 'light') return true;
    if (v.theme !== 'auto') return false;
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches); // on a phone, Auto follows the phone
  }
  function pageUrl(view) {
    var v = effective(), q = [];
    function add(k, val) { if (val != null && val !== '') q.push(k + '=' + encodeURIComponent(val)); }
    var theme = function () { if (light(v)) add('theme', 'light'); if (v.clock === '24') add('clock', '24'); };
    if (view !== 'weather') {
      add('tab', v.tab); add('cycle', v.cycle || '15'); add('phones', '0'); add('refresh', v.sheetRefresh || '5');
      add('logo', 'none'); add('acDetail', v.acDetail || 'off'); add('stations', v.stations || '0'); add('layout', v.wbLayout || 'auto');
      ['statusDown', 'statusNote', 'statusOk', 'maint', 'maintWarn', 'maintCrit'].forEach(function (k) { add(k, v[k]); });
      theme();
      return 'wb.html?' + q.join('&');
    }
    var st = String(v.station || 'auto').toLowerCase() === 'auto' ? 'K' + v.tab : String(v.station).toUpperCase();
    add('station', st); add('radius', v.radius || '100'); add('loop', v.radarLoop || '1'); add('radarHours', v.radarHours || '1');
    add('airmets', v.airmets || '1'); add('sigmets', v.sigmets || '1'); add('convective', v.convective || '1');
    add('decoded', v.decoded || 'auto'); add('advList', v.advList || 'auto'); add('advSpeed', v.advSpeed || '20');
    var keys = ['limits', 'limSets', 'limName', 'limWind', 'limGust', 'limXwind', 'limCeil', 'limVis', 'runway', 'sun', 'pireps', 'barbs', 'trend', 'tfrs', 'catChange', 'aloft', 'oldObs', 'tstorm', 'sunCount', 'daFlag', 'daWarn', 'daCrit'];
    ['2', '3', '4'].forEach(function (n) { ['Name', 'Wind', 'Gust', 'Xwind', 'Ceil', 'Vis'].forEach(function (f) { keys.push('lim' + n + f); }); });
    keys.forEach(function (k) { add(k, v[k] != null ? v[k] : (k === 'tfrs' || k === 'oldObs' ? '1' : '')); });
    theme();
    return 'weather.html?' + q.join('&');
  }

  window.WXCWeb = {
    ready: function () { return loadCentral().then(function () { applyPushes(); applyInstallDefaults(); return true; }); },
    base: base,
    setBase: function (b) { fresh(); store.values.tab = String(b).toUpperCase(); write(store); applyPushes(); },
    effective: effective,
    managed: function () { var c = centralFor(base()); return c ? Object.keys(c) : []; },
    centralState: function () { return central || { doc: null }; },
    // Saves what the settings window shows, except what the central settings set for this base
    saveLocal: function (values) {
      var m = window.WXCWeb.managed();
      fresh();
      Object.keys(values || {}).forEach(function (k) { if (m.indexOf(k) < 0 && k !== 'repo') store.values[k] = String(values[k]); });
      store.values.tab = String(store.values.tab || 'SGU').toUpperCase();
      write(store);
    },
    pageUrl: pageUrl,
    light: function () { return light(effective()); }
  };
})();
