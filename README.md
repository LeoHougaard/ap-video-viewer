# AP video viewer

A local, black and grey viewer for AP Classroom courses. Choose a course and unit, press Play, and adjust the start, end, or speed while watching. Videos continue in order and skip the parts outside your cutoffs.

## Open the viewer

On Windows, double-click **Open viewer.vbs**. It starts the app quietly and opens your default browser. Python 3.10 or newer is required. `start.bat` is also available if you want to see the server output.

While it is running, bookmark **http://127.0.0.1:8765/** for direct access from Zen, Firefox, Chrome, or Edge. After restarting your computer, double-click the launcher again. The app only listens on this computer.

## Add an AP course once

1. Click **Add videos** in the viewer.
2. Drag **Add to AP viewer** onto your bookmarks bar. You can also copy its bookmark URL and save a bookmark manually. Ctrl+Shift+B shows the bookmarks bar in most desktop browsers, including Zen.
3. Open AP Classroom, sign in, and open any video in the course.
4. Click the saved bookmark while on that AP Classroom page. The viewer opens with every available unit in that course.

Repeat for another course. Existing courses, video order, and cutoffs stay saved. The importer reads video titles and player IDs from the open course page. The app does not need your College Board password. The importer may need updating if AP Classroom changes its page structure.

If you have the old **AP unit importer** bookmark, replace it with the new one to import all units at once. Old single-unit imports still work.

## Watch and adjust

- Choose **Course** and **Unit**, then press **Play** or click a video title.
- Set **Start** and **End** with the sliders, type seconds or `m:ss`, or click **Use current** at the desired point. Changes take effect without reloading the video. Leave End blank to use the full length. **Reset cutoffs** restores the full video.
- Change **Speed** while playing. The box accepts values from 0.25 to 16, including custom values such as 2.25. The browser and video player determine which rates are supported.
- At a video's end cutoff, the next video starts. The final video stops and offers **Replay**.
- Cutoffs and order save automatically. Speed is remembered in the browser. Videos load paused and muted; use the player's sound control when you want audio.

Space toggles playback and the arrow keys skip five seconds when you are not using an input or another control. The arrows beside video titles change their order.

Course libraries, selected unit, order, and cutoffs live in `project.json` beside the app. Existing project files migrate automatically. This file stays out of Git. Each unit's last lesson and playback position are remembered in this browser, along with speed. Reopening restores your place paused and muted; press Play to continue. Clearing browser storage clears these local resume points.

## Recovery and hosted viewer boundary

Keep a private backup of `project.json` before moving the app. To recover on another computer, copy it beside `app.py` and run `start.bat`. Local file courses also need their original video folders. AP streams need an internet connection. Use the same browser and port to keep browser resume points and speed. If the quiet launcher does not open, run `start.bat` to see the Python error; if the port is occupied by another app, choose `STUDY_REEL_PORT` and replace the import bookmark. Do not remove project data to fix a launch problem.

Wait for **Saved** after cutoff or order edits before closing. A **Not saved** message means the server has not accepted those edits: keep the tab open, restore the connection, and press Refresh to retry. If another tab changed units, return that tab to this unit before retrying.

The hosted chemistry viewer at https://hougaard.lakebed.app/workspace/chemistry-videos?unit=3 is a separate implementation owned by the Portfolio repository. Its source is `client/chemistry-watch.js`, `client/chemistry-viewer.tsx`, `client/chemistry-viewer-document.ts`, `server/chemistry-viewer.ts`, and `server/chemistry-video-progress.ts`. The hosted viewer provides custom controls and Lakebed watch history; this local viewer retains multiple courses, native player controls, local files, and export. There is no automatic sync between them.

The shared lesson identity is the Wistia media ID, with units identified as `ap:<courseId>:<unit>` (chemistry is course `7`). Cutoff payloads use `{libraryId, items: [{id, trim, end}]}`, in seconds with `end: null` meaning full length. Local `GET /api/project` reads the active unit, `POST /api/select` selects it, and `POST /api/project` saves its complete ordered list. The hosted adapter passes an explicit library ID to its Lakebed mutation and has separate history/progress endpoints. Do not point this app at hosted APIs or copy browser storage keys between implementations. This boundary was checked against Portfolio source on 2026-11-12, without modifying or deploying it.

## Local video files

Open **Add videos → Local video files**, choose a folder, and load it. The app finds MP4, M4V, MOV, WebM, and MKV files, including subfolders. MP4 and WebM have the widest browser support.

**Export one MP4** joins the local queue using both cutoffs in 720p H.264/AAC, at the source playback speed. Export requires `ffmpeg` and `ffprobe` on PATH, or their full paths in `FFMPEG_PATH` and `FFPROBE_PATH`. Output goes to `exports/combined.mp4`. Source files are unchanged. AP Classroom videos stream through Wistia and are not exported.

## Verification

Run server checks with `python -m unittest discover -s tests -p test_*.py -v`.

For the browser checks, install Playwright with `npm install --no-save --package-lock=false playwright@1.61.1` and `npx playwright install chromium`. Start an isolated server with `python tests/serve.py .test-artifacts/state 8766`. Set `AP_IMPORT_FILE` to a JSON file containing a real import payload with `courseId`, `courseName`, `unit`, and `clips`, then run `node tests/browser.cjs`. Use an empty test project for each run. Tests use a headless, muted browser and leave screenshots in `.test-artifacts`. They cover real AP playback, immediate speed and cutoff changes, saved settings, unit switching, automatic advancement, the final cutoff, and narrow screens.

Run `node tests/recovery.cjs` for a complete server restart and browser reopen check. It starts and stops its own server on port 8770 (`VIEWER_TEST_PORT` overrides it), uses a fresh project under `.test-artifacts`, and leaves your real project untouched. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can point to an existing Playwright installation and Chromium binary.

Verified 2026-11-12: four Python server tests, the browser workflow with real imported chemistry videos, 390px layout inspection, and server restart/new-page resume all passed. Playback was muted throughout. The hosted deployment and physical devices were not tested or changed.

Set `STUDY_REEL_NO_BROWSER=1` to run the app without opening a browser, or `STUDY_REEL_PORT` to change its port. A different port needs a new import bookmark.
