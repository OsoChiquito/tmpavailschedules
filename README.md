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

## Appearance

Dark by default, matching the TPS Schedule viewer, with a light mode behind the
moon icon in the top bar. The first visit follows your system setting; after that
your choice is remembered.

Colours follow the viewer, with one deliberate change. Green is reserved entirely
for availability, so flying events use cyan rather than the viewer's green.
Everyone-free windows are the strong green, most-of-the-group-free windows are the
pale dashed green. Ground stays amber, not available stays red, supervision stays
purple.

Availability bands sit in a reserved strip down the left of each day column so
they can never be covered by an event card. Event text is drawn to fit the block:
tall blocks get time, event name and attendees, short ones drop to a single line.

## Getting around

The side panel hides with the panel icon in the top bar or the <kbd>B</kbd> key,
which widens the board for a dense week. Other keys: arrows move a week,
<kbd>T</kbd> jumps back to this week, <kbd>W</kbd> toggles the availability
shading, <kbd>D</kbd> switches dark and light, <kbd>R</kbd> reloads, <kbd>S</kbd>
opens settings, and <kbd>/</kbd> jumps to the name filter.

A red line marks the current time on today's column. Row height has compact,
normal and tall settings, and **Fit the day to this week** sets the working day
from the earliest and latest events actually on the board rather than a fixed
0700 to 1700.

Clicking a roster category heading, such as Staff IP, selects or clears everyone
in it at once.

**Saved groups** stores a set of names under a label so a recurring team can be
recalled in one click. If someone in a saved group is not on the schedule for the
week you are viewing, the board says how many were dropped rather than silently
ignoring them.

**Copy a link to this view** produces a URL carrying the ticked names and the
week. Anyone opening it lands on the same view, which is easier than describing
who to tick. The names live in the link, not on a server.

The board reloads itself every 15 minutes to match the service, and skips the
reload when the tab is in the background. The status line under the title says
how long ago the Whiteboard was actually read, and flags it when that exceeds
25 minutes during working hours.

## On a phone

Below 760px the board stops trying to show five columns abreast. A row of day
chips appears above the grid, and one full-width day is drawn at a time, starting
on today when today is in the week being viewed. Tapping a chip switches days;
the week arrows still move a week at a time. A chip for a day the service has not
cached is dimmed, so you can see that before tapping it.

In this mode availability takes 38 percent of the column width and events take the
rest, in place of the fixed pixel strip used on a desktop. Buttons, checkboxes and
the eye toggles all grow to proper touch sizes, and the calendar button on each
window grows to 24px.

Turning off the events layer is worth trying on a phone. One full-width column of
nothing but green windows is the fastest way to answer when the group is free.

## Putting a window on a calendar

Each availability window carries a small calendar button in its top corner.
Clicking it asks for a title, then downloads a `.ics` file for that exact window.
Opening the file adds the hold to Outlook, Apple Calendar or anything else that
reads iCalendar. Google Calendar takes it through Settings, Import.

The title you type is remembered as the default for the next one, so holding
three windows for the same meeting does not mean typing it three times.

The description carries who is free for that window, and for a partial window it
also lists who is not, so the hold explains itself later. Times are written as
plain local wall-clock times with no zone attached, matching the Whiteboard, which
carries none either. The event lands at the time it says.

The file is generated in the browser. Nothing is sent anywhere, and no calendar
account is connected.

## Hiding people without losing them

Every ticked name gets an eye button. Clicking it shuts the eye and takes that
person out of the availability maths and off the board, while leaving them ticked
and leaving them in any saved group. It answers "what would open up if this person
were not needed" without destroying the selection you built.

The counter under the heading reads, for example, `3 counted, 1 hidden`, and the
shared message lists who was left out so nobody reads a window as covering the
whole team. Unticking a name clears its hidden state.

## Emphasis

**Give the width to** chooses how each day column is split between the
availability bands and the event cards: Events keeps availability in a narrow
strip, Both evenly halves the column, and Availability inverts it so the windows
get the room and events shrink to the right-hand edge.

**Show the events layer** turns events off entirely, leaving only the availability
bands across the full column width. That is the cleanest view when the question is
only when the group is free.

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
