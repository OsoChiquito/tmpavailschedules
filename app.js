/* Availability Board
   Reads the TPS Schedule Apps Script (?mode=full), works out when a chosen
   group of people are all free, and draws it on a Mon-Fri board. */

(function () {
'use strict';

/* ---------------------------------------------------------------- storage */

var store = (function () {
  var mem = {}, ok = false;
  try { window.localStorage.setItem('__t', '1'); window.localStorage.removeItem('__t'); ok = true; } catch (e) { ok = false; }
  return {
    get: function (k) { try { return ok ? window.localStorage.getItem(k) : (k in mem ? mem[k] : null); } catch (e) { return null; } },
    set: function (k, v) { try { if (ok) window.localStorage.setItem(k, v); else mem[k] = v; } catch (e) { mem[k] = v; } }
  };
})();

var KEY = 'availability-board.v2';
var DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxeaUSfQCB1xpyTtRvobV7DzHY14HeScjG8gg-cfRzhrWziFoR_Vy6UqqMJLjto4pl83Q/exec';

/* ------------------------------------------------------------------ state */

var DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  dayStart: 7 * 60,
  dayEnd: 17 * 60,
  minWindow: 30,
  buffer: 0,
  allowPartial: false,
  aliases: {},
  sections: { flying: true, ground: true, na: true, supervision: true, academics: false },
  skipCancelled: true,
  showWindows: true,
  showOthers: false,
  showAttendees: true,
  shareFence: true,
  theme: 'dark',
  railOff: false,
  zoom: 0.82,
  showNow: true,
  showEvents: true,
  layout: 'events',
  muted: [],
  holdTitle: '',
  groups: {}
};

var S = clone(DEFAULTS);
var events = [];       // normalised events
var rawNames = [];     // every spelling seen
var categoryOf = {};   // display name -> roster category
var loadedDates = {};  // isoDate -> true, days the feed actually covered
var picked = [];
var weekStart = mondayOf(new Date());
var feedAsOf = null;
var lastPayload = null;
var pendingPicked = null;   // names from a shared link, applied once data loads
var refreshTimer = null;
var focusDay = 0;          // which weekday is on screen when the viewport is narrow
var narrowMq = null;

function narrow() { return !!(narrowMq && narrowMq.matches); }

/* Land on today when today is in view, otherwise Monday. */
function resetFocusDay() {
  var t = iso(new Date());
  focusDay = 0;
  for (var i = 0; i < 5; i++) if (iso(addDays(weekStart, i)) === t) { focusDay = i; return; }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function saveSettings() {
  var keep = clone(S);
  keep.picked = picked;
  store.set(KEY, JSON.stringify(keep));
}

function loadSettings() {
  var raw = store.get(KEY);
  if (!raw) {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) S.theme = 'light';
    } catch (e) { /* leave the default */ }
    return;
  }
  try {
    var got = JSON.parse(raw);
    Object.keys(DEFAULTS).forEach(function (k) {
      if (got[k] !== undefined && got[k] !== null) S[k] = got[k];
    });
    Object.keys(DEFAULTS.sections).forEach(function (k) {
      if (S.sections[k] === undefined) S.sections[k] = DEFAULTS.sections[k];
    });
    if (Array.isArray(got.picked)) picked = got.picked;
  } catch (e) { /* ignore corrupt settings */ }
}

/* ------------------------------------------------------------------- time */

var DAYNAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONNAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function mondayOf(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function iso(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fromIso(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

function readHash() {
  var raw = (location.hash || '').replace(/^#/, '');
  if (!raw) return;
  var parts = {};
  raw.split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) { try { parts[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) {} }
  });
  if (parts.w && /^\d{4}-\d{2}-\d{2}$/.test(parts.w)) weekStart = mondayOf(fromIso(parts.w));
  if (parts.p !== undefined) pendingPicked = parts.p ? parts.p.split('|') : [];
}

function buildLink() {
  return location.href.split('#')[0] +
         '#p=' + encodeURIComponent(picked.join('|')) + '&w=' + iso(weekStart);
}
function hhmm(m) { m = Math.max(0, Math.round(m)); return pad2(Math.floor(m / 60) % 24) + pad2(m % 60); }

function parseTime(raw) {
  var s = String(raw === null || raw === undefined ? '' : raw).trim().toUpperCase().replace(/\./g, '');
  if (!s || s === '-' || s === 'TRUE' || s === 'FALSE') return null;
  s = s.replace(/\s*(LOCAL|ZULU|HRS|HOURS)$/, '').replace(/([0-9])\s*[ZL]$/, '$1').trim();
  var m;
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/))) {
    var h = +m[1], mi = +m[2];
    if (m[3] === 'PM' && h < 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
    if (h > 24 || mi > 59) return null;
    return h * 60 + mi;
  }
  if ((m = s.match(/^(\d{1,2})\s*(AM|PM)$/))) {
    var h2 = +m[1];
    if (m[2] === 'PM' && h2 < 12) h2 += 12;
    if (m[2] === 'AM' && h2 === 12) h2 = 0;
    return h2 * 60;
  }
  if ((m = s.match(/^(\d{3,4})$/))) {
    var v = m[1].length === 3 ? '0' + m[1] : m[1];
    var hh = +v.slice(0, 2), mm = +v.slice(2);
    if (hh > 24 || mm > 59) return null;
    return hh * 60 + mm;
  }
  return null;
}

/* --------------------------------------------------- whiteboard row shapes */

/* Row layouts, from Code.gs:
     flying      [Model, BriefStart, ETD, ETA, DebriefEnd, Event, Crew..., Notes, Eff, Canc, PartEff]
     ground      [Event, Start, End, People..., Notes, Eff, Canc, PartEff]
     na          [Reason, Start, End, People...]
     supervision [Duty, POC, Start, End, POC, Start, End, ...]
   Crew and people stop 4 from the end, not 3. Cutting at -3 sweeps the Notes
   cell in as if it were a person, which is a bug in the upstream reader. */

function txt(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }

function isName(s) {
  if (!s || s.length < 2) return false;
  if (s === '.' || s === '-') return false;
  var u = s.toUpperCase();
  return u !== 'TRUE' && u !== 'FALSE';
}

function truthy(v) {
  var s = txt(v).toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === 'X' || s === '1';
}

