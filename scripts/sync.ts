// One pipeline run: Devcon schedule -> diff against the last run (SQLite) ->
// fetch changed cards -> render changed talks -> place them in the AV Drive.
//
// Usage:
//   pnpm sync                    # full run
//   pnpm sync RPAPTP KWXPU8      # limit render/upload to these talk codes (schedule diff still covers all)
//   pnpm sync --dry-run          # show the schedule diff and what would render; changes nothing
//   pnpm sync --no-upload        # render but don't touch Drive
//   pnpm sync --every 30         # run forever, every 30 minutes (the container's command)
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Talk, TalksFile } from "../src/types";
import { sizeTag, variantsFor, type Variant } from "../src/screens";
import { config } from "./lib/config";
import { Db, nowIso, type LogKind, type OutputRow, type TalkRow } from "./lib/db";
import { fetchCard, fetchSessions, sessionHash, startMs, type ApiSession } from "./lib/devcon";
import { ANIMATION_FOLDER, AvDrive, animationName, pool, type AnimFile } from "./lib/drive";
import { Renderer, md5File, renderBaseKey, renderKey } from "./lib/render";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const DRY_RUN = flag("--dry-run");
const NO_UPLOAD = flag("--no-upload");
const everyIdx = args.indexOf("--every");
const EVERY_MIN = everyIdx >= 0 ? Number(args[everyIdx + 1]) : null;
if (EVERY_MIN !== null && !(EVERY_MIN > 0)) throw new Error(`--every needs a number of minutes, got "${args[everyIdx + 1]}"`);
const ONLY = new Set(
  args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--every").map((c) => c.toUpperCase()),
);

const cardPath = (code: string) => path.join(config.cardsDir, `${code}.jpg`);
const cardRel = (code: string) => `cards/${code}.jpg`;
const isActive = (t: TalkRow) => t.removed_at === null;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toTalk(t: TalkRow): Talk {
  return {
    code: t.code,
    id: t.session_id,
    title: t.title,
    room: t.room,
    start: t.start_ms,
    doNotRecord: t.do_not_record === 1,
    card: cardRel(t.code),
  };
}

// --- lock: one run at a time per data dir --------------------------------------

