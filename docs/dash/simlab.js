// The Sim Lab Scheduler's schedule (https://schedulerwebsite-4f1af.web.app/, a student-run Firebase site), read-only, for
// the W&B page's "Sim lab" page (TVs) and the phone dashboard's Sim lab tab (sim.html). Shared by both.
//
// The site checks its login in the browser only, so its Firestore data reads without one (the user OK'd reading it
// directly, 2026-11-18). Nothing is ever written.
//   meta/locationsIndex: locations.<ID> = { name, timezone, sims[], blocksPerLab, defaultStart { mon..sun: "HH:MM" },
//                        enableSaturday, enableSunday }. IDs are ICAO codes: a base's location is K + the base (SGU -> KSGU).
//   simlab/<ID>_sim1/weeks/<weekId>: labs { "YYYY-MM-DD": { instructor ("Pending Instructor" when none), blocks [name or
//                        null], blockPhases { "0": "IR" }, startH/startM (own hours), closed, cancelled, cancelledReason,
//                        phaseSnapshot { name: phase } } }. A week that doesn't exist yet is a 404.
// The rules below copy the site's renderScheduler (as of 2026-11-18): Mon-Fri always, Sat/Sun only when enabled; block i
// starts 30 min x i after the day's start; once the lab has ended an empty block reads Closed. On the dashboards a block
// that has already started is faded too, and an empty one reads Closed.
(function () {
  'use strict';
  var PROJECT = 'schedulerwebsite-4f1af';
  var API_KEY = 'AIzaSyBpLcV7lJfXzX42j2Wvxb16T780JRCBb-s'; // the site's own public web key (in its HTML)
  var BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/';
  var SITE = 'https://schedulerwebsite-4f1af.web.app/';
  var DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DEFAULT_START = [14, 0], BLOCKS = 6, INDEX_MS = 3600000;

  // Firestore's REST values -> plain JSON
  function plain(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return +v.integerValue;
    if ('doubleValue' in v) return +v.doubleValue;
    if ('booleanValue' in v) return !!v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
    if ('mapValue' in v) return fields(v.mapValue.fields);
    return null;
  }
  function fields(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = plain(f[k]); }); return o; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(t) { var d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  // The site's weekId(monday): year + "-W" + ceil((days since Jan 1 + Jan 1's weekday + 1) / 7), from local dates; the
  // same with UTC dates (whole days; the site's DST hour never crosses a multiple of 7)
  function weekId(monday) {
    var y = new Date(monday).getUTCFullYear(), jan1 = Date.UTC(y, 0, 1);
    return y + '-W' + pad(Math.ceil(((monday - jan1) / 864e5 + new Date(jan1).getUTCDay() + 1) / 7));
  }
  // Date and minutes past midnight at the location (its time zone; else this device's)
  function localNow(tz, now) {
    var p = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
        .formatToParts(now).forEach(function (x) { p[x.type] = +x.value; });
    } catch (e) { p = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() }; }
    return { day: Date.UTC(p.year, p.month - 1, p.day), min: (p.hour % 24) * 60 + p.minute };
  }
  function clock(min, h24) {
    var h = Math.floor(min / 60) % 24, m = min % 60;
    if (h24) return pad(h) + ':' + pad(m);
    return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' PM' : ' AM');
  }
  function range(a, b, h24) { // "2:00–5:00 PM", or "11:30 AM–2:30 PM"
    if (h24) return clock(a, true) + '–' + clock(b, true);
    var x = clock(a), y = clock(b);
    return (x.slice(-2) === y.slice(-2) ? x.slice(0, -3) : x) + '–' + y;
  }

  // ---- loading ----
  var index = null, indexAt = 0;
  function getDoc(getJSON, path) {
    return getJSON(BASE + path + '?key=' + API_KEY).then(function (d) { return d && d.fields ? fields(d.fields) : {}; }, function (e) {
      if (/\b404\b/.test(String(e && e.message || e))) return null; // no such document (a week nobody has opened yet)
      throw e;
    });
  }
  function loadIndex(getJSON) {
    if (index && Date.now() - indexAt < INDEX_MS) return Promise.resolve(index);
    return getDoc(getJSON, 'meta/locationsIndex').then(function (d) {
      index = (d && d.locations) || {}; indexAt = Date.now(); return index;
    });
  }
  // Raw data for a base's location: { id, loc, labs: { "YYYY-MM-DD": lab }, at } or { id, loc: null } when the scheduler
  // has no such location. Reads the weeks the next 7 days touch.
  function load(base, getJSON, now) {
    var id = 'K' + String(base || '').toUpperCase();
    return loadIndex(getJSON).then(function (locs) {
      var loc = locs[id];
      if (!loc) return { id: id, loc: null, at: Date.now() };
      var today = localNow(loc.timezone, now || new Date()).day, weeks = {};
      for (var i = 0; i < 7; i++) {
        var t = today + i * 864e5, di = (new Date(t).getUTCDay() + 6) % 7, mon = t - di * 864e5;
        weeks[weekId(mon)] = 1;
      }
      var ids = Object.keys(weeks);
      return Promise.all(ids.map(function (w) { return getDoc(getJSON, 'simlab/' + id + '_sim1/weeks/' + w); })).then(function (docs) {
        var labs = {};
        docs.forEach(function (d) { if (d && d.labs) Object.keys(d.labs).forEach(function (k) { labs[k] = d.labs[k]; }); });
        return { id: id, loc: loc, labs: labs, at: Date.now() };
      });
    });
  }

  // ---- the days to show ----
  // days: 7 = every lab day in the next 7 days (from today); 5 = only the first 5 of them. Returns
  // { name, sim, days: [ { key, dow, date, today, gap ("SAT – SUN" skipped before it, or ""), noLab, cancelled, reason,
  //   closed, ended, instructor, pending, range, filled, total, blocks: [ { n, time, name, phase, state } ] } ] }
  // where a block's state is booked | open | closed, plus past (already started... and over) / now flags.
  function view(raw, days, now, h24) {
    var loc = raw.loc || {}, n = loc.blocksPerLab || BLOCKS, ln = localNow(loc.timezone, now || new Date()), out = [], skipped = [];
    for (var i = 0; i < 7; i++) {
      var t = ln.day + i * 864e5, di = (new Date(t).getUTCDay() + 6) % 7;
      if (!(di < 5 || (di === 5 && loc.enableSaturday) || (di === 6 && loc.enableSunday))) { skipped.push(DOW[di]); continue; }
      if (out.length >= (days === 5 ? 5 : 7)) break;
      var key = ymd(t), lab = (raw.labs || {})[key], d = new Date(t), isToday = i === 0;
      var ds = (loc.defaultStart || {})[DAY_KEYS[di]], start;
      if (lab && lab.startH != null && lab.startM != null) start = lab.startH * 60 + lab.startM;
      else if (ds) start = +ds.split(':')[0] * 60 + +ds.split(':')[1];
      else start = DEFAULT_START[0] * 60 + DEFAULT_START[1];
      var end = start + n * 30, ended = isToday && ln.min >= end;
      var day = { key: key, dow: DOW[di], date: MON[d.getUTCMonth()] + ' ' + d.getUTCDate(), today: isToday,
        gap: out.length && skipped.length ? (skipped.length > 1 ? skipped[0] + ' – ' + skipped[skipped.length - 1] : skipped[0]) : '',
        noLab: !lab, cancelled: !!(lab && lab.cancelled), reason: lab && lab.cancelledReason || '', closed: !!(lab && lab.closed), ended: ended,
        instructor: lab && lab.instructor || '', pending: !lab || !lab.instructor || lab.instructor === 'Pending Instructor',
        range: range(start, end, h24), filled: 0, total: n, blocks: [] };
      skipped = [];
      if (lab && !lab.cancelled) {
        var bl = lab.blocks || [];
        for (var b = 0; b < n; b++) {
          var s = start + b * 30, who = bl[b] || '', past = isToday && ln.min >= s + 30, isNow = isToday && ln.min >= s && ln.min < s + 30;
          var ph = who ? ((day.closed && lab.phaseSnapshot && lab.phaseSnapshot[who]) || (lab.blockPhases && lab.blockPhases[b]) || '') : '';
          if (who) day.filled++;
          day.blocks.push({ n: 'B' + (b + 1), time: clock(s, h24), name: who, phase: ph,
            state: who ? 'booked' : (day.closed || ended || past) ? 'closed' : 'open', past: past || ended, now: isNow && !ended });
        }
      }
      out.push(day);
    }
    return { name: loc.name || raw.id, sim: (loc.sims || [])[0] || '', days: out };
  }

  // The scheduler's locations { "KSGU": { name, timezone, ... } } (the first-start screen asks only where there is one)
  window.WXSim = { load: load, view: view, site: SITE, locations: loadIndex };
})();
