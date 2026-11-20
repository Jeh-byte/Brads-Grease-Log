# Brad's Grease Log

Offline phone app for the service truck: tick off each machine when it's greased, and log fuel, SMU, coolant and oil in the same columns as the paper "Fuel & Oil Usage Sheet". Data stays on the phone (localStorage). Ships as an Android APK and as a web app.

## Using it
- **Machines:** every unit in sheet order with a colour stripe like the sheet. **✓** = greased now (Undo in the toast); tap it again to remove today's tick. **⛽** = quick fuel (litres, optional SMU, "also greased"). Tap the unit name for the full entry: SMU, diesel, coolant, oils, new fob, notes, a problem with a photo, or a grease at an earlier time. History is under the form (edit/delete there).
- Green = greased today or not due yet, amber = nearly due, red = due, grey = never logged. ⚠ on a unit = open problem.
- **Due / Most overdue** gives the to-do list. **My run** shows only the machines picked for this shift ("✎ Pick my run", "+ All due").
- **Needs attention** (red bar at the top): every "New fob needed" and reported problem, with photos, until marked ✓ Fixed.
- **SMU check:** warns when a reading is lower than the last one, higher than a later one, or more hours than have actually passed.
- **History:** every entry by work day; search one machine.
- **Shift:** the paper sheet for one work day: Day/Night, name, truck, fuel filled (A), bulk meter start/finish (B), total issued (C) and variance D = B − C (red when it doesn't balance), supervisor, message, comments, then the unit table with totals. **Send as picture** (PNG laid out like the sheet) or **Send as text** opens the share sheet for WhatsApp/email/SMS. Name, truck and supervisor carry over to the next day.
- **Settings:** default due interval (7 days), a per-type interval in days or SMU hours (hours mode asks for SMU when ticking), work day start (06:00), machine list, crew handover, backup / restore / CSV.
- **Crew handover:** "Send my log to the other crew" shares a file; the other phone taps "Load the other crew's log". Entries, problems, photos and sheet details merge in, deletions carry across (tombstones in `deleted`), and the receiving phone keeps its own machine list and settings. There's no live sync (that would need a server and signal on site).

Storage: records in localStorage (`greaselog.v1`), problem photos in IndexedDB (`greaselog-photos`). Backups include both.

The starting machine list (`units.js`) was read from photos of pages 1-5 of the 12/10/2026 sheet, so some numbers may be wrong, and pages 6-8 are missing. Fix it in Settings > Machines.

## Install on Android (APK)
On the phone, open **https://github.com/Jeh-byte/Brads-Grease-Log/releases/latest/download/grease-log.apk**, tap the download, allow "Install unknown apps" for Chrome if asked, then Install. Install newer APKs over the top to keep the log. Uninstalling deletes the log.

## How the APK is built
Same pipeline as Brad's Pep Log: every push to `main` runs `.github/workflows/android.yml` (Capacitor wrap via `scripts/android-prepare.sh`, Gradle build, signing, emulator smoke test via `scripts/android-smoke.sh`, then a GitHub release). Signing uses the key in `C:\Users\jacqu\peptide-log-signing\` through the repo secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD`.

New script files must be added to `sw.js` and `scripts/android-prepare.sh`. Bump `VERSION` in `sw.js` on every change.

## Local test
`python -m http.server 8765` in this folder, open http://localhost:8765/.
