/* Availability Board
   Reads a Google Sheet of scheduled events, works out when a chosen group of
   people are all free, and draws the result on a Mon-Fri board. */

(function () {
'use strict';

/* ---------------------------------------------------------------- storage */

var store = (function () {
  var mem = {};
  var ok = false;
  try { window.localStorage.setItem('__t', '1'); window.localStorage.removeItem('__t'); ok = true; } catch (e) { ok = false; }
  return {
    get: function (k) { try { return ok ? window.localStorage.getItem(k) : (k in mem ? mem[k] : null); } catch (e) { return null; } },
    set: function (k, v) { try { if (ok) window.localStorage.setItem(k, v); else mem[k] = v; } catch (e) { mem[k] = v; } }
  };
})();

var KEY = 'availability-board.v1';

/* ------------------------------------------------------------------ state */

var DEFAULTS = {
  csvUrl: '',
  dayStart: 7 * 60,
  dayEnd: 17 * 60,
  minWindow: 30,
  buffer: 0,
  allowPartial: false,
  aliases: {},
  cols: { date: 'Date', start: 'Start', end: 'End', title: 'Event', people: 'Attendees', place: 'Location' },
  nameSep: 'auto',
  showWindows: true,
  showOthers: false,
  showAttendees: true,
  shareFence: true
};

var S = clone(DEFAULTS);
var events = [];        // normalised event records
var rawNames = [];      // every distinct spelling seen in the sheet
var picked = [];        // display names currently selected
var weekStart = mondayOf(new Date());
var lastCsv = '';

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function saveSettings() {
  var keep = clone(S);
  keep.picked = picked;
  store.set(KEY, JSON.stringify(keep));
}

function loadSettings() {
  var raw = store.get(KEY);
  if (!raw) return;
  try {
    var got = JSON.parse(raw);
    Object.keys(DEFAULTS).forEach(function (k) {
      if (got[k] !== undefined && got[k] !== null) S[k] = got[k];
    });
    if (Array.isArray(got.picked)) picked = got.picked;
  } catch (e) { /* corrupt settings are not worth surfacing */ }
}

/* ------------------------------------------------------------------- time */

var DAYNAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONNAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function mondayOf(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var shift = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - shift);
  return x;
}

function addDays(d, n) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function iso(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fromIso(s) {
  var p = s.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function hhmm(mins) {
  var m = Math.max(0, Math.round(mins));
  return pad2(Math.floor(m / 60) % 24) + pad2(m % 60);
}

function clock(mins) {
  var m = Math.max(0, Math.round(mins));
  return (Math.floor(m / 60) % 24) + ':' + pad2(m % 60);
}

function dayLabel(d) { return DAYNAME[d.getDay()] + ' ' + d.getDate() + ' ' + MONNAME[d.getMonth()]; }

function parseDate(raw) {
  var s = String(raw || '').trim();
  if (!s) return null;
  s = s.split('T')[0].trim();                                              // ISO datetime
  s = s.replace(/[,]?\s+\d{1,2}:\d{2}(:\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/, '').trim();  // trailing clock time
  var m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/))) {
    var y = +m[3]; if (y < 100) y += 2000;
    return mk(y, +m[1], +m[2]);           // month first, US convention
  }
  if ((m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{2,4})$/))) {
    var mo = monthIndex(m[2]); if (mo < 0) return null;
    var y2 = +m[3]; if (y2 < 100) y2 += 2000;
    return mk(y2, mo + 1, +m[1]);
  }
  if ((m = s.match(/^([A-Za-z]{3,})[\s\-](\d{1,2}),?[\s\-]*(\d{2,4})$/))) {
    var mo2 = monthIndex(m[1]); if (mo2 < 0) return null;
    var y3 = +m[3]; if (y3 < 100) y3 += 2000;
    return mk(y3, mo2 + 1, +m[2]);
  }
  if (/[A-Za-z]/.test(s) || /[\/\-\.]/.test(s)) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  return null;

  function mk(y, mo, da) { return y + '-' + pad2(mo) + '-' + pad2(da); }
}

