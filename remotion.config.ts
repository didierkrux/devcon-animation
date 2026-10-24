import { Config } from "@remotion/cli/config";

Config.setEntryPoint("src/index.ts");
// Cards and the staged intro live in the data dir (written by pnpm sync).
Config.setPublicDir("data/public");
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