function eventsFromDay(day) {
  var out = [], d = day.isoDate, sec = day.data || {};

  if (S.sections.flying) (sec.flying || []).forEach(function (row) {
    var crew = row.slice(6, -4).map(txt).filter(isName);
    if (!crew.length) return;
    if (S.skipCancelled && truthy(row[row.length - 2])) return;
    var s = parseTime(row[1]); if (s === null) s = parseTime(row[2]);
    var e = parseTime(row[4]); if (e === null) e = parseTime(row[3]);
    var title = [txt(row[0]), txt(row[5])].filter(Boolean).join(' ') || 'Flying event';
    out.push(mk(d, 'Flying', title, s, e, crew, txt(row[row.length - 4])));
  });

  if (S.sections.ground) (sec.ground || []).forEach(function (row) {
    var people = row.slice(3, -4).map(txt).filter(isName);
    if (!people.length) return;
    if (S.skipCancelled && truthy(row[row.length - 2])) return;
    out.push(mk(d, 'Ground', txt(row[0]) || 'Ground event',
                parseTime(row[1]), parseTime(row[2]), people, txt(row[row.length - 4])));
  });

  if (S.sections.na) (sec.na || []).forEach(function (row) {
    var people = row.slice(3).map(txt).filter(isName);
    if (!people.length) return;
    out.push(mk(d, 'Not available', txt(row[0]) || 'Not available',
                parseTime(row[1]), parseTime(row[2]), people, ''));
  });

  if (S.sections.supervision) (sec.supervision || []).forEach(function (row) {
    var duty = txt(row[0]);
    if (!duty) return;
    for (var c = 1; c + 2 < row.length; c += 3) {
      var poc = txt(row[c]);
      if (!isName(poc)) continue;
      var s = parseTime(row[c + 1]), e = parseTime(row[c + 2]);
      if (s === null && e === null) continue;   // AUTH duties carry no time
      out.push(mk(d, 'Supervision', duty, s, e, [poc], ''));
    }
  });

  if (S.sections.academics) (sec.academics || []).forEach(function (row) {
    var cells = row.map(txt).filter(Boolean);
    if (!cells.length) return;
    var people = row.slice(1).map(txt).filter(isName);
    if (!people.length) return;
    out.push(mk(d, 'Academics', txt(row[0]) || 'Academics', null, null, people, ''));
  });

  return out;
}

function mk(date, kind, title, s, e, people, note) {
  var allDay = (s === null);
  if (s !== null && e === null) e = s + 60;
  if (s !== null && e !== null && e <= s) e = s + 30;
  return {
    date: date, kind: kind, title: title, note: note,
    allDay: allDay,
    s: allDay ? S.dayStart : s,
    e: allDay ? S.dayEnd : e,
    rawPeople: people
  };
}

/* ---------------------------------------------------------------- loading */

function displayName(raw) {
  var key = txt(raw);
  var alias = S.aliases[key.toLowerCase()];
  return (alias && alias.trim()) ? alias.trim() : key;
}

function relabel() {
  events.forEach(function (ev) { ev.people = ev.rawPeople.map(displayName); });
}

function rosterNames() {
  var set = {};
  events.forEach(function (ev) { ev.people.forEach(function (p) { set[p] = true; }); });
  return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
}

function ingest(payload, label) {
  if (!payload || typeof payload !== 'object') throw new Error('The feed did not return an object.');
  if (payload.error) throw new Error(payload.message || 'The feed reported an error.');
  if (!Array.isArray(payload.days)) throw new Error('No days in the response. The server cache may be empty; try ?forceRefresh=true on the endpoint.');

  var out = [], seen = {};
  loadedDates = {};

  payload.days.forEach(function (day) {
    if (!day || !day.isoDate) return;
    loadedDates[day.isoDate] = true;
    eventsFromDay(day).forEach(function (ev) {
      ev.rawPeople.forEach(function (n) { seen[n] = true; });
      out.push(ev);
    });
  });

  events = out;
  rawNames = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  lastPayload = payload;
  feedAsOf = payload.metadata && payload.metadata.currentAsOf ? new Date(payload.metadata.currentAsOf) : null;

  categoryOf = {};
  if (payload.roster && typeof payload.roster === 'object') {
    Object.keys(payload.roster).forEach(function (cat) {
      (payload.roster[cat] || []).forEach(function (n) { categoryOf[displayName(n)] = cat; });
    });
  }

  relabel();
  var live = rosterNames();
  if (pendingPicked) {
    picked = pendingPicked.filter(function (p) { return live.indexOf(p) >= 0; });
    pendingPicked = null;
  }
  picked = picked.filter(function (p) { return live.indexOf(p) >= 0; });

  var dayCount = Object.keys(loadedDates).length;
  var stamp = feedAsOf ? feedAsOf.toLocaleString() : 'unknown time';
  var warn = payload.metadata && payload.metadata.rosterWarning;
  setState(dayCount + ' days, ' + events.length + ' events, ' + live.length + ' names, read at ' + stamp +
           (label ? ' (' + label + ')' : ''), warn ? 'warn' : 'ok');
  if (warn) msg('sourceMsg', 'The server reports its roster sheet is missing, so some people may not appear.', 'bad');

  saveSettings();
  drawAll();
  drawGroups();
}

function reparse() {
  if (!lastPayload) return;
  try { ingest(lastPayload, 'reparsed'); } catch (e) { msg('sourceMsg', e.message, 'bad'); }
}

function loadFeed(url) {
  var base = String(url || '').trim();
  if (!base) { msg('sourceMsg', 'Add the endpoint address first.', 'bad'); return; }
  var target = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'mode=full&_t=' + Date.now();
  setState('Loading', 'warn');
  busy(true);
  msg('sourceMsg', 'Fetching the schedule.', '');
  fetch(target)
    .then(function (res) {
      if (!res.ok) throw new Error('The endpoint returned ' + res.status + '.');
      return res.json();
    })
    .then(function (data) {
      busy(false);
      ingest(data, null);
      msg('sourceMsg', 'Loaded.', 'ok');
    })
    .catch(function (err) {
      busy(false);
      var m = err.message || String(err);
      if (/Failed to fetch|NetworkError/i.test(m)) {
        m = 'Could not reach the endpoint. Check the address, or whether this network blocks script.google.com.';
      }
      setState(m, 'bad');
      msg('sourceMsg', m, 'bad');
    });
}

/* ------------------------------------------------------- availability math */

/* Picked minus muted. Muting keeps a person in the selection, and in any saved
   group, while taking them out of the availability maths and off the board. */
function active() {
  return picked.filter(function (p) { return S.muted.indexOf(p) < 0; });
}

