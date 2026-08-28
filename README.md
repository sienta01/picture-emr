# Picture EMR

An electronic medical record for hospitals still running on paper. You photograph
the chart pages; the system keeps them organised per patient, per admission, and
turns the register into a CSV report.

It does **not** ask you to retype the chart. The only things you type are the
identity page fields and the diagnosis.

- Inpatient and outpatient records
- Four photo sections per record: Identity Page, Patient Chart, Lab, Radiology
- Every page a patient has on one screen, kept under the visit it was taken on
- Newest page first, and pages reorder by hand — by finger on a phone, or by mouse
- Rotate and crop a page after it is uploaded; swipe through pages on a phone
- Who's carrying the patient: leader / shared care on the ward, leader / consult in clinic
- CSV report for any date range, defaulting to the current month
- Logins for you and your colleagues, each with their own password
- Runs on your own machine — no cloud, no accounts anywhere else
- **Zero dependencies.** Nothing to install beyond Node itself

---

## Requirements

Node.js 22.5 or newer (24 LTS recommended). Check with:

```bash
node --version
```

There is no `npm install` step. The app uses only what ships inside Node.

## Start it

```bash
npm start
```

The terminal prints the addresses it is listening on:

```
  Picture EMR is running.

    http://localhost:8787
    http://192.168.1.24:8787
```

Open the first one in your browser. On first run you will be asked to create the
account you'll sign in with — pick a password only you know. Nothing is
pre-configured and there is no default password.

The second address is the one to use from a phone or tablet **on the same
hospital network**, which is the practical way to photograph a chart and upload it
without moving files around.

### Locking it to this computer only

If you'd rather nothing be reachable from the network:

```bash
HOST=127.0.0.1 npm start
```

On Windows PowerShell:

```powershell
$env:HOST="127.0.0.1"; npm start
```

## Daily use

**Both lists lead with the patients still in front of you**, each group under its
own heading and count:

| List | Leads with | Then |
| --- | --- | --- |
| Inpatient | **Admitted** — no discharge date yet | **Discharged** |
| Outpatient | **Today** | **Earlier** |

**Admitted patients are listed by ward**, not by date. A round is walked bed by
bed down a corridor, so that is the order the list is in. Wards sort naturally —
*Melati 9* comes before *Melati 10*, not after it — and patients with no ward
recorded go last, since there is nowhere to walk to yet.

Outpatient also leads with an **Outpatients today** count, the number a clinic
session ends on, followed by the running month. Searching and the date filters
work as before and the split still applies; when nothing matches the leading
group you get a plain list instead of an empty heading.

**Today's round.** Every admitted patient carries a **Mark seen** button, on the
list and on the record itself. Tap it when you have been to the bed and it turns
into **✓ Seen today**; the heading above the list counts the round off as you go
— *8 patients · 5 seen today*. Tap it again to undo a wrong bed.

A patient you have not reached yet says when they were last seen — *last seen 16
Aug* — which is the difference between somebody still to get to this morning and
somebody who has been missed for three days. Hovering the tick says who did it,
because *has anyone seen bed 4* is the question two people splitting a ward
actually ask each other.

The date comes from the server, not the phone, so a tablet left on the ward with
a wrong clock cannot file today's round under yesterday. Only today's tick can be
taken back — an earlier day is the record of a round that happened. Discharged
patients and clinic visits have no button: there is no bed to walk to.

**Adding a record.** Inpatient or Outpatient → *New admission* / *New visit*.
Type the MR number first: if that patient already exists, their name, sex, date
of birth and deceased status fill in automatically and the new record is linked
to them. For
outpatients the admission date field is labelled *Visit date* — it's the date the
patient came, exactly as you asked.

**Diagnosis** is a multi-line box. Write one diagnosis per line. Those line breaks
survive into the CSV.

**Discharge date** is left empty while the patient is still admitted. If one gets
entered by mistake, the *Clear* button beside the field empties it — a phone's
date picker has no way to do that on its own, so there is no reaching for a
laptop to undo it.

**Deceased.** Tick *Patient is deceased* and three optional fields appear: date
of death, time of death, and cause. All three are optional on purpose — the ward
knows a patient has died long before the chart says when or of what, and a form
that refused to save without them would just mean the status never got recorded.
Tick it now, fill the rest in when the notes catch up.

This is recorded against the **patient**, not the visit, because a person dies
once. Every record in their chart carries it: a red **DECEASED** badge in the
list beside the date of death, and a line above the record reading *Died 6 Aug
2026 at 04:20 — Septic shock*, with any part you didn't record left out.

