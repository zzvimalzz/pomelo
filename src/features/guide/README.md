# Guide

A window that shows how Pomelo works: an animation of the gesture (drag a file, tap Ctrl, drop it on a format), seven short questions with answers, and a button to the website. The answers use numbered steps, and three of them have a picture: the tray and its "show hidden icons" pop-up, the right-click menus, and the original next to its converted file. It opens by itself the first time Pomelo starts, and from the **?** button in Settings.

## How it works

`guide.window.js` opens one window, 520 px wide. It is as tall as its page, up to the screen: the page reports its height (`guide:fit`, through the shared `fitContentHeight`) and the window shows itself on the first report, so it never appears at the wrong size. Only one question is open at a time, which keeps the window from jumping far. `guide.ipc.js` answers the page: `guide:data` gives the three sample files (`Report.docx`, `Budget.xlsx`, `Photo.png`) with the formats each can become, taken from the app through `describe(name)`; `guide:website` opens `https://pomelo.swymble.com` in the browser (the address is fixed in the main process; the page cannot send one), and `guide:close` closes the window.

The page builds the animation from the same code the real wheel uses (`ui-shared/wheel-shapes.js`, `wheel-glyphs.js`, `wheel-icons.js`), with the formats of this PC, so what it shows is what the wheel would show. Each time the ten-second loop starts again the page moves on to the next sample file (the picked-up tile, the wheel, the result and the start point of the drag change), so all three are shown in turn. The motion itself is CSS only: one loop of ten seconds in `ui/guide.css`, where every animation has the same length so they cannot drift apart. Only `opacity`, `translate`, `scale`, `rotate` and the ring's `stroke-dashoffset` change, which keeps it smooth. With reduced motion in Windows the animation stops on a still picture of the open wheel. The wheel's segments appear one after another through a negative `animation-delay`; this works because the end of the loop equals its start.

The pictures in the answers are drawn in HTML and CSS (not screenshots), so they follow the light or dark theme and stay sharp at any scale; the file pair is built by `guide.js` from the same icon code as the animation. Keep each answer short: the window can be no taller than the screen, and the test checks that the longest answers still fit without a scrollbar.

The app decides when to open it: `main.js` shows it before Settings when no settings file existed yet, and Settings opens when it is closed.

## Files

| File | Role |
|---|---|
| `index.js` | `openGuideWindow(asset, { onClosed })`, `registerGuideIpc({ describe })` |
| `guide.window.js`, `guide.ipc.js` | The window and its messages |
| `ui/` | `guide.html`, `guide.css` (layout and the timeline), `guide.js` (builds the wheel and icons), `preload.js` |

## Contracts

- IPC channels: `guide:data` (invoke), `guide:fit`, `guide:website`, `guide:close`.
- Nothing on the page can be selected.
- The animation needs no network and no script timing. The page keeps the strict Content-Security-Policy, so nothing in it uses an inline style attribute.
- Changing the timeline: the percentages in `guide.css` are seconds divided by ten. Keep every animation at `10s` and make the last keyframe of each equal its first, or the loop will jump.

## Testing

`npx electron test/ui/guide-shot.js` opens the real window, pauses the animation at fixed moments of the loop and checks what is visible, that only those properties animate, the questions, the buttons, reduced motion and the light theme. It saves screenshots to `test/shots/`.
