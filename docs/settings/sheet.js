// The weight and balance Google Sheet: which base tabs it has. Shared by wb.html and settings.html.
// Tabs are read from the sheet's public htmlview page, so a newly added base tab shows up without an app update.
// That page sends no CORS headers, so it is read through the app shell (dashHost.getText); outside the app, or if
// the sheet can't be reached, the last list seen (localStorage) or the built-in list below is used.
(function () {
  'use strict';
  var SHEET_ID = '1MEI5ZZNN9cHpQITvBmaoUUQotAJVXJxOP6eeCT-Hyro';
  var CACHE_KEY = 'wxc-sheet-tabs';
  // As of 2026-11-02. The sheet's first tab is a fleet-wide list, not a base, so it is never offered.
  var BUILT_IN = [['ADS', 773586627], ['APA', 681944317], ['DXR', 82984131], ['HEG', 556707852], ['GYI', 1792980206],
    ['OCF', 421933909], ['PVU', 157405066], ['SGU', 223718159], ['TCL', 1665195267], ['TLH', 1755425494], ['TUS', 1730112859]]
    .map(function (t) { return { name: t[0], gid: String(t[1]) }; });
  // Each base's airport (aviationweather.gov station info, 2026-11-09): the city shown under the code on the first-start
  // screens, and the position for "nearest to me". A base added later just has no city until it's added here.
  var PLACES = { ADS: ['Addison, TX', 32.963, -96.835], APA: ['Centennial, CO', 39.560, -104.848], DXR: ['Danbury, CT', 41.372, -73.483],
    GYI: ['Sherman–Denison, TX', 33.723, -96.671], HEG: ['Jacksonville, FL', 30.277, -81.809], OCF: ['Ocala, FL', 29.164, -82.221],
    PVU: ['Provo, UT', 40.224, -111.725], SGU: ['St. George, UT', 37.044, -113.503], TCL: ['Tuscaloosa, AL', 33.212, -87.616],
    TLH: ['Tallahassee, FL', 30.394, -84.351], TUS: ['Tucson, AZ', 32.132, -110.956] };
  function code(name) { return String(name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

  function getText(url) {
    if (window.chrome && window.chrome.webview && window.dashHost && window.dashHost.getText) return window.dashHost.getText(url);
    // The web version (docs/dash): through the relay, which answers this with the tab names only, never the sheet
    if (window.WXC_WEB && window.WXC_WEB.relay) url = window.WXC_WEB.relay + '/?u=' + encodeURIComponent(url);
    return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }
  function parse(html) {
    var re = /name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(\d+)"/g, m, out = [];
    while ((m = re.exec(html))) out.push({ name: JSON.parse('"' + m[1] + '"').trim(), gid: m[2] });
    return out.slice(1); // drop the fleet-wide first tab
  }
  function cached() { try { var c = JSON.parse(localStorage.getItem(CACHE_KEY)); return c && c.length ? c : null; } catch (e) { return null; } }

  window.WXSheet = {
    id: SHEET_ID,
    csvUrl: function (gid) { return 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv&gid=' + gid; },
    // Resolves to [{ name, gid }] in sheet order, with .source = 'sheet' | 'cache' | 'built-in'
    tabs: function () {
      return getText('https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/htmlview').then(function (html) {
        var tabs = parse(html);
        if (!tabs.length) throw new Error('no tabs found');
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(tabs)); } catch (e) {}
        tabs.source = 'sheet';
        return tabs;
      }).catch(function () {
        var tabs = cached() || BUILT_IN.slice();
        tabs.source = cached() ? 'cache' : 'built-in';
        return tabs;
      });
    },
    // The tab whose name matches (ignoring case and spaces), or null
    find: function (tabs, name) {
      var n = String(name || '').replace(/\s+/g, '').toUpperCase();
      return tabs.filter(function (t) { return t.name.replace(/\s+/g, '').toUpperCase() === n; })[0] || null;
    },
    code: code,
    // { city, lat, lon } for a base, or null
    place: function (name) { var p = PLACES[code(name)]; return p ? { city: p[0], lat: p[1], lon: p[2] } : null; },
    // The base code nearest to a position, among these tabs (null if none has a known place)
    nearest: function (tabs, lat, lon) {
      var best = null, bd = Infinity, r = Math.PI / 180;
      tabs.forEach(function (t) {
        var p = PLACES[code(t.name)]; if (!p) return;
        var x = (p[2] - lon) * r * Math.cos((p[1] + lat) / 2 * r), y = (p[1] - lat) * r, d = x * x + y * y;
        if (d < bd) { bd = d; best = code(t.name); }
      });
      return best;
    }
  };
})();
