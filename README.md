# Brad's Grease Log

Offline phone app for the service truck: tick off each machine when it's greased, and log fuel, SMU, coolant and oil in the same columns as the paper "Fuel & Oil Usage Sheet". Data stays on the phone (localStorage). Ships as an Android APK and as a web app.

## Using it
- **Machines:** every unit in sheet order with a colour stripe like the sheet. Big ✓ = greased now (Undo in the toast). Tap a ticked machine's ✓ again to remove today's tick. Tap the unit name to log diesel, SMU, coolant, oils, new fob, notes, or a grease at an earlier time; its history is under the form (edit or delete there).
- Green = greased today or within the due period, amber = due tomorrow, red = due/overdue, grey = never logged. Filter **Due** + order **Longest since grease** gives the greasing to-do list.
- **History:** every entry by work day; search one machine.
- **Shift:** one work day in paper-sheet columns with totals, to copy onto the sheet.
- **Settings:** grease due after N days (default 7), work day start (default 06:00, so night shift after midnight counts with the evening before), edit the machine list (one per line), backup / restore / CSV export.

The starting machine list (`units.js`) was read from photos of pages 1-5 of the 12/10/2026 sheet, so some numbers may be wrong, and pages 6-8 are missing. Fix it in Settings > Machines.

## Install on Android (APK)
On the phone, open **https://github.com/Jeh-byte/Brads-Grease-Log/releases/latest/download/grease-log.apk**, tap the download, allow "Install unknown apps" for Chrome if asked, then Install. Install newer APKs over the top to keep the log. Uninstalling deletes the log.

## How the APK is built
Same pipeline as Brad's Pep Log: every push to `main` runs `.github/workflows/android.yml` (Capacitor wrap via `scripts/android-prepare.sh`, Gradle build, signing, emulator smoke test via `scripts/android-smoke.sh`, then a GitHub release). Signing uses the key in `C:\Users\jacqu\peptide-log-signing\` through the repo secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD`.

New script files must be added to `sw.js` and `scripts/android-prepare.sh`. Bump `VERSION` in `sw.js` on every change.

## Local test
`python -m http.server 8765` in this folder, open http://localhost:8765/.
