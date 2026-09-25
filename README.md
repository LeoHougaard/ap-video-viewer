# AP video viewer prototype

This local app puts one AP Classroom unit into a continuous video queue. It has a speed box, a start time for each video, previous and next buttons, and automatic playback of the next video. You can rearrange the queue with the arrows beside each title. Trims and order stay saved on this computer.

## Start

On Windows, double-click `start.bat`. Python 3.10 or newer is required. On another system, run `python app.py`. The app opens in your browser and listens only on `127.0.0.1`.

## Import an AP unit

1. In the viewer, save **AP unit importer** as a bookmark. Drag it to your bookmarks toolbar, or click **Copy bookmark URL** and paste that into a new bookmark's URL field. Clicking the link in the viewer only shows instructions.
2. Sign in to AP Classroom and open any video in the unit you want.
3. Click the bookmark. The selected unit opens in the viewer.

In Zen, Ctrl+Shift+B toggles the bookmarks toolbar. With Zen's Single Toolbar layout, hover at the top of the window to reveal it. The same bookmarklet approach works in desktop browsers that allow JavaScript bookmarks. The app uses port 8765 by default so saved bookmarks keep working after a restart.

The importer reads the video titles and player IDs from the page already open in your browser. It does not ask for or store your College Board password. AP videos stream from Wistia while you watch. The importer depends on AP Classroom's current page structure, so a site redesign may require an update.

AP Classroom streams cannot be exported here. [College Board's AP Services terms](https://secure-media.collegeboard.org/apc/ap-services-terms-conditions.pdf) restrict downloading and modifying its content without written permission.

## Use local video files

Open **Use local video files**, choose a folder, and load it. The app finds MP4, M4V, MOV, WebM, and MKV files inside that folder and its subfolders. Browser playback works best with MP4 or WebM. Set a start time for each clip or use **Set to current time** when the lesson begins.

**Export one MP4** joins the local queue with its trims in 720p H.264/AAC. Export needs `ffmpeg` and `ffprobe` on your PATH, or their full paths in the `FFMPEG_PATH` and `FFPROBE_PATH` environment variables. [FFmpeg's download page](https://ffmpeg.org/download.html) links to builds for each operating system. The result is saved as `exports/combined.mp4` beside this app.

The viewer never changes your source files. It saves the selected folder, queue order, and trims in `project.json` beside the app.
