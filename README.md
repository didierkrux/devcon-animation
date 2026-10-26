# Devcon talk intros

Per-talk intro videos for Devcon 8: the intro animation plays, its transparent iris opens onto the talk's official AV card (from devcon.org), and the card holds. Each video lands in the AV team's Drive next to the talk's intro card:

```
AV/$$EVENT/<Room>/<Day N - Mon D>/YouTube Cards/HH.mm <Title> [CODE].jpg     (devcon-api av-assets)
AV/$$EVENT/<Room>/<Day N - Mon D>/Intro Animation/HH.mm <Title> [CODE] (1920x1080).mp4   (this repo, every talk)
AV/$$EVENT/<Room>/<Day N - Mon D>/Intro Animation/HH.mm <Title> [CODE] (3192x1512).mp4   (this repo, stage screen size)
```

Screen sizes per stage are in `src/screens.ts` (AV spec, 22 Oct): Lotus 1/3 3192x1512, Lotus 2 and Main Stage 4032x1512, Jasmine Stage 4 1680x1008. The 16:9 intro and card scale to fill, so wider screens crop the top and bottom. Changing a size there re-renders and renames that stage's files on the next sync. Set `STREAM_ONLY=1` to make only the 1920x1080 versions.

## How a sync run works

`pnpm sync` does one pass and records everything in SQLite (`data/sync.db`):

1. Pulls the schedule from api.devcon.org and diffs it against the last run (added, removed, title, room, time, do-not-record). A talk counts as removed after it's missing from two runs in a row.
2. Re-fetches a talk's card only when its session data changed; logs when the card image itself changed.
3. Renders only videos whose card, size, the intro clip, or the composition code changed.
4. Uploads to Drive, moving/renaming when the card moved to another room or day, and trashing animations for removed or do-not-record talks. A talk whose card isn't in Drive yet waits for the next run.

```bash
pnpm sync                  # one run
pnpm sync RPAPTP           # render/upload only these codes (diff still covers all)
pnpm sync --dry-run        # show the schedule diff, change nothing
pnpm sync --no-upload      # render without touching Drive
pnpm sync --every 30       # loop
pnpm sync --every 30 --port 3000   # loop + HTTP API to start runs on demand (what the container runs)

pnpm status                # overview, recent runs, latest changes
pnpm status --run 12       # everything that happened in run 12
pnpm status --talk RPAPTP  # one talk's state and history
pnpm status --problems     # talks stuck on something

pnpm dev                   # Remotion Studio (uses data/public, filled by sync)
```

## Setup

```bash
pnpm install
cp .env.example .env       # service account + AV folder id
pnpm sync
```

## Deploy (Coolify)

Build from this repo's `Dockerfile`, mount a persistent volume at `/data`, and set the variables from `.env.example`. The container runs `pnpm sync --every ${SYNC_EVERY_MINUTES:-30} --port ${PORT:-3000}`. One run at a time is enforced with a lock file in `/data`.

## Starting a run on demand

Set `TRIGGER_TOKEN` and the container answers on `PORT` (3000):

```bash
# full run now (restarts the timer)
curl -X POST -H "Authorization: Bearer $TRIGGER_TOKEN" https://devcon-intro.pblvrt.com/run
# only re-render/upload these talks (the schedule diff still covers all)
curl -X POST -H "Authorization: Bearer $TRIGGER_TOKEN" -H 'content-type: application/json' \
  -d '{"codes":["RPAPTP","KWXPU8"]}' https://devcon-intro.pblvrt.com/run
# running / queued / next scheduled / last run
curl -H "Authorization: Bearer $TRIGGER_TOKEN" https://devcon-intro.pblvrt.com/status
```

A request during a run is queued and starts right after it; several requests merge into one run. `GET /health` needs no token.

## Replacing the intro animation

`assets/intro.webm` is the intro with alpha (VP9). From a new ProRes/QuickTime master:

```bash
ffmpeg -i Devcon-8-India-AV-intro-animation-rN.mov -map 0:v:0 -map 0:a:0 \
  -c:v libvpx-vp9 -pix_fmt yuva420p -crf 18 -b:v 0 -row-mt 1 -auto-alt-ref 0 \
  -c:a libopus -b:a 192k assets/intro.webm
pnpm intro                 # re-reads when the iris opens/clears -> src/intro-meta.json
```

The next sync re-renders and re-uploads every talk.