function eventsOn(dateIso) {
  return events.filter(function (ev) { return ev.date === dateIso; });
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function windowsFor(dateIso) {
  var sel = active();
  if (!sel.length || !loadedDates[dateIso]) return [];
  var ds = S.dayStart, de = S.dayEnd, buf = +S.buffer || 0;
  var busyBy = {};
  sel.forEach(function (p) { busyBy[p] = []; });

  eventsOn(dateIso).forEach(function (ev) {
    var a = ev.allDay ? ds : Math.max(ds, ev.s - buf);
    var b = ev.allDay ? de : Math.min(de, ev.e + buf);
    if (b <= a) return;
    ev.people.forEach(function (p) { if (busyBy[p]) busyBy[p].push([a, b]); });
  });

  var cuts = {}; cuts[ds] = true; cuts[de] = true;
  sel.forEach(function (p) {
    busyBy[p].forEach(function (iv) {
      if (iv[0] > ds && iv[0] < de) cuts[iv[0]] = true;
      if (iv[1] > ds && iv[1] < de) cuts[iv[1]] = true;
    });
  });
  var marks = Object.keys(cuts).map(Number).sort(function (a, b) { return a - b; });

  var segs = [];
  for (var i = 0; i < marks.length - 1; i++) {
    var s = marks[i], e = marks[i + 1];
    if (e <= s) continue;
    var missing = sel.filter(function (p) {
      return busyBy[p].some(function (iv) { return iv[0] < e && iv[1] > s; });
    });
    var last = segs[segs.length - 1];
    if (last && last.e === s && sameList(last.missing, missing)) last.e = e;
    else segs.push({ s: s, e: e, missing: missing });
  }

  return segs.filter(function (w) {
    if (w.e - w.s < +S.minWindow) return false;
    if (!w.missing.length) return true;
    if (!S.allowPartial) return false;
    var free = sel.length - w.missing.length;
    return free >= 2 && free > w.missing.length;
  });
}

function visibleEvents(dateIso) {
  var all = eventsOn(dateIso).filter(function (ev) {
    return ev.allDay || (ev.e > S.dayStart && ev.s < S.dayEnd);
  });
  var sel = active();
  if (!sel.length || S.showOthers) return all.map(tag);
  return all.filter(function (ev) { return hits(ev).length > 0; }).map(tag);

  function hits(ev) { return ev.people.filter(function (p) { return sel.indexOf(p) >= 0; }); }
  function tag(ev) { var o = Object.create(ev); o.hits = hits(ev); return o; }
}

function stack(list) {
  var sorted = list.slice().sort(function (a, b) { return a.s - b.s || b.e - a.e; });
  var cols = [];
  sorted.forEach(function (ev) {
    for (var i = 0; i < cols.length; i++) {
      if (cols[i] <= ev.s) { cols[i] = ev.e; ev.col = i; return; }
    }
    cols.push(ev.e); ev.col = cols.length - 1;
  });
  var n = Math.max(1, cols.length);
  sorted.forEach(function (ev) { ev.cols = n; });
  return sorted;
}

/* -------------------------------------------------------------- rendering */

function $(id) { return document.getElementById(id); }

function setState(text, tone) {
  var el = $('sourceState');
  el.textContent = text;
  el.setAttribute('data-tone', tone || 'idle');
}

function msg(id, text, tone) {
  var el = $(id);
  if (!el) return;
  el.textContent = text;
  el.setAttribute('data-tone', tone || '');
}

function dur(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return m + ' min';
  if (!m) return h + ' hr';
  return h + ' hr ' + m + ' min';
}

var EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
var EYE_SHUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 2l20 20"/><path d="M6.7 6.7C3.6 8.6 1 12 1 12s4 8 11 8c2 0 3.7-.6 5.2-1.5"/><path d="M9.9 5.2A11 11 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-3.2 4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

var MOON = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';
var SUN = 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4';

function applyRail() {
  document.body.classList[S.railOff ? 'add' : 'remove']('rail-off');
  var b = $('railBtn');
  if (b) {
    b.classList[S.railOff ? 'add' : 'remove']('is-off');
    b.setAttribute('aria-pressed', S.railOff ? 'true' : 'false');
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', S.theme === 'light' ? 'light' : 'dark');
  var icon = $('themeIcon');
  if (icon) icon.setAttribute('d', S.theme === 'light' ? SUN : MOON);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', S.theme === 'light' ? '#e9eef4' : '#16213e');
}

function freshness() {
  if (!feedAsOf) return;
  var mins = Math.floor((Date.now() - feedAsOf.getTime()) / 60000);
  var hour = new Date().getHours();
  var overnight = hour >= 23 || hour < 5;
  var stale = !overnight && mins > 25;
  var days = Object.keys(loadedDates).length;
  setState(days + ' days, ' + events.length + ' events, read ' +
           (mins < 1 ? 'just now' : mins + ' min ago') +
           (stale ? '. Expected every 15 min, so this looks stale.' : ''),
           stale ? 'warn' : 'ok');
}

function busy(on) {
  var b = $('reloadBtn');
  if (b) b.classList[on ? 'add' : 'remove']('is-busy');
}

function joinNames(list) { return list.join('; '); }

var PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/></svg>';

function icsEscape(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;')
                  .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsFold(line) {
  if (line.length <= 74) return line;
  var out = line.slice(0, 74), rest = line.slice(74);
  while (rest.length) { out += '\r\n ' + rest.slice(0, 73); rest = rest.slice(73); }
  return out;
}

function icsStamp(dateIso, mins) {
  return dateIso.replace(/-/g, '') + 'T' + hhmm(mins) + '00';
}

/* Local wall-clock times with no zone, because the Whiteboard carries none.
   The event lands at the time it says, whatever calendar opens it. */
function buildIcs(dateIso, win, title) {
  var sel = active();
  var going = win.missing.length
    ? sel.filter(function (p) { return win.missing.indexOf(p) < 0; })
    : sel;
  var body = ['Held from the availability board.', 'Free: ' + joinNames(going)];
  if (win.missing.length) body.push('Not free: ' + joinNames(win.missing));

  var now = new Date();
  var stamp = now.getUTCFullYear() + pad2(now.getUTCMonth() + 1) + pad2(now.getUTCDate()) + 'T' +
              pad2(now.getUTCHours()) + pad2(now.getUTCMinutes()) + pad2(now.getUTCSeconds()) + 'Z';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Availability Board//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + dateIso + '-' + hhmm(win.s) + '-' + Math.random().toString(36).slice(2, 8) + '@availability-board',
    'DTSTAMP:' + stamp,
    'DTSTART:' + icsStamp(dateIso, win.s),
    'DTEND:' + icsStamp(dateIso, win.e),
    icsFold('SUMMARY:' + icsEscape(title)),
    icsFold('DESCRIPTION:' + icsEscape(body.join('\n'))),
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n') + '\r\n';
}

function downloadIcs(dateIso, win) {
  var sel = active();
  var suggested = S.holdTitle || ('Hold: ' + joinNames(sel.slice(0, 3)) + (sel.length > 3 ? ' +' + (sel.length - 3) : ''));
  var title = window.prompt('Title for the calendar entry', suggested);
  if (title === null) return;
  title = title.trim() || suggested;
  S.holdTitle = title;
  saveSettings();

  var text = buildIcs(dateIso, win, title);
  var name = 'hold-' + dateIso + '-' + hhmm(win.s) + '.ics';
  try {
    var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    msg('linkMsg', 'Saved ' + name + '. Open it to add the hold to your calendar.', 'ok');
  } catch (e) {
    msg('linkMsg', 'Could not build the calendar file here.', 'bad');
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function drawAll() { drawWeekLabel(); drawRoster(); drawBoard(); drawPrint(); }

function goWeek(delta) {
  weekStart = delta === 0 ? mondayOf(new Date()) : addDays(weekStart, delta);
  resetFocusDay();
  drawAll();
}

function drawWeekLabel() {
  var a = weekStart, b = addDays(weekStart, 4);
  $('weekLabel').textContent = a.getDate() + ' ' + MONNAME[a.getMonth()] + ' to ' +
                               b.getDate() + ' ' + MONNAME[b.getMonth()] + ' ' + b.getFullYear();
}

function drawRoster() {
  var host = $('roster');
  var names = rosterNames();
  var filter = ($('rosterSearch').value || '').toLowerCase();
  host.innerHTML = '';

  if (!names.length) {
    host.innerHTML = '<p class="empty">Load the schedule to see names.</p>';
    $('pickCount').textContent = '0 picked';
    return;
  }

  var counts = {};
  events.forEach(function (ev) { ev.people.forEach(function (p) { counts[p] = (counts[p] || 0) + 1; }); });

  var shown = names.filter(function (n) { return !filter || n.toLowerCase().indexOf(filter) >= 0; });
  if (!shown.length) host.innerHTML = '<p class="empty">No names match that filter.</p>';

  var groups = {}, order = [];
  shown.forEach(function (n) {
    var cat = categoryOf[n] || 'Others on the schedule';
    if (!groups[cat]) { groups[cat] = []; order.push(cat); }
    groups[cat].push(n);
  });
  order.sort(function (a, b) {
    if (a === 'Others on the schedule') return 1;
    if (b === 'Others on the schedule') return -1;
    return a.localeCompare(b);
  });

  order.forEach(function (cat) {
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'group-head';
    head.textContent = cat;
    head.title = 'Select or clear everyone in this group';
    (function (members) {
      head.addEventListener('click', function () {
        var allOn = members.every(function (n) { return picked.indexOf(n) >= 0; });
        members.forEach(function (n) {
          var at = picked.indexOf(n);
          if (allOn && at >= 0) picked.splice(at, 1);
          else if (!allOn && at < 0) picked.push(n);
        });
        picked.sort(function (a, b) { return a.localeCompare(b); });
        saveSettings(); drawAll();
      });
    })(groups[cat].slice());
    host.appendChild(head);
    groups[cat].forEach(function (n) {
      var on = picked.indexOf(n) >= 0;
      var row = document.createElement('label');
      row.className = 'person' + (on ? ' is-on' : '');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = on;
      box.addEventListener('change', function () {
        if (box.checked) { if (picked.indexOf(n) < 0) picked.push(n); }
        else {
          picked = picked.filter(function (p) { return p !== n; });
          S.muted = S.muted.filter(function (p) { return p !== n; });
        }
        picked.sort(function (a, b) { return a.localeCompare(b); });
        saveSettings();
        drawAll();
      });
      var span = document.createElement('span');
      span.textContent = n;
      var load = document.createElement('span');
      load.className = 'load';
      load.textContent = counts[n] || 0;
      row.appendChild(box); row.appendChild(span); row.appendChild(load);

      if (on) {
        var shut = S.muted.indexOf(n) >= 0;
        row.className += ' has-eye' + (shut ? ' is-muted' : '');
        var eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'eye' + (shut ? ' is-shut' : '');
        eye.innerHTML = shut ? EYE_SHUT : EYE_OPEN;
        eye.title = shut ? 'Count ' + n + ' again' : 'Leave ' + n + ' out without unticking them';
        eye.setAttribute('aria-label', eye.title);
        eye.setAttribute('aria-pressed', shut ? 'true' : 'false');
        eye.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var at = S.muted.indexOf(n);
          if (at >= 0) S.muted.splice(at, 1); else S.muted.push(n);
          saveSettings(); drawAll();
        });
        row.appendChild(eye);
      }

      host.appendChild(row);
    });
  });

  var hidden = picked.filter(function (p) { return S.muted.indexOf(p) >= 0; }).length;
  $('pickCount').textContent = (picked.length - hidden) + ' counted' +
                               (hidden ? ', ' + hidden + ' hidden' : '');
}

function drawChips() {
  var host = $('dayChips');
  host.innerHTML = '';
  if (!narrow()) return;
  for (var i = 0; i < 5; i++) {
    var date = addDays(weekStart, i);
    var key = iso(date);
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' +
      (i === focusDay ? ' is-on' : '') +
      (key === iso(new Date()) ? ' is-today' : '') +
      (loadedDates[key] ? '' : ' is-blank');
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', i === focusDay ? 'true' : 'false');
    chip.innerHTML = '<b>' + DAYNAME[date.getDay()] + '</b><span>' + date.getDate() + '</span>';
    (function (idx) {
      chip.addEventListener('click', function () { focusDay = idx; drawBoard(); });
    })(i);
    host.appendChild(chip);
  }
}

function drawBoard() {
  var heads = $('dayHeads'), gutter = $('gutter'), lanes = $('lanes');
  heads.innerHTML = ''; gutter.innerHTML = ''; lanes.innerHTML = '';
  drawChips();

  var one = narrow();
  if (focusDay < 0 || focusDay > 4) focusDay = 0;
  $('grid').classList[one ? 'add' : 'remove']('one-day');

  var ds = S.dayStart, de = S.dayEnd;
  if (de <= ds) de = ds + 60;
  var span = de - ds;
  var pxPerMin = +S.zoom || 0.82;
  var height = Math.max(380, span * pxPerMin);
  gutter.style.height = height + 'px';
  lanes.style.height = height + 'px';

  /* How the column width is split. With the events layer off, availability
     takes the lot. */
  var mode = S.showEvents ? S.layout : 'availOnly';
  var availCss, evLeftPx, evRoom, evSplit = 0.5;
  if (mode === 'availOnly') { availCss = { left: '2px', right: '2px', width: '' }; evRoom = 0; }
  else if (mode === 'avail') { availCss = { left: '2px', right: '', width: 'calc(100% - 96px)' }; evLeftPx = 98; }
  else if (mode === 'split') { availCss = { left: '2px', right: '', width: 'calc(50% - 4px)' }; evLeftPx = null; }
  else if (narrow()) { availCss = { left: '2px', right: '', width: '38%' }; evLeftPx = null; evSplit = 0.38; }
  else { availCss = { left: '2px', right: '', width: '84px' }; evLeftPx = 90; }
  lanes.classList[mode === 'avail' || mode === 'availOnly' ? 'add' : 'remove']('wide-avail');

  var todayIso = iso(new Date());

  for (var t = Math.ceil(ds / 30) * 30; t <= de; t += 30) {
    var tick = document.createElement('div');
    var onHour = t % 60 === 0;
    tick.className = 'tick' + (onHour ? ' hour' : '');
    tick.style.top = ((t - ds) * pxPerMin) + 'px';
    tick.textContent = onHour ? hhmm(t) : '';
    gutter.appendChild(tick);
  }

  var showDays = one ? [focusDay] : [0, 1, 2, 3, 4];

  for (var di = 0; di < showDays.length; di++) {
    var d = showDays[di];
    var date = addDays(weekStart, d);
    var key = iso(date);
    var isToday = key === todayIso;
    var covered = !!loadedDates[key];

    var head = document.createElement('div');
    head.className = 'day-head' + (isToday ? ' is-today' : '') + (covered ? '' : ' is-blank');
    head.innerHTML = '<b>' + DAYNAME[date.getDay()] + '</b><span>' + date.getDate() + ' ' + MONNAME[date.getMonth()] + '</span>';
    heads.appendChild(head);

    var lane = document.createElement('div');
    lane.className = 'lane' + (isToday ? ' is-today' : '') + (covered ? '' : ' is-blank');
    lanes.appendChild(lane);

    for (var g = Math.ceil(ds / 30) * 30; g <= de; g += 30) {
      var line = document.createElement('div');
      line.className = 'hourline' + (g % 60 ? ' half' : '');
      line.style.top = ((g - ds) * pxPerMin) + 'px';
      lane.appendChild(line);
    }

    if (!covered) {
      var note = document.createElement('div');
      note.className = 'nodata';
      note.textContent = 'No sheet';
      lane.appendChild(note);
      continue;
    }

    if (S.showWindows) {
      windowsFor(key).forEach(function (w) {
        var full = w.missing.length === 0;
        var box = document.createElement('div');
        box.className = 'blk ' + (full ? 'blk-open' : 'blk-partial');
        box.style.left = availCss.left;
        if (availCss.right) box.style.right = availCss.right;
        if (availCss.width) box.style.width = availCss.width;
        box.style.top = ((w.s - ds) * pxPerMin) + 'px';
        var bh = Math.max(14, (w.e - w.s) * pxPerMin - 2);
        box.style.height = bh + 'px';
        var mins = w.e - w.s;
        var span = hhmm(w.s) + '-' + hhmm(w.e);
        var nActive = active().length;
        var label = full ? (nActive > 1 ? 'all ' + nActive + ' free' : 'free')
                         : 'without ' + joinNames(w.missing);
        var roomy = (mode === 'avail' || mode === 'availOnly' || mode === 'split');
        if (roomy && bh < 30) {
          box.className += ' pack';
          box.innerHTML = '<div class="row"><span class="t">' + span + '</span>' +
                          '<span class="n">' + esc(label) + '</span></div>';
        } else {
          box.innerHTML = '<span class="t">' + span + '</span>' +
                          (bh >= 30 ? '<span class="n">' + esc(label) + '</span>' : '');
        }
        box.title = span + ', ' + dur(mins) + ', ' + label;

        if (bh >= 20) {
          var add = document.createElement('button');
          add.type = 'button';
          add.className = 'add';
          add.innerHTML = PLUS;
          add.title = 'Add ' + span + ' to a calendar';
          add.setAttribute('aria-label', add.title);
          (function (dk, ww) {
            add.addEventListener('click', function (e) {
              e.preventDefault(); e.stopPropagation();
              downloadIcs(dk, ww);
            });
          })(key, w);
          box.appendChild(add);
          box.className += ' has-add';
        }

        lane.appendChild(box);
      });
    }

    if (!S.showEvents) continue;

    stack(visibleEvents(key)).forEach(function (ev) {
      var box = document.createElement('div');
      box.className = 'blk blk-busy kind-' + ev.kind.toLowerCase().replace(/\s+/g, '-') +
        (ev.allDay ? ' blk-allday' : '') +
        (active().length && !ev.hits.length ? ' is-off' : '');
      box.style.top = ((Math.max(ds, ev.s) - ds) * pxPerMin) + 'px';
      var bh = Math.max(15, (Math.min(de, ev.e) - Math.max(ds, ev.s)) * pxPerMin - 2);
      box.style.height = bh + 'px';
      /* Events sit to the right of whatever the availability strip took. */
      var frac = 1 / ev.cols;
      if (evLeftPx === null) {
        var pc = (evSplit * 100).toFixed(2), rest = ((1 - evSplit) * 100).toFixed(2);
        box.style.left = 'calc(' + pc + '% + 3px + (' + rest + '% - 7px) * ' + (ev.col * frac) + ')';
        box.style.width = 'calc((' + rest + '% - 7px) * ' + frac + ' - 4px)';
      } else {
        box.style.left = 'calc(' + evLeftPx + 'px + (100% - ' + (evLeftPx + 4) + 'px) * ' + (ev.col * frac) + ')';
        box.style.width = 'calc((100% - ' + (evLeftPx + 4) + 'px) * ' + frac + ' - 4px)';
      }

      var who = ev.hits.length ? ev.hits : ev.people;
      var whoText = joinNames(who.slice(0, 4)) + (who.length > 4 ? ' +' + (who.length - 4) : '');
      var when = ev.allDay ? 'all day' : hhmm(ev.s) + '-' + hhmm(ev.e);

      /* Only draw as many lines as the block is tall enough to hold.
         One line needs about 14px, so 3 lines needs about 44px of room. */
      if (bh >= 48 && S.showAttendees && whoText) {
        box.innerHTML = '<span class="t">' + when + '</span>' +
                        '<span class="e">' + esc(ev.title) + '</span>' +
                        '<span class="w">' + esc(whoText) + '</span>';
      } else if (bh >= 32) {
        box.innerHTML = '<span class="t">' + when + '</span>' +
                        '<span class="e">' + esc(ev.title) + '</span>';
      } else {
        box.className += ' pack';
        box.innerHTML = '<div class="row"><span class="t">' + when + '</span>' +
                        '<span class="e">' + esc(ev.title) + '</span></div>';
      }
      box.title = ev.kind + ': ' + ev.title + '\n' +
                  (ev.allDay ? 'All day' : hhmm(ev.s) + '-' + hhmm(ev.e)) +
                  (ev.note ? '\n' + ev.note : '') + '\n' + joinNames(ev.people);
      lane.appendChild(box);
    });
  }

  if (S.showNow) {
    var now = new Date();
    var nowIso = iso(now);
    var nowMin = now.getHours() * 60 + now.getMinutes();
    for (var k = 0; k < showDays.length; k++) {
      if (iso(addDays(weekStart, showDays[k])) !== nowIso) continue;
      if (nowMin < ds || nowMin > de) break;
      var line = document.createElement('div');
      line.className = 'nowline';
      line.style.top = ((nowMin - ds) * pxPerMin) + 'px';
      line.title = 'Now, ' + hhmm(nowMin);
      lanes.children[k].appendChild(line);
      break;
    }
  }

  var summary = '';
  var nSel = active().length;
  var nMute = picked.length - nSel;
  if (!events.length) summary = 'Nothing loaded yet.';
  else if (!nSel) summary = picked.length ? 'Every picked name is hidden.' : 'Pick names to see open windows.';
  else {
    var total = 0, count = 0;
    for (var i = 0; i < 5; i++) {
      windowsFor(iso(addDays(weekStart, i))).forEach(function (w) {
        if (!w.missing.length) { total += w.e - w.s; count++; }
      });
    }
    summary = (count ? count + ' window' + (count === 1 ? '' : 's') + ' this week, ' + dur(total) + ' in total'
                     : 'No window of ' + dur(+S.minWindow) + ' or longer with everyone free') +
              (nMute ? ', ' + nMute + ' name' + (nMute === 1 ? '' : 's') + ' hidden' : '');
  }
  $('windowSummary').textContent = summary;
}

/* ----------------------------------------------------------------- export */

function padRight(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

function buildShareText(mode) {
  var lines = [];
  var sel = active();
  var muted = picked.filter(function (p) { return S.muted.indexOf(p) >= 0; });
  var who = sel.length ? joinNames(sel) : 'everyone on the schedule';
  var a = weekStart, b = addDays(weekStart, 4);

  lines.push('Availability for ' + who);
  lines.push('Week of ' + a.getDate() + ' ' + MONNAME[a.getMonth()] + ' to ' +
             b.getDate() + ' ' + MONNAME[b.getMonth()] + ' ' + b.getFullYear() +
             ', ' + hhmm(S.dayStart) + ' to ' + hhmm(S.dayEnd) +
             ', windows of ' + dur(+S.minWindow) + ' or more');
  lines.push('');

  if (muted.length) lines.push('Not counting ' + joinNames(muted));
  if (!sel.length) { lines.push('Pick at least one name on the board first.'); return lines.join('\n'); }
  if (muted.length) lines.push('');

  for (var i = 0; i < 5; i++) {
    var date = addDays(weekStart, i);
    var key = iso(date);
    var label = DAYNAME[date.getDay()] + ' ' + pad2(date.getDate()) + ' ' + MONNAME[date.getMonth()];

    if (!loadedDates[key]) {
      lines.push(mode === 'open' ? padRight(label, 12) + 'no sheet' : label + '\n  no sheet published\n');
      continue;
    }

    var wins = windowsFor(key);
    var full = wins.filter(function (w) { return !w.missing.length; });
    var part = wins.filter(function (w) { return w.missing.length; });

    if (mode === 'open') {
      lines.push(padRight(label, 12) + (full.length
        ? full.map(function (w) { return hhmm(w.s) + '-' + hhmm(w.e); }).join(', ')
        : 'nothing open'));
      part.forEach(function (w) {
        lines.push(padRight('', 12) + hhmm(w.s) + '-' + hhmm(w.e) + ' without ' + joinNames(w.missing));
      });
      continue;
    }

    lines.push(label);
    lines.push('  open   ' + (full.length
      ? full.map(function (w) { return hhmm(w.s) + '-' + hhmm(w.e); }).join(', ')
      : 'nothing'));
    part.forEach(function (w) {
      lines.push('  most   ' + hhmm(w.s) + '-' + hhmm(w.e) + '  without ' + joinNames(w.missing));
    });

    var busy = eventsOn(key)
      .filter(function (ev) { return ev.people.some(function (p) { return sel.indexOf(p) >= 0; }); })
      .sort(function (x, y) { return x.s - y.s; });
    busy.forEach(function (ev, n) {
      var hits = ev.people.filter(function (p) { return sel.indexOf(p) >= 0; });
      var time = ev.allDay ? 'all day  ' : hhmm(ev.s) + '-' + hhmm(ev.e);
      lines.push((n === 0 ? '  busy   ' : '         ') + padRight(time, 11) + ev.title + ' (' + joinNames(hits) + ')');
    });
    lines.push('');
  }

  if (feedAsOf) lines.push('Whiteboard read at ' + feedAsOf.toLocaleString());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function refreshShare() {
  var mode = document.querySelector('input[name="shareMode"]:checked').value;
  var body = buildShareText(mode);
  $('shareText').value = S.shareFence ? '```\n' + body + '\n```' : body;
}

function drawPrint() {
  var a = weekStart, b = addDays(weekStart, 4);
  var who = active().length ? joinNames(active()) : 'the whole schedule';
  $('printOut').innerHTML =
    '<h1>Availability, week of ' + a.getDate() + ' ' + MONNAME[a.getMonth()] + ' to ' +
    b.getDate() + ' ' + MONNAME[b.getMonth()] + ' ' + b.getFullYear() + '</h1>' +
    '<p>' + esc(who) + (feedAsOf ? '. Whiteboard read at ' + esc(feedAsOf.toLocaleString()) : '') + '</p>';
}

/* ------------------------------------------------------------------- wire */

function openPane(id) { $(id).hidden = false; }
function closePane(id) { $(id).hidden = true; }

function clockInput(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
function inputToMins(v) {
  var p = String(v || '').split(':');
  if (p.length < 2) return null;
  return (+p[0]) * 60 + (+p[1]);
}

function applySettingsToForm() {
  $('endpoint').value = S.endpoint;
  $('dayStart').value = clockInput(S.dayStart);
  $('dayEnd').value = clockInput(S.dayEnd);
  $('minWindow').value = String(S.minWindow);
  $('buffer').value = String(S.buffer);
  $('allowPartial').checked = !!S.allowPartial;
  $('skipCancelled').checked = !!S.skipCancelled;
  ['flying', 'ground', 'na', 'supervision', 'academics'].forEach(function (k) {
    $('sec_' + k).checked = !!S.sections[k];
  });
  $('toggleWindows').checked = !!S.showWindows;
  $('toggleOthers').checked = !!S.showOthers;
  $('toggleAttendees').checked = !!S.showAttendees;
  $('toggleNow').checked = !!S.showNow;
  $('toggleEvents').checked = !!S.showEvents;
  $('layout').value = S.layout;
  $('zoom').value = String(S.zoom);
  $('shareFence').checked = !!S.shareFence;
}

function drawGroups() {
  var sel = $('groupPick');
  if (!sel) return;
  var names = Object.keys(S.groups).sort(function (a, b) { return a.localeCompare(b); });
  sel.innerHTML = '';
  var first = document.createElement('option');
  first.value = '';
  first.textContent = names.length ? 'Saved groups' : 'No saved groups yet';
  sel.appendChild(first);
  names.forEach(function (n) {
    var o = document.createElement('option');
    o.value = n;
    o.textContent = n + ' (' + S.groups[n].length + ')';
    sel.appendChild(o);
  });
}

function drawNameEditor() {
  var host = $('nameEditor');
  host.innerHTML = '';
  if (!rawNames.length) { host.innerHTML = '<p class="empty">Load the schedule first.</p>'; return; }
  rawNames.forEach(function (raw) {
    var row = document.createElement('div');
    row.className = 'name-row';
    var left = document.createElement('div');
    left.className = 'raw';
    left.textContent = raw;
    left.title = raw;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = S.aliases[raw.toLowerCase()] || '';
    input.placeholder = raw;
    input.setAttribute('data-raw', raw.toLowerCase());
    input.setAttribute('aria-label', 'Display name for ' + raw);
    row.appendChild(left); row.appendChild(input);
    host.appendChild(row);
  });
}

function fitDay() {
  var lo = null, hi = null;
  for (var i = 0; i < 5; i++) {
    eventsOn(iso(addDays(weekStart, i))).forEach(function (ev) {
      if (ev.allDay) return;
      var sel = active();
      if (sel.length && !ev.people.some(function (p) { return sel.indexOf(p) >= 0; })) return;
      if (lo === null || ev.s < lo) lo = ev.s;
      if (hi === null || ev.e > hi) hi = ev.e;
    });
  }
  if (lo === null || hi === null) { msg('linkMsg', 'No timed events this week to fit to.', 'bad'); return; }
  S.dayStart = Math.max(0, Math.floor(lo / 30) * 30 - 30);
  S.dayEnd = Math.min(1440, Math.ceil(hi / 30) * 30 + 30);
  if (S.dayEnd - S.dayStart < 120) S.dayEnd = Math.min(1440, S.dayStart + 120);
  saveSettings();
  applySettingsToForm();
  reparse();
  drawAll();
  msg('linkMsg', 'Day set to ' + hhmm(S.dayStart) + ' to ' + hhmm(S.dayEnd) + '.', 'ok');
}

function init() {
  loadSettings();
  readHash();
  try {
    narrowMq = window.matchMedia('(max-width: 760px)');
    var onNarrow = function () { resetFocusDay(); drawBoard(); };
    if (narrowMq.addEventListener) narrowMq.addEventListener('change', onNarrow);
    else if (narrowMq.addListener) narrowMq.addListener(onNarrow);
  } catch (e) { narrowMq = { matches: false }; }
  resetFocusDay();
  applyTheme();
  applyRail();
  applySettingsToForm();
  drawGroups();
  setState('Loading', 'warn');
  drawAll();

  $('prevWeek').addEventListener('click', function () { goWeek(-7); });
  $('nextWeek').addEventListener('click', function () { goWeek(7); });
  $('thisWeek').addEventListener('click', function () { goWeek(0); });

  $('railBtn').addEventListener('click', function () {
    S.railOff = !S.railOff;
    applyRail(); saveSettings(); drawBoard();
  });

  $('themeBtn').addEventListener('click', function () {
    S.theme = (S.theme === 'light') ? 'dark' : 'light';
    applyTheme();
    saveSettings();
  });

  $('settingsBtn').addEventListener('click', function () {
    applySettingsToForm(); drawNameEditor(); openPane('settingsScrim');
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
    b.addEventListener('click', function () { closePane(b.getAttribute('data-close')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.scrim'), function (sc) {
    sc.addEventListener('click', function (e) { if (e.target === sc) sc.hidden = true; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      Array.prototype.forEach.call(document.querySelectorAll('.scrim'), function (sc) { sc.hidden = true; });
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    var open = document.querySelector('.scrim:not([hidden])');
    if (open) return;

    if (e.key === 'ArrowLeft') {
      if (narrow() && focusDay > 0) { focusDay--; drawBoard(); } else { goWeek(-7); if (narrow()) { focusDay = 4; drawBoard(); } }
    } else if (e.key === 'ArrowRight') {
      if (narrow() && focusDay < 4) { focusDay++; drawBoard(); } else { goWeek(7); }
    } else if (e.key === 't' || e.key === 'T') { goWeek(0); }
    else if (e.key === 'b' || e.key === 'B') { $('railBtn').click(); }
    else if (e.key === 'w' || e.key === 'W') { $('toggleWindows').checked = !$('toggleWindows').checked; S.showWindows = $('toggleWindows').checked; saveSettings(); drawBoard(); }
    else if (e.key === 'd' || e.key === 'D') { $('themeBtn').click(); }
    else if (e.key === 'r' || e.key === 'R') { $('reloadBtn').click(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); $('settingsBtn').click(); }
    else if (e.key === '/') { e.preventDefault(); if (S.railOff) $('railBtn').click(); $('rosterSearch').focus(); }
    else return;
    e.preventDefault();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('is-on'); });
      Array.prototype.forEach.call(document.querySelectorAll('.tabpane'), function (x) { x.classList.remove('is-on'); });
      t.classList.add('is-on');
      $(t.getAttribute('data-tab')).classList.add('is-on');
    });
  });

  $('rosterSearch').addEventListener('input', drawRoster);
  $('clearPicks').addEventListener('click', function () {
    picked = []; S.muted = []; saveSettings(); drawAll();
  });
  $('pickAll').addEventListener('click', function () {
    var filter = ($('rosterSearch').value || '').toLowerCase();
    rosterNames().forEach(function (n) {
      if ((!filter || n.toLowerCase().indexOf(filter) >= 0) && picked.indexOf(n) < 0) picked.push(n);
    });
    picked.sort(function (a, b) { return a.localeCompare(b); });
    saveSettings(); drawAll();
  });

  ['toggleWindows|showWindows', 'toggleOthers|showOthers',
   'toggleAttendees|showAttendees', 'toggleNow|showNow',
   'toggleEvents|showEvents'].forEach(function (pair) {
    var p = pair.split('|');
    $(p[0]).addEventListener('change', function () { S[p[1]] = $(p[0]).checked; saveSettings(); drawBoard(); });
  });

  $('layout').addEventListener('change', function () {
    S.layout = $('layout').value; saveSettings(); drawBoard();
  });
  $('zoom').addEventListener('change', function () {
    S.zoom = +$('zoom').value; saveSettings(); drawBoard();
  });
  $('fitBtn').addEventListener('click', fitDay);

  $('groupPick').addEventListener('change', function () {
    var name = $('groupPick').value;
    if (!name || !S.groups[name]) return;
    var live = rosterNames();
    var wanted = S.groups[name].filter(function (p) { return live.indexOf(p) >= 0; });
    var lost = S.groups[name].length - wanted.length;
    picked = wanted.slice().sort(function (a, b) { return a.localeCompare(b); });
    saveSettings(); drawAll();
    if (lost) msg('linkMsg', lost + ' name' + (lost === 1 ? '' : 's') + ' in that group are not on the schedule this week.', 'bad');
    else msg('linkMsg', '', '');
  });

  $('saveGroup').addEventListener('click', function () {
    if (!picked.length) { msg('linkMsg', 'Pick some names before saving a group.', 'bad'); return; }
    var name = window.prompt('Name this group', $('groupPick').value || '');
    if (name === null) return;
    name = name.trim();
    if (!name) { msg('linkMsg', 'A group needs a name.', 'bad'); return; }
    S.groups[name] = picked.slice();
    saveSettings(); drawGroups();
    $('groupPick').value = name;
    msg('linkMsg', 'Saved "' + name + '" with ' + picked.length + ' names.', 'ok');
  });

  $('deleteGroup').addEventListener('click', function () {
    var name = $('groupPick').value;
    if (!name) { msg('linkMsg', 'Choose a group to delete first.', 'bad'); return; }
    delete S.groups[name];
    saveSettings(); drawGroups();
    msg('linkMsg', 'Deleted "' + name + '".', 'ok');
  });

  $('linkBtn').addEventListener('click', function () {
    var url = buildLink();
    try { history.replaceState(null, '', url); } catch (e) {}
    var done = function () {
      msg('linkMsg', 'Link copied. It opens on this week with these names ticked.', 'ok');
      setTimeout(function () { msg('linkMsg', '', ''); }, 5000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fail);
    else fail();
    function fail() { msg('linkMsg', 'Could not copy. The address bar now holds the link.', 'bad'); }
  });

  $('loadBtn').addEventListener('click', function () {
    S.endpoint = $('endpoint').value.trim();
    saveSettings();
    loadFeed(S.endpoint);
  });
  $('reloadBtn').addEventListener('click', function () { loadFeed(S.endpoint); });
  $('resetEndpoint').addEventListener('click', function () {
    S.endpoint = DEFAULT_ENDPOINT;
    $('endpoint').value = DEFAULT_ENDPOINT;
    saveSettings();
    loadFeed(S.endpoint);
  });
  $('loadPasteBtn').addEventListener('click', function () {
    var text = $('jsonPaste').value.trim();
    if (!text) { msg('sourceMsg', 'Paste the JSON first.', 'bad'); return; }
    try { ingest(JSON.parse(text), 'pasted'); drawNameEditor(); msg('sourceMsg', 'Loaded.', 'ok'); }
    catch (err) { msg('sourceMsg', err.message, 'bad'); setState(err.message, 'bad'); }
  });

  $('saveNames').addEventListener('click', function () {
    var map = {};
    Array.prototype.forEach.call($('nameEditor').querySelectorAll('input'), function (inp) {
      var v = inp.value.trim();
      if (v) map[inp.getAttribute('data-raw')] = v;
    });
    var before = {};
    rawNames.forEach(function (r) { before[r] = displayName(r); });
    S.aliases = map;
    relabel();
    picked = picked.map(function (p) {
      for (var r in before) if (before[r] === p) return displayName(r);
      return p;
    }).filter(function (v, i, arr) { return arr.indexOf(v) === i; });
    var live = rosterNames();
    picked = picked.filter(function (p) { return live.indexOf(p) >= 0; });
    if (lastPayload) reparse(); else { saveSettings(); drawAll(); }
  });

  $('resetNames').addEventListener('click', function () {
    S.aliases = {};
    relabel(); drawNameEditor();
    var live = rosterNames();
    picked = picked.filter(function (p) { return live.indexOf(p) >= 0; });
    saveSettings(); drawAll();
  });

  ['dayStart', 'dayEnd'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var v = inputToMins($(id).value);
      if (v === null || isNaN(v)) return;
      S[id] = v; saveSettings(); reparse(); drawAll();
    });
  });
  ['minWindow', 'buffer'].forEach(function (id) {
    $(id).addEventListener('change', function () { S[id] = +$(id).value; saveSettings(); drawAll(); });
  });
  $('allowPartial').addEventListener('change', function () { S.allowPartial = $('allowPartial').checked; saveSettings(); drawAll(); });
  $('skipCancelled').addEventListener('change', function () { S.skipCancelled = $('skipCancelled').checked; saveSettings(); reparse(); });
  ['flying', 'ground', 'na', 'supervision', 'academics'].forEach(function (k) {
    $('sec_' + k).addEventListener('change', function () {
      S.sections[k] = $('sec_' + k).checked; saveSettings(); reparse(); drawNameEditor();
    });
  });

  $('shareBtn').addEventListener('click', function () { refreshShare(); openPane('shareScrim'); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="shareMode"]'), function (r) {
    r.addEventListener('change', refreshShare);
  });
  $('shareFence').addEventListener('change', function () { S.shareFence = $('shareFence').checked; saveSettings(); refreshShare(); });
  $('copyShare').addEventListener('click', function () {
    var ta = $('shareText');
    var done = function () { msg('copyMsg', 'Copied.', 'ok'); setTimeout(function () { msg('copyMsg', '', ''); }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, fallback);
    else fallback();
    function fallback() {
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { msg('copyMsg', 'Copy did not work. Select the text and copy it manually.', 'bad'); }
    }
  });

  $('printBtn').addEventListener('click', function () { drawPrint(); window.print(); });

  if (S.endpoint) loadFeed(S.endpoint);
  else setState('No endpoint set', 'idle');

  /* The service rebuilds its cache every 15 minutes, so match that. */
  refreshTimer = setInterval(function () {
    if (S.endpoint && !document.hidden) loadFeed(S.endpoint);
  }, 15 * 60 * 1000);

  setInterval(function () {
    freshness();
    if (S.showNow) drawBoard();
  }, 60 * 1000);

  window.addEventListener('hashchange', function () {
    readHash();
    if (pendingPicked) {
      var live = rosterNames();
      picked = pendingPicked.filter(function (p) { return live.indexOf(p) >= 0; });
      pendingPicked = null;
    }
    drawAll();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
