// What the sync database knows: talk states, recent runs and their diffs.
//
// Usage:
//   pnpm status                 # overview + changes from the latest run that had any
//   pnpm status --run 12        # everything logged in run 12
//   pnpm status --talk RPAPTP   # one talk's current state and full history
//   pnpm status --problems      # talks with an open problem
import { existsSync } from "node:fs";
import { config } from "./lib/config";
import { Db, type LogRow } from "./lib/db";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const fmt = (e: LogRow) => {
  const arrow = e.before !== null || e.after !== null ? `: ${e.before ?? "∅"} → ${e.after ?? "∅"}` : "";
  return `${e.at.slice(0, 19).replace("T", " ")}  #${String(e.run_id).padEnd(4)} ${e.kind.padEnd(13)} ${e.code ?? ""}${arrow}`;
};

if (!existsSync(config.dbFile)) {
  console.log(`No database yet at ${config.dbFile}. Run pnpm sync first.`);
  process.exit(0);
}
const db = new Db(config.dbFile);

const talkCode = opt("--talk");
const runArg = opt("--run");

if (talkCode) {
  const t = db.talk(talkCode.toUpperCase());
  if (!t) {
    console.log(`No talk ${talkCode} in the database.`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(t)) console.log(`${k.padEnd(14)} ${v ?? ""}`);
  for (const o of db.outputs(t.code)) {
    console.log(`\n${o.size}`);
    for (const [k, v] of Object.entries(o)) if (k !== "code" && k !== "size") console.log(`  ${k.padEnd(14)} ${v ?? ""}`);
  }
  console.log("\nHistory:");
  for (const e of db.logFor({ code: t.code }).reverse()) console.log("  " + fmt(e));
} else if (runArg) {
  const runId = Number(runArg);
  const run = db.sql.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
  if (!run) {
    console.log(`No run #${runArg}.`);
    process.exit(1);
  }
  console.log(`Run #${runId}: ${run.status}, ${run.started_at} → ${run.finished_at ?? "…"} ${run.error ? `(${run.error})` : ""}`);
  for (const e of db.logFor({ runId }, 10_000)) console.log("  " + fmt(e));
} else if (args.includes("--problems")) {
  const rows = db.talks().filter((t) => t.status && t.removed_at === null);
  if (rows.length === 0) console.log("No open problems.");
  for (const t of rows) console.log(`${t.code}  ${t.title.slice(0, 50).padEnd(50)}  ${t.status}`);
} else {
  const talks = db.talks();
  const active = talks.filter((t) => t.removed_at === null);
  const recordable = active.filter((t) => !t.do_not_record);
  const stat = (label: string, n: number) => console.log(`${label.padEnd(22)} ${n}`);
  stat("talks in schedule", active.length);
  stat("  not recorded", active.length - recordable.length);
  const outputs = db.outputs();
  const live = new Set(recordable.map((t) => t.code));
  const mine = outputs.filter((o) => live.has(o.code));
  stat("  videos rendered", mine.filter((o) => o.out_md5).length);
  stat("  videos in Drive", mine.filter((o) => o.drive_md5 && o.drive_md5 === o.out_md5).length);
  stat("  open problems", active.filter((t) => t.status).length);
  stat("removed from schedule", talks.length - active.length);

  console.log("\nRecent runs:");
  for (const r of db.runs(10)) {
    console.log(`  #${String(r.id).padEnd(4)} ${r.started_at.slice(0, 19).replace("T", " ")}  ${r.status.padEnd(7)} ${r.error ?? r.summary ?? ""}`);
  }
  const lastWithChanges = db.sql
    .prepare("SELECT run_id FROM log WHERE kind NOT IN ('rendered','uploaded') ORDER BY id DESC LIMIT 1")
    .get() as { run_id: number } | undefined;
  if (lastWithChanges) {
    console.log(`\nChanges in run #${lastWithChanges.run_id}:`);
    const entries = db.logFor({ runId: lastWithChanges.run_id }, 10_000).filter((e) => !["rendered", "uploaded"].includes(e.kind));
    for (const e of entries.slice(0, 50)) console.log("  " + fmt(e));
    if (entries.length > 50) console.log(`  … ${entries.length - 50} more (pnpm status --run ${lastWithChanges.run_id})`);
  }
}
db.close();
