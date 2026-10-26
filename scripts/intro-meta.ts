// Reads the intro's alpha channel and records when the transparent iris opens
// (average opacity starts dropping) and when the intro is fully clear. The talk
// card switches on underneath at the first, so the iris never shows black.
//
// Usage: pnpm intro [path/to/intro.webm]   (defaults to assets/intro.webm)
// Writes src/intro-meta.json.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const input = path.resolve(process.argv[2] ?? "assets/intro.webm");
const output = path.resolve("src/intro-meta.json");

const probe = JSON.parse(
  execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,r_frame_rate:format=duration",
    "-of", "json",
    input,
  ]).toString(),
) as { streams: { codec_name: string; r_frame_rate: string }[]; format: { duration: string } };

const { codec_name, r_frame_rate } = probe.streams[0];
const [num, den] = r_frame_rate.split("/").map(Number);
const fps = num / den;
const durationInSeconds = Number(probe.format.duration);

// ffmpeg's native vp9 decoder drops alpha; libvpx keeps it.
const decoder = codec_name === "vp9" ? ["-c:v", "libvpx-vp9"] : [];
const stats = execFileSync(
  "ffmpeg",
  [
    "-v", "error",
    ...decoder,
    "-i", input,
    "-vf", "alphaextract,signalstats,metadata=print:file=-",
    "-f", "null", "-",
  ],
  { maxBuffer: 64 * 1024 * 1024 },
).toString();

// One block per frame: "frame:N pts:... pts_time:T" followed by key=value lines.
const frames: { t: number; avg: number; max: number }[] = [];
for (const block of stats.split(/^frame:/m).slice(1)) {
  const t = Number(/pts_time:([\d.]+)/.exec(block)?.[1]);
  const avg = Number(/lavfi\.signalstats\.YAVG=([\d.e+-]+)/.exec(block)?.[1]);
  const max = Number(/lavfi\.signalstats\.YMAX=([\d.]+)/.exec(block)?.[1]);
  if ([t, avg, max].some(Number.isNaN)) throw new Error(`Unparseable signalstats block: ${block.slice(0, 200)}`);
  frames.push({ t, avg, max });
}
if (frames.length === 0) throw new Error(`No frames decoded from ${input}`);

// The first frame already has a few transparent edge pixels (kept black until
// the card switches on), so the iris "opens" once average opacity falls below
// that baseline at all.
const baseline = frames[0].avg;
const open = frames.find((f) => f.avg < baseline);
const clear = frames.find((f) => f.max < 8);
if (!open || !clear) {
  throw new Error(
    `${path.basename(input)} has no transparent reveal (needs an alpha channel that opens up). ` +
      `Average opacity went from ${baseline} to ${frames[frames.length - 1].avg}`,
  );
}

const result = {
  source: path.basename(input),
  fps,
  durationInSeconds,
  revealStart: open.t,
  revealEnd: clear.t,
};
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(
  `${result.source}: ${durationInSeconds.toFixed(3)}s @ ${fps.toFixed(3)}fps, ` +
    `iris opens ${open.t.toFixed(3)}s, fully clear ${clear.t.toFixed(3)}s`,
);