function monthIndex(name) {
  var n = name.slice(0, 3).toLowerCase();
  for (var i = 0; i < 12; i++) if (MONNAME[i].toLowerCase() === n) return i;
  return -1;
}

function parseTime(raw) {
  var s = String(raw || '').trim().toUpperCase().replace(/\./g, '');
  if (!s) return null;
  s = s.replace(/\s*(LOCAL|ZULU|HRS|HOURS)$/, '').replace(/([0-9])\s*([ZL])$/, '$1').trim();
  var m;
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/))) {
    var h = +m[1], mi = +m[2];
    if (m[3] === 'PM' && h < 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
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

function parseRange(raw) {
  var s = String(raw || '').trim();
  var m = s.match(/^(.+?)\s*(?:-|to|until|\u2013)\s*(.+)$/i);
  if (!m) return null;
  var a = parseTime(m[1]), b = parseTime(m[2]);
  if (a === null || b === null) return null;
  return [a, b];
}

/* -------------------------------------------------------------------- csv */

function parseCsv(text) {
  var rows = [], row = [], field = '', i = 0, inQ = false;
  text = String(text).replace(/\r\n?/g, '\n');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  while (i < text.length) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
}

var SYNONYMS = {
  date: ['date', 'day', 'when', 'start date'],
  start: ['start', 'start time', 'begin', 'from', 'time', 'takeoff', 'brief'],
  end: ['end', 'end time', 'finish', 'to', 'stop', 'land'],
  title: ['event', 'title', 'name', 'activity', 'subject', 'sortie', 'mission', 'summary'],
  people: ['attendees', 'people', 'names', 'crew', 'who', 'participants', 'members', 'assigned'],
  place: ['location', 'place', 'room', 'where', 'venue', 'building']
};

function findColumn(headers, wanted, key) {
  var norm = headers.map(function (h) { return String(h).trim().toLowerCase(); });
  var want = String(wanted || '').trim().toLowerCase();
  var at = norm.indexOf(want);
  if (at >= 0) return at;
  var list = SYNONYMS[key] || [];
  for (var i = 0; i < list.length; i++) {
    var j = norm.indexOf(list[i]);
    if (j >= 0) return j;
  }
  for (var k = 0; k < norm.length; k++) {
    if (want && norm[k].indexOf(want) >= 0) return k;
  }
  return -1;
}

function splitNames(cell) {
  var s = String(cell || '').trim();
  if (!s) return [];
  var sep = S.nameSep;
  if (sep === 'auto') {
    if (s.indexOf(';') >= 0) sep = ';';
    else if (s.indexOf('\n') >= 0) sep = '\n';
    else if (s.indexOf('|') >= 0) sep = '|';
    else if (s.indexOf('/') >= 0) sep = '/';
    else sep = ',';
  }
  if (sep === '\\n') sep = '\n';
  return s.split(sep)
    .map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
    .filter(Boolean);
}

function displayName(raw) {
  var key = String(raw).replace(/\s+/g, ' ').trim();
  var alias = S.aliases[key.toLowerCase()];
  return (alias && alias.trim()) ? alias.trim() : key;
}

/* ---------------------------------------------------------------- loading */

function sheetToCsvUrl(url) {
  var u = String(url || '').trim();
  if (!u) return '';
  if (/output=csv|tqx=out:csv|\.csv(\?|$)/i.test(u)) return u;
  var id = u.match(/\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9\-_]+)/);
  if (!id) return u;
  var gid = u.match(/[#&?]gid=(\d+)/);
  if (/\/spreadsheets\/d\/e\//.test(u)) {
    return 'https://docs.google.com/spreadsheets/d/e/' + id[1] + '/pub?output=csv' + (gid ? '&gid=' + gid[1] : '');
  }
  return 'https://docs.google.com/spreadsheets/d/' + id[1] + '/gviz/tq?tqx=out:csv' + (gid ? '&gid=' + gid[1] : '');
}

function ingest(csvText, label) {
  var rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('That CSV has a header row but no events under it.');
  var head = rows[0];
  var ix = {
    date: findColumn(head, S.cols.date, 'date'),
    start: findColumn(head, S.cols.start, 'start'),
    end: findColumn(head, S.cols.end, 'end'),
    title: findColumn(head, S.cols.title, 'title'),
    people: findColumn(head, S.cols.people, 'people'),
    place: findColumn(head, S.cols.place, 'place')
  };
  if (ix.date < 0) throw new Error('No date column found. Set the column names under Settings, Columns.');
  if (ix.people < 0) throw new Error('No attendee column found. Set the column names under Settings, Columns.');

  var out = [], seen = {}, skipped = 0;
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    var date = parseDate(row[ix.date]);
    if (!date) { skipped++; continue; }

    var s = ix.start >= 0 ? parseTime(row[ix.start]) : null;
    var e = ix.end >= 0 ? parseTime(row[ix.end]) : null;
    if (s === null && ix.start >= 0) {
      var rng = parseRange(row[ix.start]);
      if (rng) { s = rng[0]; e = rng[1]; }
    }
    if (s !== null && e === null) e = s + 60;
    if (s !== null && e !== null && e <= s) e = s + 30;

    var names = splitNames(row[ix.people]);
    names.forEach(function (n) {
      var k = n.replace(/\s+/g, ' ').trim();
      if (k) seen[k] = true;
    });

    out.push({
      date: date,
      allDay: s === null,
      s: s === null ? S.dayStart : s,
      e: e === null ? S.dayEnd : e,
      title: (ix.title >= 0 ? String(row[ix.title] || '').trim() : '') || 'Scheduled',
      place: ix.place >= 0 ? String(row[ix.place] || '').trim() : '',
      rawPeople: names
    });
  }

  events = out;
  rawNames = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  lastCsv = csvText;
  relabel();

  var people = rosterNames();
  picked = picked.filter(function (p) { return people.indexOf(p) >= 0; });

  setState(events.length + ' events, ' + people.length + ' names' +
           (skipped ? ', ' + skipped + ' rows without a usable date' : '') +
           (label ? ' (' + label + ')' : ''), 'ok');
  saveSettings();
  drawAll();
}

function relabel() {
  events.forEach(function (ev) {
    ev.people = ev.rawPeople.map(displayName);
  });
}

function rosterNames() {
  var set = {};
  events.forEach(function (ev) { ev.people.forEach(function (p) { set[p] = (set[p] || 0) + 1; }); });
  return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
}

function loadFromUrl(url) {
  var target = sheetToCsvUrl(url);
  if (!target) { msg('sourceMsg', 'Add a sheet link first.', 'bad'); return; }
  setState('Loading', 'warn');
  msg('sourceMsg', 'Fetching the sheet.', '');
  fetch(target, { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('The sheet returned ' + res.status + '. Check that link sharing is on.');
      return res.text();
    })
    .then(function (text) {
      if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) {
        throw new Error('Google returned a sign-in page. Set the sheet to "Anyone with the link can view", or publish it to the web as CSV.');
      }
      ingest(text, 'from the sheet');
      msg('sourceMsg', 'Loaded.', 'ok');
    })
    .catch(function (err) {
      setState(err.message, 'bad');
      msg('sourceMsg', err.message + ' You can paste the CSV below instead.', 'bad');
    });
}

