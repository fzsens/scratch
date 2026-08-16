import { convertFileSrc } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function isRelativeAssetPath(src: string): boolean {
  if (!src || src.startsWith("#") || src.startsWith("/") || src.startsWith("\\")) {
    return false;
  }

  // Keep web URLs, data URLs, and other explicitly-schemed references unchanged.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || WINDOWS_ABSOLUTE_PATH.test(src)) {
    return false;
  }

  return true;
}

function splitReferenceSuffix(src: string): { path: string; suffix: string } {
  const suffixIndex = src.search(/[?#]/);
  if (suffixIndex < 0) return { path: src, suffix: "" };
  return { path: src.slice(0, suffixIndex), suffix: src.slice(suffixIndex) };
}

function normalizeRelativePath(baseDir: string, relativePath: string): string {
  const separator = baseDir.includes("\\") ? "\\" : "/";
  const isUnc = /^[/\\]{2}/.test(baseDir);
  const isRooted = baseDir.startsWith("/") || (separator === "\\" && baseDir.startsWith("\\"));
  const normalizedBase = baseDir.replace(/[\\/]+/g, separator);
  const parts = `${normalizedBase}${separator}${relativePath.replace(/[\\/]+/g, separator)}`
    .split(separator)
    .filter(Boolean);
  const resolved: string[] = [];
  const anchorDepth = isUnc ? 2 : /^[a-zA-Z]:$/.test(parts[0] ?? "") ? 1 : 0;

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      // Do not resolve above the filesystem root or a Windows UNC share.
      if (resolved.length > anchorDepth) {
        resolved.pop();
      }
      continue;
    }
    resolved.push(part);
  }

  const prefix = isUnc ? separator.repeat(2) : isRooted ? separator : "";
  return `${prefix}${resolved.join(separator)}`;
}

/** Resolve a Markdown image reference relative to the note file on disk. */
export function resolveMarkdownAssetUrl(src: string, notePath: string): string {
  const trimmed = src.trim();
  if (!notePath || !isRelativeAssetPath(trimmed)) return src;

  const { path, suffix } = splitReferenceSuffix(trimmed);
  if (!path) return src;

  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // Keep malformed percent-encoding unchanged and let the asset protocol report it.
  }

  const separatorIndex = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  const baseDir =
    separatorIndex > 0
      ? notePath.slice(0, separatorIndex)
      : separatorIndex === 0
        ? notePath[0]
        : ".";
  const absolutePath = normalizeRelativePath(baseDir, decodedPath);
  return `${convertFileSrc(absolutePath)}${suffix}`;
}

/** Add render-only URLs to image nodes while preserving their Markdown src. */
export function resolveMarkdownImageSources(
  content: JSONContent,
  notePath: string,
): JSONContent {
  const resolved: JSONContent = { ...content };

  if (content.type === "image" && content.attrs?.src) {
    resolved.attrs = {
      ...content.attrs,
      resolvedSrc: resolveMarkdownAssetUrl(content.attrs.src, notePath),
    };
  }

  if (content.content) {
    resolved.content = content.content.map((child) =>
      resolveMarkdownImageSources(child, notePath),
    );
  }

  return resolved;
}
