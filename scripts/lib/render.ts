import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { Talk } from "../../src/types";
import { sizeTag, type Size } from "../../src/screens";
import { config } from "./config";

export const md5File = (file: string) => createHash("md5").update(readFileSync(file)).digest("hex");

/** Hash of everything besides the card that shapes a render: intro clip, composition code, hold length. */
export function renderBaseKey(): string {
  const h = createHash("sha256");
  h.update(md5File(config.introFile));
  for (const f of config.renderInputs) h.update(readFileSync(f));
  h.update(`hold=${config.holdSeconds}`);
  return h.digest("hex");
}

export const renderKey = (base: string, cardMd5: string, size: Size) =>
  createHash("sha256").update(`${base}:${cardMd5}:${sizeTag(size)}`).digest("hex").slice(0, 32);

const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export const outFileFor = (talk: Pick<Talk, "code" | "title">, size: Size) =>
  path.join(config.outDir, `${talk.code}-${slugify(talk.title)}-${sizeTag(size)}.mp4`);

/** Keeps the bundle's public dir in step with the committed intro clip. */
function stagePublicDir() {
  mkdirSync(config.cardsDir, { recursive: true });
  const staged = path.join(config.publicDir, "intro.webm");
  if (!existsSync(staged) || md5File(staged) !== md5File(config.introFile)) copyFileSync(config.introFile, staged);
}

export class Renderer {
  private serveUrl: Promise<string> | null = null;

  private bundled(): Promise<string> {
    if (!this.serveUrl) {
      stagePublicDir();
      this.serveUrl = bundle({ entryPoint: config.entryPoint, publicDir: config.publicDir });
    }
    return this.serveUrl;
  }

  async render(talk: Talk, size: Size, onProgress?: (p: number) => void): Promise<string> {
    const serveUrl = await this.bundled();
    const inputProps = { talk, holdSeconds: config.holdSeconds, width: size.width, height: size.height };
    const composition = await selectComposition({ serveUrl, id: "TalkIntro", inputProps });
    const file = outFileFor(talk, size);
    mkdirSync(path.dirname(file), { recursive: true });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: file,
      inputProps,
      onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
    });
    return file;
  }
}