function acquireLock(): () => void {
  mkdirSync(config.dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(config.lockFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(config.lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(readFileSync(config.lockFile, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive && pid !== process.pid) throw new Error(`Another sync is running (pid ${pid}, ${config.lockFile})`);
      rmSync(config.lockFile, { force: true });
    }
  }
  throw new Error(`Could not take ${config.lockFile}`);
}

// --- one run ---------------------------------------------------------------------

async function runOnce(db: Db, dryRun: boolean): Promise<void> {
  const runId = db.startRun();
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const log = (code: string | null, kind: LogKind, before?: unknown, after?: unknown) => {
    db.log(runId, code, kind, before, after);
    bump(kind);
  };

  try {
    mkdirSync(config.cardsDir, { recursive: true });
    mkdirSync(config.outDir, { recursive: true });

    // 1. Schedule diff
    const sessions = (await fetchSessions()).filter((s) => startMs(s) !== null);
    if (sessions.length === 0) throw new Error(`Devcon API has no scheduled sessions for "${config.event}"`);
    const prevByCode = new Map(db.talks().map((t) => [t.code, t]));
    const seen = new Set<string>();
    const needCard: ApiSession[] = [];

    for (const s of sessions) {
      const code = s.sourceId;
      seen.add(code);
      const fields = {
        session_id: s.id,
        title: s.title,
        room: s.slot_room?.name ?? "",
        start_ms: startMs(s)!,
        do_not_record: s.doNotRecord ? 1 : 0,
        session_hash: sessionHash(s),
      };
      const prev = prevByCode.get(code);
      if (!prev) {
        db.insertTalk({ code, ...fields });
        log(code, "added", null, { title: fields.title, room: fields.room, start: new Date(fields.start_ms).toISOString() });
        needCard.push(s);
        continue;
      }
      if (prev.removed_at) log(code, "restored", prev.removed_at, null);
      if (prev.title !== fields.title) log(code, "title", prev.title, fields.title);
      if (prev.room !== fields.room) log(code, "room", prev.room, fields.room);
      if (prev.start_ms !== fields.start_ms)
        log(code, "time", new Date(prev.start_ms).toISOString(), new Date(fields.start_ms).toISOString());
      if (prev.do_not_record !== fields.do_not_record) log(code, "do_not_record", prev.do_not_record === 1, fields.do_not_record === 1);
      if (prev.session_hash !== fields.session_hash || !prev.card_md5 || !existsSync(cardPath(code))) needCard.push(s);
      db.updateTalk(code, { ...fields, removed_at: null, missing_runs: 0, last_seen: nowIso() });
    }
    // The API occasionally leaves a talk out for a moment, so a talk only
    // counts as removed once it's missing from two runs in a row.
    for (const t of prevByCode.values()) {
      if (!isActive(t) || seen.has(t.code)) continue;
      const missing = t.missing_runs + 1;
      if (missing >= 2) {
        db.updateTalk(t.code, { removed_at: nowIso(), missing_runs: missing });
        log(t.code, "removed", { title: t.title, room: t.room }, null);
      } else {
        db.updateTalk(t.code, { missing_runs: missing });
      }
    }

    if (dryRun) {
      const candidates = db.talks().filter((t) => isActive(t) && !t.do_not_record && (!ONLY.size || ONLY.has(t.code)));
      const base = renderBaseKey();
      const stale = candidates.flatMap((t) =>
        variantsFor(t.room).filter((v) => !t.card_md5 || renderKey(base, t.card_md5, v) !== db.output(t.code, sizeTag(v))?.render_key),
      );
      console.log(
        `Would fetch ${needCard.length} card(s); ${stale.length} video(s) already known to need a render ` +
          `(plus any whose card changes).`,
      );
      return;
    }

    // 2. Cards for new/changed sessions
    console.log(`Schedule: ${sessions.length} talks; fetching ${needCard.length} card(s)…`);
    await pool(needCard, 4, async (s) => {
      const code = s.sourceId;
      try {
        const buf = await fetchCard(s.id);
        const tmp = `${cardPath(code)}.tmp`;
        writeFileSync(tmp, buf);
        const md5 = md5File(tmp);
        const prev = db.talk(code)!;
        copyFileSync(tmp, cardPath(code));
        rmSync(tmp);
        if (prev.card_md5 && prev.card_md5 !== md5) log(code, "card", prev.card_md5, md5);
        db.updateTalk(code, { card_md5: md5 });
        if (prev.status?.startsWith("card:")) db.setStatus(runId, code, null);
      } catch (err) {
        db.setStatus(runId, code, `card: ${errMsg(err)}`);
        bump("problem");
      }
    });

    // Studio's talk list
    const active = db
      .talks()
      .filter((t) => isActive(t) && t.card_md5)
      .sort((a, b) => a.start_ms - b.start_ms || a.title.localeCompare(b.title));
    const studio: TalksFile = { event: config.event, talks: active.map(toTalk) };
    writeFileSync(config.studioTalks, JSON.stringify(studio, null, 2) + "\n");

    // 3. Render what changed: one video per talk and size
    const base = renderBaseKey();
    type Job = { t: TalkRow; v: Variant; out: OutputRow | undefined };
    const jobs: Job[] = active
      .filter((t) => !t.do_not_record && (!ONLY.size || ONLY.has(t.code)))
      .flatMap((t) => variantsFor(t.room).map((v) => ({ t, v, out: db.output(t.code, sizeTag(v)) })))
      .filter(({ t, v, out }) => {
        const key = renderKey(base, t.card_md5!, v);
        return key !== out?.render_key || !out?.out_file || !existsSync(out.out_file);
      });
    console.log(`Rendering ${jobs.length} video(s)…`);
    const renderer = new Renderer();
    for (const [i, { t, v, out }] of jobs.entries()) {
      const size = sizeTag(v);
      const tag = `[${i + 1}/${jobs.length}] ${t.code} ${size}`;
      try {
        let last = -1;
        const file = await renderer.render(toTalk(t), v, (p) => {
          const pct = Math.floor(p * 10) * 10;
          if (pct !== last && process.stdout.isTTY) process.stdout.write(`\r  ${tag} ${(last = pct)}%   `);
        });
        if (out?.out_file && out.out_file !== file) rmSync(out.out_file, { force: true });
        const md5 = md5File(file);
        db.upsertOutput(t.code, size, { render_key: renderKey(base, t.card_md5!, v), rendered_at: nowIso(), out_file: file, out_md5: md5 });
        log(t.code, "rendered", out?.out_md5 ?? null, `${size} ${md5}`);
        if (db.talk(t.code)!.status?.startsWith("render")) db.setStatus(runId, t.code, null);
        console.log(`\r  ${tag} -> ${path.relative(config.root, file)}`);
      } catch (err) {
        db.setStatus(runId, t.code, `render ${size}: ${errMsg(err)}`);
        bump("problem");
        console.error(`\r  ${tag} render failed: ${errMsg(err)}`);
      }
    }

    // Sizes a talk no longer needs (its room changed screens) are dropped locally.
    for (const o of db.outputs()) {
      const t = db.talk(o.code);
      const wanted = t && isActive(t) && !t.do_not_record && variantsFor(t.room).some((v) => sizeTag(v) === o.size);
      if (!wanted && !o.drive_file_id) {
        if (o.out_file) rmSync(o.out_file, { force: true });
        db.deleteOutput(o.code, o.size);
      }
    }

    // 4. Drive
    if (NO_UPLOAD) {
      console.log("Skipping Drive (--no-upload).");
    } else {
      const drive = new AvDrive();
      const index = await drive.index();
      console.log(`Drive: ${index.rooms} rooms, ${index.cards.size} intro cards, ${index.animations.size} talks with animations`);
      const rows = db.talks().filter((t) => !ONLY.size || ONLY.has(t.code));

      await pool(rows, 3, async (t) => {
        const copies = index.animations.get(t.code) ?? [];
        const keep = new Set<string>();
        const wanted = isActive(t) && !t.do_not_record ? variantsFor(t.room) : [];

        if (wanted.length) {
          const slot = index.cards.get(t.code);
          if (!slot) {
            if (copies.length || db.outputs(t.code).some((o) => o.out_file)) {
              db.setStatus(runId, t.code, "drive: waiting for its intro card to appear in Drive (room/day unknown)");
            }
            return;
          }
          for (const v of wanted) {
            const size = sizeTag(v);
            const out = db.output(t.code, size);
            if (!out?.out_file || !existsSync(out.out_file)) continue;
            const name = animationName(slot.cardName, size);
            const where = `${slot.where}/${ANIMATION_FOLDER}/${name}`;
            const sameSize = copies.filter((c) => c.size === size && !keep.has(c.id));
            const existing: AnimFile | undefined = sameSize.find((c) => c.id === out.drive_file_id) ?? sameSize[0];
            try {
              let fileId: string;
              if (existing) {
                const needsMove = slot.animFolderId === null || existing.parentId !== slot.animFolderId || existing.name !== name;
                const needsContent = existing.md5 !== out.out_md5;
                if (needsMove || needsContent) await drive.update(existing, slot, name, needsContent ? out.out_file : null);
                if (needsMove) log(t.code, "moved", `${existing.where}/${ANIMATION_FOLDER}/${existing.name}`, where);
                if (needsContent) log(t.code, "uploaded", existing.md5, `${size} ${out.out_md5}`);
                fileId = existing.id;
              } else {
                fileId = await drive.create(slot, name, out.out_file);
                log(t.code, "uploaded", null, where);
              }
              keep.add(fileId);
              db.upsertOutput(t.code, size, { drive_file_id: fileId, drive_path: where, drive_md5: out.out_md5, uploaded_at: nowIso() });
              if (db.talk(t.code)!.status?.startsWith("drive")) db.setStatus(runId, t.code, null);
            } catch (err) {
              db.setStatus(runId, t.code, `drive ${size}: ${errMsg(err)}`);
              bump("problem");
            }
          }
        }

        // Anything else for this talk is stale: removed / do-not-record talks,
        // sizes the room no longer has, and duplicates.
        for (const c of copies.filter((c) => !keep.has(c.id))) {
          if (wanted.some((v) => sizeTag(v) === c.size) && !index.cards.has(t.code)) continue;
          if (wanted.some((v) => sizeTag(v) === c.size) && !db.output(t.code, c.size)?.out_file) continue;
          try {
            await drive.trash(c.id);
            log(t.code, "trashed", `${c.where}/${ANIMATION_FOLDER}/${c.name}`, null);
          } catch (err) {
            db.setStatus(runId, t.code, `drive: trash failed: ${errMsg(err)}`);
          }
        }
        for (const o of db.outputs(t.code)) {
          if (o.drive_file_id && !keep.has(o.drive_file_id) && !wanted.some((v) => sizeTag(v) === o.size)) {
            if (o.out_file) rmSync(o.out_file, { force: true });
            db.deleteOutput(t.code, o.size);
          }
        }
      });
    }

    db.finishRun(runId, "ok", counts);
    printRun(db, runId, counts);
  } catch (err) {
    db.finishRun(runId, "failed", counts, errMsg(err));
    throw err;
  }
}

function printRun(db: Db, runId: number, counts: Record<string, number>) {
  const entries = db.logFor({ runId });
  const interesting = entries.filter((e) => !["rendered", "uploaded"].includes(e.kind));
  for (const e of interesting.slice(0, 200)) {
    const arrow = e.before !== null || e.after !== null ? `: ${e.before ?? "∅"} → ${e.after ?? "∅"}` : "";
    console.log(`  ${e.kind.padEnd(13)} ${e.code ?? ""}${arrow}`);
  }
  if (interesting.length > 200) console.log(`  … ${interesting.length - 200} more (pnpm status --run ${runId})`);
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`);
  console.log(`Run #${runId} done: ${parts.length ? parts.join(", ") : "no changes"}`);
}

// --- dry run: diff against a throwaway copy of the database -----------------------

async function dryRun() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devcon-sync-"));
  const copy = path.join(dir, "sync.db");
  try {
    if (existsSync(config.dbFile)) {
      const src = new Db(config.dbFile);
      src.sql.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
      src.close();
    }
    const db = new Db(copy);
    await runOnce(db, true);
    const entries = db.logFor({ runId: db.runs(1)[0].id });
    for (const e of entries.slice(0, 300)) {
      console.log(`  ${e.kind.padEnd(13)} ${e.code ?? ""}: ${e.before ?? "∅"} → ${e.after ?? "∅"}`);
    }
    if (entries.length > 300) console.log(`  … ${entries.length - 300} more`);
    console.log(`Dry run: ${entries.length} schedule change(s); nothing was written.`);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (DRY_RUN) return dryRun();
  const release = acquireLock();
  const stop = () => {
    release();
    process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      const db = new Db(config.dbFile);
      try {
        await runOnce(db, false);
      } catch (err) {
        console.error(`Run failed: ${errMsg(err)}`);
        if (EVERY_MIN === null) process.exitCode = 1;
      } finally {
        db.close();
      }
      if (EVERY_MIN !== null) {
        console.log(`Next run in ${EVERY_MIN} min (${new Date(Date.now() + EVERY_MIN * 60_000).toISOString()})`);
        await new Promise((r) => setTimeout(r, EVERY_MIN * 60_000));
      }
    } while (EVERY_MIN !== null);
  } finally {
    release();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