/* ------------------------------------------------------- availability math */

function eventsOn(dateIso) {
  return events.filter(function (ev) { return ev.date === dateIso; });
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function windowsFor(dateIso) {
  if (!picked.length) return [];
  var ds = S.dayStart, de = S.dayEnd, buf = +S.buffer || 0;
  var busyBy = {};
  picked.forEach(function (p) { busyBy[p] = []; });

  eventsOn(dateIso).forEach(function (ev) {
    var a = ev.allDay ? ds : Math.max(ds, ev.s - buf);
    var b = ev.allDay ? de : Math.min(de, ev.e + buf);
    if (b <= a) return;
    ev.people.forEach(function (p) { if (busyBy[p]) busyBy[p].push([a, b]); });
  });

  var cuts = { };
  cuts[ds] = true; cuts[de] = true;
  picked.forEach(function (p) {
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
    var missing = picked.filter(function (p) {
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
    var free = picked.length - w.missing.length;
    return free >= 2 && free > w.missing.length;
  });
}

function visibleEvents(dateIso) {
  var all = eventsOn(dateIso).filter(function (ev) {
    return ev.allDay || (ev.e > S.dayStart && ev.s < S.dayEnd);
  });
  if (!picked.length) return all.map(tag);
  if (S.showOthers) return all.map(tag);
  return all.filter(function (ev) { return hits(ev).length > 0; }).map(tag);

  function hits(ev) { return ev.people.filter(function (p) { return picked.indexOf(p) >= 0; }); }
  function tag(ev) {
    var o = Object.create(ev);
    o.hits = hits(ev);
    return o;
  }
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

function drawAll() {
  drawWeekLabel();
  drawRoster();
  drawBoard();
  drawPrint();
}

function drawWeekLabel() {
  var a = weekStart, b = addDays(weekStart, 4);
  var left = a.getDate() + ' ' + MONNAME[a.getMonth()];
  var right = b.getDate() + ' ' + MONNAME[b.getMonth()] + ' ' + b.getFullYear();
  $('weekLabel').textContent = left + ' to ' + right;
}

function drawRoster() {
  var host = $('roster');
  var names = rosterNames();
  var filter = ($('rosterSearch').value || '').toLowerCase();
  host.innerHTML = '';

  if (!names.length) {
    host.innerHTML = '<p class="empty">Load a schedule to see names.</p>';
    $('pickCount').textContent = '0 picked';
    return;
  }

  var counts = {};
  events.forEach(function (ev) {
    ev.people.forEach(function (p) { counts[p] = (counts[p] || 0) + 1; });
  });

  var shown = names.filter(function (n) { return !filter || n.toLowerCase().indexOf(filter) >= 0; });
  if (!shown.length) {
    host.innerHTML = '<p class="empty">No names match that filter.</p>';
  }

  shown.forEach(function (n) {
    var on = picked.indexOf(n) >= 0;
    var row = document.createElement('label');
    row.className = 'person' + (on ? ' is-on' : '');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', function () {
      if (box.checked) { if (picked.indexOf(n) < 0) picked.push(n); }
      else picked = picked.filter(function (p) { return p !== n; });
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
    host.appendChild(row);
  });

  $('pickCount').textContent = picked.length + ' picked';
}

function drawBoard() {
  var heads = $('dayHeads'), gutter = $('gutter'), lanes = $('lanes');
  heads.innerHTML = ''; gutter.innerHTML = ''; lanes.innerHTML = '';

  var ds = S.dayStart, de = S.dayEnd;
  if (de <= ds) de = ds + 60;
  var span = de - ds;
  var pxPerMin = span > 720 ? 0.62 : 0.82;
  var height = Math.max(420, span * pxPerMin);

  gutter.style.height = height + 'px';
  lanes.style.height = height + 'px';

  var todayIso = iso(new Date());

  // time gutter, on the half hour
  for (var t = Math.ceil(ds / 30) * 30; t <= de; t += 30) {
    var tick = document.createElement('div');
    var onHour = t % 60 === 0;
    tick.className = 'tick' + (onHour ? ' hour' : '');
    tick.style.top = ((t - ds) * pxPerMin) + 'px';
    tick.textContent = onHour ? hhmm(t) : '';
    gutter.appendChild(tick);
  }

  for (var d = 0; d < 5; d++) {
    var date = addDays(weekStart, d);
    var key = iso(date);
    var isToday = key === todayIso;

    var head = document.createElement('div');
    head.className = 'day-head' + (isToday ? ' is-today' : '');
    head.innerHTML = '<b>' + DAYNAME[date.getDay()] + '</b><span>' + date.getDate() + ' ' + MONNAME[date.getMonth()] + '</span>';
    heads.appendChild(head);

    var lane = document.createElement('div');
    lane.className = 'lane' + (isToday ? ' is-today' : '');
    lanes.appendChild(lane);

    for (var g = Math.ceil(ds / 30) * 30; g <= de; g += 30) {
      var line = document.createElement('div');
      line.className = 'hourline' + (g % 60 ? ' half' : '');
      line.style.top = ((g - ds) * pxPerMin) + 'px';
      lane.appendChild(line);
    }

    if (S.showWindows) {
      windowsFor(key).forEach(function (w) {
        var full = w.missing.length === 0;
        var box = document.createElement('div');
        box.className = 'blk ' + (full ? 'blk-open' : 'blk-partial');
        box.style.top = ((w.s - ds) * pxPerMin) + 'px';
        box.style.height = Math.max(15, (w.e - w.s) * pxPerMin - 2) + 'px';
        var mins = w.e - w.s;
        var note = full
          ? (picked.length > 1 ? 'all ' + picked.length + ' free' : 'free')
          : 'without ' + w.missing.join(', ');
        box.innerHTML = '<span class="t">' + hhmm(w.s) + '-' + hhmm(w.e) + '</span>' +
                        (mins >= 45 ? '<span class="n">' + esc(note) + '</span>' : '');
        box.title = hhmm(w.s) + '-' + hhmm(w.e) + ', ' + dur(mins) + ', ' + note;
        lane.appendChild(box);
      });
    }

    stack(visibleEvents(key)).forEach(function (ev) {
      var box = document.createElement('div');
      var mins = ev.e - ev.s;
      box.className = 'blk blk-busy' +
        (ev.allDay ? ' blk-allday' : '') +
        (mins * pxPerMin < 34 ? ' tiny' : '') +
        (picked.length && !ev.hits.length ? ' is-off' : '');
      box.style.top = ((Math.max(ds, ev.s) - ds) * pxPerMin) + 'px';
      box.style.height = Math.max(15, (Math.min(de, ev.e) - Math.max(ds, ev.s)) * pxPerMin - 2) + 'px';
      var w = 100 / ev.cols;
      box.style.left = 'calc(' + (ev.col * w) + '% + 2px)';
      box.style.width = 'calc(' + w + '% - 4px)';

      var who = ev.hits.length ? ev.hits : ev.people;
      var whoText = who.slice(0, 4).join(', ') + (who.length > 4 ? ' +' + (who.length - 4) : '');
      var html = '<span class="t">' + (ev.allDay ? 'all day' : hhmm(ev.s) + '-' + hhmm(ev.e)) + '</span>' +
                 '<span class="e">' + esc(ev.title) + '</span>';
      if (S.showAttendees && whoText) html += '<span class="w">' + esc(whoText) + '</span>';
      if (ev.place && mins * pxPerMin > 58) html += '<span class="p">' + esc(ev.place) + '</span>';
      box.innerHTML = html;
      box.title = ev.title + '\n' + (ev.allDay ? 'All day' : hhmm(ev.s) + '-' + hhmm(ev.e)) +
                  (ev.place ? '\n' + ev.place : '') +
                  '\n' + ev.people.join(', ');
      lane.appendChild(box);
    });
  }

  var summary = '';
  if (!events.length) summary = 'Nothing loaded yet.';
  else if (!picked.length) summary = 'Pick names to see open windows.';
  else {
    var total = 0, count = 0;
    for (var i = 0; i < 5; i++) {
      windowsFor(iso(addDays(weekStart, i))).forEach(function (w) {
        if (!w.missing.length) { total += w.e - w.s; count++; }
      });
    }
    summary = count
      ? count + ' window' + (count === 1 ? '' : 's') + ' this week, ' + dur(total) + ' in total'
      : 'No window of ' + dur(+S.minWindow) + ' or longer with everyone free';
  }
  $('windowSummary').textContent = summary;
}

function dur(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return m + ' min';
  if (!m) return h + ' hr';
  return h + ' hr ' + m + ' min';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ----------------------------------------------------------------- export */

function buildShareText(mode) {
  var lines = [];
  var who = picked.length ? picked.join(', ') : 'everyone on the schedule';
  var a = weekStart, b = addDays(weekStart, 4);

  lines.push('Availability for ' + who);
  lines.push('Week of ' + a.getDate() + ' ' + MONNAME[a.getMonth()] + ' to ' +
             b.getDate() + ' ' + MONNAME[b.getMonth()] + ' ' + b.getFullYear() +
             ', ' + hhmm(S.dayStart) + ' to ' + hhmm(S.dayEnd) +
             ', windows of ' + dur(+S.minWindow) + ' or more');
  lines.push('');

  if (!picked.length) {
    lines.push('Pick at least one name on the board first.');
    return lines.join('\n');
  }

  for (var i = 0; i < 5; i++) {
    var date = addDays(weekStart, i);
    var key = iso(date);
    var wins = windowsFor(key);
    var full = wins.filter(function (w) { return !w.missing.length; });
    var part = wins.filter(function (w) { return w.missing.length; });
    var label = DAYNAME[date.getDay()] + ' ' + pad2(date.getDate()) + ' ' + MONNAME[date.getMonth()];

    if (mode === 'open') {
      var txt = full.length
        ? full.map(function (w) { return hhmm(w.s) + '-' + hhmm(w.e); }).join(', ')
        : 'nothing open';
      lines.push(padRight(label, 12) + txt);
      part.forEach(function (w) {
        lines.push(padRight('', 12) + hhmm(w.s) + '-' + hhmm(w.e) + ' without ' + w.missing.join(', '));
      });
      continue;
    }

    lines.push(label);
    lines.push('  open   ' + (full.length
      ? full.map(function (w) { return hhmm(w.s) + '-' + hhmm(w.e); }).join(', ')
      : 'nothing'));
    part.forEach(function (w) {
      lines.push('  most   ' + hhmm(w.s) + '-' + hhmm(w.e) + '  without ' + w.missing.join(', '));
    });

    var busy = eventsOn(key)
      .filter(function (ev) { return ev.people.some(function (p) { return picked.indexOf(p) >= 0; }); })
      .sort(function (x, y) { return x.s - y.s; });
    busy.forEach(function (ev, n) {
      var hits = ev.people.filter(function (p) { return picked.indexOf(p) >= 0; });
      var time = ev.allDay ? 'all day  ' : hhmm(ev.s) + '-' + hhmm(ev.e);
      lines.push((n === 0 ? '  busy   ' : '         ') + padRight(time, 11) + ev.title + ' (' + hits.join(', ') + ')');
    });
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function padRight(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function refreshShare() {
  var mode = document.querySelector('input[name="shareMode"]:checked').value;
  var body = buildShareText(mode);
  $('shareText').value = S.shareFence ? '```\n' + body + '\n```' : body;
}

function drawPrint() {
  var a = weekStart, b = addDays(weekStart, 4);
  var who = picked.length ? picked.join(', ') : 'the whole schedule';
  $('printOut').innerHTML =
    '<h1>Availability, week of ' + a.getDate() + ' ' + MONNAME[a.getMonth()] + ' to ' +
    b.getDate() + ' ' + MONNAME[b.getMonth()] + ' ' + b.getFullYear() + '</h1>' +
    '<p>' + esc(who) + '</p>';
}

/* ------------------------------------------------------------------- wire */

function openPane(id) { $(id).hidden = false; }
function closePane(id) { $(id).hidden = true; }

function applySettingsToForm() {
  $('csvUrl').value = S.csvUrl;
  $('dayStart').value = clockInput(S.dayStart);
  $('dayEnd').value = clockInput(S.dayEnd);
  $('minWindow').value = String(S.minWindow);
  $('buffer').value = String(S.buffer);
  $('allowPartial').checked = !!S.allowPartial;
  $('colDate').value = S.cols.date;
  $('colStart').value = S.cols.start;
  $('colEnd').value = S.cols.end;
  $('colTitle').value = S.cols.title;
  $('colPeople').value = S.cols.people;
  $('colPlace').value = S.cols.place;
  $('nameSep').value = S.nameSep;
  $('toggleWindows').checked = !!S.showWindows;
  $('toggleOthers').checked = !!S.showOthers;
  $('toggleAttendees').checked = !!S.showAttendees;
  $('shareFence').checked = !!S.shareFence;
}

function clockInput(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }
function inputToMins(v) {
  var p = String(v || '').split(':');
  if (p.length < 2) return null;
  return (+p[0]) * 60 + (+p[1]);
}

function drawNameEditor() {
  var host = $('nameEditor');
  host.innerHTML = '';
  if (!rawNames.length) {
    host.innerHTML = '<p class="empty">Load a schedule first.</p>';
    return;
  }
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

function init() {
  loadSettings();
  applySettingsToForm();
  setState('No schedule loaded', 'idle');
  drawAll();

  $('prevWeek').addEventListener('click', function () { weekStart = addDays(weekStart, -7); drawAll(); });
  $('nextWeek').addEventListener('click', function () { weekStart = addDays(weekStart, 7); drawAll(); });
  $('thisWeek').addEventListener('click', function () { weekStart = mondayOf(new Date()); drawAll(); });

  $('settingsBtn').addEventListener('click', function () {
    applySettingsToForm();
    drawNameEditor();
    openPane('settingsScrim');
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
    b.addEventListener('click', function () { closePane(b.getAttribute('data-close')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.scrim'), function (sc) {
    sc.addEventListener('click', function (e) { if (e.target === sc) sc.hidden = true; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') Array.prototype.forEach.call(document.querySelectorAll('.scrim'), function (sc) { sc.hidden = true; });
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
  $('clearPicks').addEventListener('click', function () { picked = []; saveSettings(); drawAll(); });
  $('pickAll').addEventListener('click', function () {
    var filter = ($('rosterSearch').value || '').toLowerCase();
    rosterNames().forEach(function (n) {
      if ((!filter || n.toLowerCase().indexOf(filter) >= 0) && picked.indexOf(n) < 0) picked.push(n);
    });
    picked.sort(function (a, b) { return a.localeCompare(b); });
    saveSettings();
    drawAll();
  });

  bindToggle('toggleWindows', 'showWindows');
  bindToggle('toggleOthers', 'showOthers');
  bindToggle('toggleAttendees', 'showAttendees');

  $('loadUrlBtn').addEventListener('click', function () {
    S.csvUrl = $('csvUrl').value.trim();
    saveSettings();
    loadFromUrl(S.csvUrl);
  });
  $('reloadBtn').addEventListener('click', function () {
    if (S.csvUrl) loadFromUrl(S.csvUrl);
    else { applySettingsToForm(); drawNameEditor(); openPane('settingsScrim'); }
  });
  $('loadPasteBtn').addEventListener('click', function () {
    var text = $('csvPaste').value;
    if (!text.trim()) { msg('sourceMsg', 'Paste some CSV first.', 'bad'); return; }
    try { ingest(text, 'pasted'); msg('sourceMsg', 'Loaded.', 'ok'); }
    catch (err) { msg('sourceMsg', err.message, 'bad'); setState(err.message, 'bad'); }
  });
  $('demoBtn').addEventListener('click', function () {
    try { ingest(demoCsv(), 'sample data'); msg('sourceMsg', 'Sample week loaded. Replace it with your own sheet when you are ready.', 'ok'); }
    catch (err) { msg('sourceMsg', err.message, 'bad'); }
    drawNameEditor();
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
    saveSettings();
    drawAll();
    msg('sourceMsg', '', '');
  });

  $('resetNames').addEventListener('click', function () {
    S.aliases = {};
    relabel();
    drawNameEditor();
    var live = rosterNames();
    picked = picked.filter(function (p) { return live.indexOf(p) >= 0; });
    saveSettings();
    drawAll();
  });

  ['dayStart', 'dayEnd'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var v = inputToMins($(id).value);
      if (v === null || isNaN(v)) return;
      S[id] = v;
      saveSettings();
      drawAll();
    });
  });
  ['minWindow', 'buffer'].forEach(function (id) {
    $(id).addEventListener('change', function () { S[id] = +$(id).value; saveSettings(); drawAll(); });
  });
  $('allowPartial').addEventListener('change', function () { S.allowPartial = $('allowPartial').checked; saveSettings(); drawAll(); });

  ['colDate', 'colStart', 'colEnd', 'colTitle', 'colPeople', 'colPlace'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var key = id.replace('col', '').toLowerCase();
      S.cols[key] = $(id).value.trim();
      saveSettings();
      if (lastCsv) { try { ingest(lastCsv, 'recut with new columns'); } catch (e) { msg('sourceMsg', e.message, 'bad'); } }
    });
  });
  $('nameSep').addEventListener('change', function () {
    S.nameSep = $('nameSep').value;
    saveSettings();
    if (lastCsv) { try { ingest(lastCsv, 'recut'); drawNameEditor(); } catch (e) { msg('sourceMsg', e.message, 'bad'); } }
  });

  $('shareBtn').addEventListener('click', function () { refreshShare(); openPane('shareScrim'); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="shareMode"]'), function (r) {
    r.addEventListener('change', refreshShare);
  });
  $('shareFence').addEventListener('change', function () { S.shareFence = $('shareFence').checked; saveSettings(); refreshShare(); });
  $('copyShare').addEventListener('click', function () {
    var ta = $('shareText');
    var done = function () { msg('copyMsg', 'Copied.', 'ok'); setTimeout(function () { msg('copyMsg', '', ''); }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done, fallback);
    } else fallback();
    function fallback() {
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { msg('copyMsg', 'Copy did not work. Select the text and copy it manually.', 'bad'); }
    }
  });

  $('printBtn').addEventListener('click', function () { drawPrint(); window.print(); });

  if (S.csvUrl) loadFromUrl(S.csvUrl);

  function bindToggle(id, key) {
    $(id).addEventListener('change', function () { S[key] = $(id).checked; saveSettings(); drawBoard(); });
  }
}

/* -------------------------------------------------------------- demo data */

function demoCsv() {
  var mon = mondayOf(new Date());
  function d(n) { return iso(addDays(mon, n)); }
  var rows = [
    ['Date', 'Start', 'End', 'Event', 'Attendees', 'Location'],
    [d(0), '0730', '0830', 'Morning stand up', 'Cabrera; Nguyen; Ortiz; Whitfield', 'Bldg 1220'],
    [d(0), '0900', '1130', 'Glider sortie 3', 'Cabrera; Whitfield', 'Ramp'],
    [d(0), '1300', '1500', 'Systems academics', 'Nguyen; Ortiz', 'Room 204'],
    [d(1), '0800', '1000', 'Test plan review', 'Cabrera; Nguyen; Ortiz', 'Room 118'],
    [d(1), '1030', '1200', 'Sim period', 'Whitfield', 'Sim bay 2'],
    [d(1), '1400', '1600', 'Data reduction', 'Cabrera', 'Room 118'],
    [d(2), '', '', 'Safety day', 'Cabrera; Nguyen; Ortiz; Whitfield', 'Auditorium'],
    [d(3), '0700', '0800', 'Weather brief', 'Cabrera; Whitfield', 'Ops'],
    [d(3), '1000', '1130', 'Instrumentation checkout', 'Ortiz; Whitfield', 'Hangar 3'],
    [d(3), '1500', '1700', 'Report writing block', 'Nguyen', 'Room 204'],
    [d(4), '0830', '0930', 'Progress review', 'Cabrera; Nguyen', 'Room 118'],
    [d(4), '1300', '1400', 'Squadron commander call', 'Cabrera; Nguyen; Ortiz; Whitfield', 'Auditorium']
  ];
  return rows.map(function (r) {
    return r.map(function (c) { return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',');
  }).join('\n');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
