// The TV dashboards' settings window (settings.html) on the web dashboard (docs/dash/settings.html, opened by the
// gear button). It stands in for the Windows app's host: the values are this phone's (web-core.js), settings the base's
// central settings set are locked with a Central badge like on a TV, and saving keeps them on this phone only.
// Rows about the PC itself (screens, quiet hours, updates, the logo, phone numbers) are hidden.
(function () {
  'use strict';
  var HIDE = ['wbScreen', 'singleScreen', 'hideSeconds', 'phones', 'logo', 'dailyReloadHour', 'autoUpdate', 'repo', 'quiet', 'quietFrom', 'quietTo', 'quietMode', 'diagCorner', 'acDetail', 'stations'];
  function tell(m) { try { parent.postMessage(m, location.origin); } catch (e) {} }
  window.dashHost = {
    call: function (cmd, a) {
      var W = window.WXCWeb;
      if (cmd === 'getSettings') return W.ready().then(function () { return W.effective(); });
      if (cmd === 'getCentralStatus') return W.ready().then(function () {
        var m = W.managed(), b = W.base(), st = W.centralState();
        return { central: m.length > 0 || !!(st.doc && st.doc.bases && st.doc.bases[b] && st.doc.bases[b].central), managed: m, scope: 'the ' + b + ' base' };
      });
      if (cmd === 'saveSettings') { W.saveLocal((a && a.values) || {}); tell({ wxc: 'saved' }); return Promise.resolve(true); }
      return Promise.reject(new Error('Not available on the web dashboard.'));
    },
    send: function (cmd) { if (cmd === 'close') tell({ wxc: 'close' }); },
    on: function () {}
  };
  document.addEventListener('DOMContentLoaded', function () {
    var $ = function (id) { return document.getElementById(id); };
    $('title').textContent = 'Dashboard settings';
    $('sub').textContent = 'For this phone only: saved in this browser. Settings marked Central come from the central settings for the base, like on its TVs.';
    HIDE.forEach(function (k) { var el = $(k); if (el) { var row = el.closest('.row'); if (row) row.hidden = true; } });
    ['info', 'upVersion', 'quiet', 'dailyReloadHour'].forEach(function (id) { var el = $(id); var f = el && el.closest('fieldset'); if (f) f.hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll('fieldset'), function (f) { // a fieldset whose rows are all hidden
      var rows = f.querySelectorAll('.row'); if (rows.length && Array.prototype.every.call(rows, function (r) { return r.hidden; })) f.hidden = true;
    });
    if ($('quit')) $('quit').hidden = true;
    if ($('tabNote')) $('tabNote').textContent = 'Which base’s aircraft and airport this phone shows.';
    var th = $('theme') && $('theme').closest('.row').querySelector('small');
    if (th) th.textContent = 'On a phone, Auto follows the phone’s own light or dark mode.';
  });
})();
