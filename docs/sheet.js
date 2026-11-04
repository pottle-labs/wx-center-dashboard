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

  function getText(url) {
    if (window.chrome && window.chrome.webview && window.dashHost && window.dashHost.getText) return window.dashHost.getText(url);
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
    }
  };
})();
