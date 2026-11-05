# Jobs

Runs conversions in parallel and shows them in the toast in the bottom-right corner: a card per file with a progress ring, or one summary card when more than three are running.

## How it works

`Jobs` (`jobs.js`) takes a `convert(src, to, { onProgress, signal })` function and queues one job per file and target, three at a time. Each job has an `AbortController`; the X on a card, or on the summary, aborts it. `view()` turns the state into the cards the toast draws; the app sends it to the window on every `change` event.

`estimate.js` turns what an engine reports, or the time since the job started, into a progress fraction that never goes backwards, and into "about 40 s left". `Timings` learns how long each kind of conversion takes on this PC (`timings.json`, key `from>to`) and uses that for the estimate; until then `guessMs` gives a first guess.

The toast window (`toast.window.js`) is a transparent, always-on-top window that never takes focus. It grows upward with the number of cards. `toast.ipc.js` has the messages from its page (`ui/`).

## Files

| File | Role |
|---|---|
| `index.js` | `Jobs`, `Timings`, `Toast` |
| `jobs.js` | The queue, the cards, the summary |
| `estimate.js` | Progress and time left, learned timings |
| `toast.window.js`, `toast.ipc.js` | The window and its messages |
| `ui/` | `toast.html`, `toast.css`, `toast.js`, `preload.js` |

## Contracts

- `Jobs` gets `formats = { extOf, kinds }` from the app (the conversion feature's `timingFormats`), because features do not import each other. `extOf` names the format a file is timed under: `photo.JPEG` and `photo.jpg` are one.
- `timings.json` keys have the form `from>to`.
- IPC channels: `toast:view` (to the page), `toast:ready`, `toast:reveal`, `toast:remove`, `toast:cancel`.

## Testing

`node test/unit/jobs/jobs.test.js` (logic, under a second); `npx electron test/ui/toast-shot.js` (the window and screenshots, about 10 s).