Because it belongs to the patient, the app will not let a visit be dated after
the death, and says so by name — *Ahmad Fauzi is recorded as having died on 6 Aug
2026, before this admission date. Check the MR number and the dates.* One wrong
digit in an MR number is how a new admission ends up on a dead patient's chart,
and this is where it gets caught.

An inpatient marked deceased with no discharge date would sit in the ward's
**Admitted** list, so the form says so and asks you to set one. Unticking the box
clears the date, time and cause with it — a record never describes the death of
someone it also calls alive.

**Patient status** records who is carrying the patient. Both kinds of record have
it, and both have a *Leader*. The second option differs because the situations
do:

| Record | Status | Meaning |
| --- | --- | --- |
| Inpatient | Leader | The patient is under your team |
| Inpatient | Shared care | Another team leads; you are consulting |
| Outpatient | Leader | The patient is yours |
| Outpatient | Consult from another dept | Another department asked you to see them |

*Shared care* asks who leads, *Consult* asks which department asked, and neither
saves until you say. The status shows in the list as a badge with the other party
named beside it, so you can see at a glance which patients are actually yours.

**Consulted to** is the other direction. When you are the *Leader*, a field
appears for the departments **you** have asked to see the patient — *Cardiology,
Nephrology*, separated by commas. It shows in the list beside the LEADER badge as
*→ Cardiology, Nephrology*, so the referrals you are waiting on are visible
without opening anything.

It only exists under *Leader*, because referring a patient out is something only
the team carrying them can do. Change the status to shared care or a consult and
the field goes with it — a record never claims to have referred a patient it also
says somebody else is leading.

Switching a record between Inpatient and Outpatient clears a status the other
kind has no equivalent for — a shared-care admission means nothing as a clinic
visit — so you are asked to pick again rather than left with something that reads
wrong.

**Photos.** Open a record, pick the section (Chart, Lab, Radiology, Identity),
then drag photos in, choose files, or tap *Take photo* on a phone to shoot the
page directly. You can select many pages at once. Each page gets an optional
caption — useful for "3 Aug morning round" or "CT thorax".

Uploading shows one row per page with its own bar, under a line reading
*Uploading 4 pages — 2 of 4*. The bar is that page; the line is the batch. Pages
go up one at a time, which is kinder to hospital wifi than six at once. If any
page fails the block stays on screen so you can see which; otherwise it clears
itself.

**Page order.** The newest page is shown **first**, so what you photographed on
this morning's round is at the top instead of behind twenty older pages. The
number in the corner is still the page number counted from the front of the
chart, so a five-page chart reads 5, 4, 3, 2, 1 — the newest page is page 5.

Photograph a chart out of sequence and you can put it right: drag a page by the
**⠿** handle — this works with a finger on a phone as well as a mouse — or tap
the **←** and **→** buttons to move it one place. The order is per section and
saves as soon as you move something.

New photos always land at the end of the chart (so, top of the list), and
selecting several at once uploads them oldest-taken first — so a batch keeps the
order you shot it in, whatever order your phone's picker hands them over.

**Straightening a page.** Upload first, tidy up later — a page photographed
sideways is stored the moment you shoot it and can be fixed whenever. Tap **Edit**
on the page (or *Rotate / crop* while viewing it full screen) for:

- **Rotate left / right** in 90° steps
- **Crop** — drag the frame to move it, drag a corner to trim. Works with a
  finger. Rotating clears the crop, since a frame chosen in the old orientation
  means nothing in the new one.
- **Reset** to put it back

The page keeps its number, its caption and its place in the chart; only the image
changes. Saving re-encodes it as JPEG, so avoid editing the same page over and
over — each round trip costs a little quality. PDFs cannot be rotated here.

All of this happens inside the browser. The server has no image library, and this
app has no dependencies to add one.

**Viewing on a phone.** Tap a page to open it full screen, then:

| Gesture | Does |
| --- | --- |
| Swipe left / right | Previous / next page |
| Swipe down | Close |
| Tap | Zoom in, tap again to zoom out |

Zoomed in, swiping pans around the page instead of changing it. A PDF keeps its
own scrolling and does not swipe — use *Prev* and *Next* for those.

**Speed.** Photos are re-encoded to a 2600 px long edge before upload, which keeps
handwriting legible while cutting storage roughly tenfold. Turn off *Shrink photos
before upload* on the record screen to keep the camera originals untouched.

Three things make the pages move faster over a hospital network:

| | |
| --- | --- |
| **Thumbnails** | A gallery card is a couple of hundred pixels wide and was loading the whole photograph to fill it. A 480 px copy is now made in the browser at upload time and sent up alongside the page. A twenty-page chart screen went from roughly 44 MB to about 1 MB. |
| **WebP** | Pages are stored as WebP where the browser can write it — about a third smaller than the JPEG this app stored before, at slightly *better* fidelity. Browsers that cannot write WebP fall back to JPEG at exactly the quality they always used. |
| **Caching** | A page's address changes whenever its bytes do, so pages and thumbnails are cached for a year and carry an ETag. Opening the same chart twice costs nothing the second time. |

