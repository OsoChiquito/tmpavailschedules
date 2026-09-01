# Availability Board

A Monday to Friday board that shows when a chosen group of people are all free,
built on the USAF TPS Whiteboard.

It does not read the Whiteboard directly. It asks the existing TPS Schedule Apps
Script for `?mode=full`, which returns every cached day plus the roster in one
request. That service already handles the hard part: finding the day tabs, reading
the fixed row bands, and refreshing every 15 minutes.

```
index.html
styles.css
app.js
```

Drop these three files at the top level of a repository and enable GitHub Pages.
There is no build step and no API key.

## What it does

Tick names in the left rail, grouped by roster category. The board draws every
commitment those people have and shades the gaps where all of them are free.
Committed blocks show the event name and who from your group is in it. The
proposed-window shading toggles off under View.

**Share** produces plain text sized for a Slack or Signal message, either open
times only or open times with the conflicts behind them. Lines stay under 70
characters so they do not wrap on a phone. **Print** gives a landscape page.

## Settings

**Schedule source** holds the Apps Script address. The default points at the
existing deployment. There is also a box for pasting a `?mode=full` response by
hand, for when a network blocks the fetch but not the browser.

**Names** lists every spelling found on the Whiteboard and lets you replace it.
Two spellings mapped to the same name merge into one person.

**Day and windows** sets the working day, the shortest window worth proposing,
optional padding around commitments, and whether to mark windows where most of
the group is free.

**Sections** chooses which parts of the Whiteboard consume someone's time:
flying, ground, not available, supervision, academics. Cancelled events can be
ignored.

## Parsing notes

Row layouts come from `Code.gs` in the upstream project:

```
flying       Model, BriefStart, ETD, ETA, DebriefEnd, Event, Crew..., Notes, Eff, Canc, PartEff
ground       Event, Start, End, People..., Notes, Eff, Canc, PartEff
na           Reason, Start, End, People...
supervision  Duty, then repeating POC, Start, End
```

Three deliberate differences from the upstream reader:

- Crew and people are cut four columns from the end, not three. Cutting at three
  sweeps the Notes cell in as if it were a person.
- Flying events count from brief start through debrief end rather than takeoff to
  landing, because the crew is committed for the whole block. If either is blank,
  ETD and ETA are used instead.
- Supervision entries with no times, such as authorisations, are skipped. They are
  a duty assignment, not a block of time.

Rows with blank start and end become all-day commitments spanning the working day.

## Limits

- The upstream service only caches back to Sunday of the current week and forward
  about two weeks. Days outside that show as "No sheet". Raising `daysToProcess`
  in a fork of the Apps Script is the fix.
- The board depends on a deployment owned by someone else. If that account loses
  Whiteboard access or the deployment is revoked, the board goes dark. Deploying
  your own copy of `Code.gs` and `Config.gs` against the same spreadsheet ID
  removes that dependency.
- All times are read as written, with no time zone conversion.
