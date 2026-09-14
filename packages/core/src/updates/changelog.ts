import { BRAND_LINKS } from "../constants";
import { GITHUB_REPO } from "./types";

/** Raw repository changelog pinned to a branch or release tag. */
export function changelogMarkdownUrl(ref: string): string {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(ref)}/CHANGELOG.md`;
}

/** Extract one exact version body from the repository changelog. */
export function extractChangelogSection(markdown: string, version: string): string {
  const lines = markdown.split(/\r?\n/);
  const target = version.replace(/^v/, "");
  const start = lines.findIndex((line) => line.match(/^##\s+v?(\d+\.\d+\.\d+)\b/)?.[1] === target);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s+v?\d+\.\d+\.\d+\b/.test(line),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** Public website changelog, optionally deep-linked to one released version. */
export function changelogUrl(tag?: string): string {
  const version = tag?.replace(/^v/, "").match(/^(\d+\.\d+\.\d+)$/)?.[1];
  return version
    ? `${BRAND_LINKS.site}/changelog/v${version.replaceAll(".", "-")}`
    : `${BRAND_LINKS.site}/changelog`;
}