**The stored page is not more compressed than it used to be.** Quality numbers
mean different things to different encoders, so they are set per codec rather
than shared. Measured on a photographed observation chart, against the original:

| What gets stored | Size | Fidelity | On the numbers |
| --- | --- | --- | --- |
| Before — JPEG q0.90 | 975 KB | 38.0 dB | 38.0 dB |
| Now — WebP q0.86 | 623 KB | 38.5 dB | 38.3 dB |
| Fallback — JPEG q0.90 | unchanged | unchanged | unchanged |

Higher is better, and the third column is measured over the printed values and
handwriting alone, which is the part that has to stay readable. The saving comes
from the codec, not from throwing away more of the page. The long edge is still
2600 px, and editing a page still re-encodes at JPEG 0.92 as before.

If you would rather trade size for more margin still, `PAGE_QUALITY` at the top
of the image section in `public/app.js` is the dial: WebP 0.87 is 24% smaller
than the old JPEG, 0.88 is 13% smaller, and both are better again on fidelity.

Opening a page full screen still loads the real thing — the thumbnail is only for
the cards. Pages photographed before this all worked keep loading full size; they
are slower, never broken, and are upgraded the next time one is rotated or
cropped. HEIC and PDF pages have no thumbnail, because the browser cannot decode
them to make one.

Pages still upload **one at a time** rather than in parallel. That is not an
oversight: pages are stored in the order they arrive, and letting several race
would shuffle a chart into an order nobody chose.

### The whole patient in one place

A record screen holds one admission. A patient who keeps coming back raises the
other question — *what have we ever photographed for this person* — and answering
it one record at a time is how the CT from the last admission gets missed.

Open any record of a patient with more than one visit and the top of the screen
carries **All pages for this patient — 3 visits · 27 pages**. That screen has all
of them, and **every page stays under the visit it was taken on**, each group
headed by its own date:

```
12 Aug 2026                    Outpatient · Poli Jantung · Consult      2 pages
   PATIENT CHART 1     RADIOLOGY 1

2 Jul 2026 → 9 Jul 2026        Inpatient · Melati 3 · Leader            5 pages
   IDENTITY PAGE 1     PATIENT CHART 3     LAB 1
```

Newest visit first, and inside a visit the sections run in the same order as the
record's own tabs, newest page first. The number on a page is the page number it
carries on its record, so a page found here can be found there. Each heading
carries **Open record →** for when you want to edit rather than read.

The row of chips at the top narrows the whole screen to one section — tap
**Radiology** to see only imaging, in date order, across every visit the patient
has. Visits holding nothing of that kind drop out rather than sit there empty.

Tapping a page opens it full screen as usual, and from there **the swipes cross
visits**: one run of them walks the patient's entire chart, the newest visit back
to the oldest. The label at the top says which visit and section you are in — *12 Aug
2026 · Patient Chart 2/5 — CT thorax* — so a page can never be read out of
context.

The other way in is the moment you most need it: type a returning patient's MR
number into a new record and the line confirming who they are carries **See their
pages →**. Only the MR number has been typed at that point, so there is nothing
to lose by looking first.

A patient on their first visit gets no such link: their whole chart is the record
screen you are already on.

## Accounts and passwords

Click your name in the top right to reach **Your account**.

**Changing your own password** needs your current one, even though you're already
signed in — otherwise anyone who finds your unlocked browser on the ward could
take the account. Changing it signs you out on every *other* device; the browser
you changed it from stays signed in. That's deliberate: if you're changing the
password because you think someone else got in, leaving their session alive for
another 12 hours would defeat the point.

**Adding colleagues.** The first account created at setup is the administrator.
Administrators see a *People with access* list where they can add someone, give
them a temporary password, change roles, or remove access.

There are two roles:

| Role | Can do |
| --- | --- |
| Standard | Everything clinical — all patient records, photos and reports |
| Administrator | The same, plus managing this list of people |

Note what the roles do **not** do: they don't partition patients. Everyone with a
login sees every record. The role only controls who can manage accounts.

The system prevents you from locking yourself out — you cannot delete your own
account, and the last remaining administrator can't be removed or demoted.

### If you forget your password

There is no email reset, because there's no mail server. Instead, on the machine
running the server:

```bash
npm run reset-password
```

It lists the accounts, asks which one, and asks for a new password twice. To skip
the first prompt:

```bash
npm run reset-password -- --user drtimothy
```

