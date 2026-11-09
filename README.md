# Tether — After Effects–style tracking for Premiere Pro (CEP panel)

**English** · [Türkçe](README.tr.md)

Tether follows an object in your video (a face, a head, a ball, a cartoon character…) frame by frame and turns its movement into Position / Scale / Rotation keyframes on another clip. Use it to stick a name tag to a player, lock a crosshair onto a target, stabilize shaky footage, or follow a subject with a smooth virtual camera.

The panel is available in **English and Turkish**. Change it in *Settings > General > "Dil / Language"*. New installs follow your system language.

## How it works

1. Select the clip you want to track in the timeline and move the playhead to a frame where the object is clearly visible.
2. Press **Grab frame**, then draw a rectangle over the object. This is the blue **tracking area**. The orange **search area** can be resized from its edges.
3. Press **Track**. With the default method (*Automatic*), Tether first uses point tracking (pyramidal Lucas–Kanade with forward–backward checking). If that is weak, it fills the gaps with template matching (ZNCC).
4. Check the confidence chart under the frame. Yellow frames are weak and red frames are untracked. Go to such a frame, drag the box onto the object and press **Track forward / backward from here**. The frames you correct become anchors, and re-tracking stops at the next anchor or at a scene cut.
5. Select the **target clip(s)**, choose a **mode** and press **Apply**. Press **Undo** to restore the previous state.

Tips:

- The preview and the "Grab frame" image can be zoomed (+ / − buttons or the mouse wheel). To pan, hold the middle or right mouse button, or hold Space and drag.
- For tiny objects such as a mouse cursor in a screen recording, choose *Tracking settings > Method > Cursor / small object*. It tracks at native resolution and separates the object from the background.
- Modes include: move a title or graphic onto the object, stabilize the clip, and reframe (zoom in and keep the object in frame). Presets for common gaming use cases (name tag, crosshair, smooth kill-cam) are in the *Mode* card.
- *Apply to* lets you write the animation to **Motion** (normal) or to a **Transform** effect (needed for motion blur via Shutter Angle).

## Installation

- **Windows:** double-click `kur.bat`.
- **Mac:** run `kur.command`.

Then restart Premiere Pro and open *Window > Extensions > Tether*.

**ffmpeg** is used only to read frames from your video. If it is not found, the installer downloads it once (about 170 MB, internet required) and shows a progress bar. If the download fails, copy `ffmpeg.exe` to `%APPDATA%\Adobe\CEP\Tether_ffmpeg` (Mac: `~/Library/Application Support/Adobe/CEP/Tether_ffmpeg`) by hand. An ffmpeg in your system `PATH` is used too. ffmpeg is a separate project (ffmpeg.org) and is not distributed with this repository.

To uninstall, run `sil.bat`.

### Updating

Open *Tools > Updates* in the panel. Tether can check GitHub once a day, download the new release, verify its checksum and install it without closing Premiere. You can also reinstall at any time with `kur.bat` / `kur.command`.

## Known limits

- Very fast, tiny or occluded objects (for example a ball that touches a leg) can drift. Very fast targets may lag slightly behind.
- Scene cuts need a manual fix: tracking stops at the cut, so go to the new scene, draw the box and press **Track forward from here**.
- There is no two-point, perspective or planar tracking.

## Security and permissions

- Premiere requires **PlayerDebugMode** for unsigned panels. `kur.bat` / `kur.command` enable it for your user account only (Windows: `HKCU\Software\Adobe\CSXS.*`, Mac: `defaults write com.adobe.CSXS.*`). To undo it, run `sil.bat` or delete that registry key / setting yourself.
- The panel reads your clip's media file with the local ffmpeg only and does not upload your video or tracking data anywhere.
- The only network connections are the one-time ffmpeg download during installation and the optional update check against this repository's GitHub releases. Automatic updates can be turned off in *Tools > Updates*.
- The install scripts are short plain text; you can read them before running them.

## Development notes

The tracking engine is `Tether/js/track.js`. It runs in the browser and in Node. To test it, read frames with ffmpeg and call `trackRegion`. The user interface is `index.html`, `css.css` and `Tether/js/main.js`, `ui.js`, `preview.js`. The Premiere (ExtendScript) side is `Tether/jsx/host.jsx`. Translations live in `Tether/js/i18n_en.js` and `i18n.js`.

## License

See the `LICENSE` file in this repository.