This script has no password of its own, which looks like a hole but isn't:
**anyone who can run it can already open `data/emr.db` and read every patient
record directly.** A prompt there would guard nothing. The boundary that actually
matters is who can reach this machine — which is what disk encryption is for.

An administrator can also set a colleague's password directly from the *People
with access* list, which is the quicker fix when someone else is locked out.

## Reports

**Reports** tab → choose Inpatients or Outpatients, set the range, download.

The range defaults to the current month, first day to last day. *Previous month*
and *Next month* jump a whole month at a time.

Columns, exactly as specified:

```
No,Name,Age (M),Age (F),Admission Date,Dx
```

One age value goes into the column matching the patient's sex; the other is left
blank. Age is calculated at the admission/visit date, so a report you run in
December still shows the age the patient was on admission.

Multi-line diagnoses are exported as a proper RFC 4180 quoted field, so Excel,
LibreOffice and Google Sheets all read them back as one cell with the line breaks
intact. If you'd rather have them on a single line, tick *Put each diagnosis on
one line*.

Three optional extras, all off by default so the output matches the spec exactly:
switching the date format to `DD/MM/YYYY`, adding an MR Number column, and adding
a **Consulted To** column. The consults column goes on the end, after `Dx`, so
every existing export keeps the columns it already had in the places they were.

## Where the data lives

Everything is inside `data/`:

| Path | What it is |
| --- | --- |
| `data/emr.db` | SQLite database — patients, records, diagnoses |
| `data/uploads/` | The page photos, one file each |

`data/` is excluded from git by `.gitignore`. **Never commit it.**

Your login lives in the same `emr.db` file as the patients — as a username and a
scrypt hash, never the password itself.

### Upgrading

Pull the new code and restart. Any database changes are applied automatically on
startup and are safe to run repeatedly, so there is no migration command to
remember. Take a backup first anyway.

### Backups

```bash
npm run backup
```

Writes a timestamped snapshot to `backups/` containing a consistent copy of the
database plus every stored photo. Safe to run while the server is up. Copy those
folders somewhere off this machine — an external drive or whatever your hospital
permits.

Restoring is a file copy: stop the server, put `emr.db` and `uploads/` back into
`data/`, start it again.

## Things worth knowing before real patient data goes in

This is the honest list, not a disclaimer.

- **Traffic on the network is not encrypted.** The app speaks plain HTTP. On a
  trusted hospital LAN that is usually accepted, but anyone able to sniff that
  network could read the pages in transit. If your hospital has any policy on
  this, follow it. Putting a TLS-terminating reverse proxy (Caddy, nginx) in
  front is the standard fix, and the app works unchanged behind one.
- **Disk is not encrypted by this app.** Turn on BitLocker (Windows) or FileVault
  (macOS) so the photos aren't readable if the machine is lost or stolen.
- **The data folder currently sits under OneDrive.** That means patient photos
  sync to Microsoft's cloud. That may be exactly what you want for backup, or
  exactly what your hospital forbids. To keep it purely local, point the app
  somewhere off OneDrive:

  ```powershell
  $env:EMR_DATA_DIR="C:\EMR-Data"; npm start
  ```

- **Sessions last 12 hours,** then you sign in again. Failed logins are throttled
  after 10 tries, as are wrong guesses at your current password.
- **Passwords are never stored.** What's in the database is a salted scrypt hash;
  the password itself cannot be read back out of it.
- **Everyone with a login sees every patient.** There is no per-doctor
  partitioning. Only give access to people who should see all of it.
- **Deleting a record deletes its photos** from disk permanently. There is no
  trash. This is why backups matter.
- Check your local regulations on medical record retention and on holding patient
  data on a personal machine. That call is yours to make, not this software's.

## Configuration

Environment variables, all optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | `127.0.0.1` restricts to this machine |
| `EMR_DATA_DIR` | `./data` | Where the database and photos live |
| `EMR_BACKUP_DIR` | `./backups` | Where `npm run backup` writes |

## How it's built

| File | Role |
| --- | --- |
| `server.js` | HTTP server, startup, shutdown |
| `src/routes.js` | Every API endpoint and its validation |
| `src/db.js` | SQLite schema and prepared-statement cache |
| `src/auth.js` | scrypt password hashing, sessions, roles, login throttling |
| `scripts/reset-password.js` | Lockout recovery, run on the server machine |
| `src/storage.js` | Photo files on disk |
| `src/csv.js` | RFC 4180 CSV writer |
| `src/util.js` | Date validation, age calculation |
| `public/` | The whole browser app — vanilla JS, no build step |

Accepted uploads: JPEG, PNG, WebP, GIF, HEIC/HEIF and PDF, up to 40 MB each.
Uploaded files are stored under generated names, never the name the phone
supplied, and are only served to a signed-in session.
