import * as fs from 'fs';
import * as path from 'path';

/**
 * Security helpers shared by the preview server, sandbox generator and webview.
 */

/** Resolves symlinks/junctions when the path exists; otherwise returns the normalized absolute path. */
export function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Returns true if `candidate` is `root` itself or a descendant of it, after resolving
 * symlinks/junctions on both sides (case-insensitive on Windows).
 */
export function isPathInside(root: string, candidate: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(realOrResolved(root));
  const c = norm(realOrResolved(candidate));
  if (c === r) {
    return true;
  }
  const rel = path.relative(r, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Escapes text for safe interpolation into HTML element content and quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Serializes data as JSON that is safe to embed inside an inline `<script>` block. */
export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
/** Valid custom-element / Angular element selector (e.g. `app-user-card`). */
const ELEMENT_SELECTOR_RE = /^[A-Za-z][\w.-]*$/;

export function isSafeIdentifier(value: string | undefined): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

export function isSafeElementSelector(value: string | undefined): value is string {
  return typeof value === 'string' && ELEMENT_SELECTOR_RE.test(value);
}

/**
 * Ensures neither `trustedBase` itself nor any path segment from `trustedBase` down to `target`
 * is a symlink or junction. Prevents a malicious repository from redirecting writes outside the project.
 */
export function assertNoLinksBelow(trustedBase: string, target: string): void {
  const resolvedBase = path.resolve(trustedBase);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to use ${target}: outside of ${trustedBase}`);
  }

  const checkDirSegment = (dirPath: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dirPath);
    } catch {
      return false; // Segment does not exist yet; it will be created as a real directory.
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to write preview files: "${dirPath}" is a symbolic link/junction. ` +
          'Delete it and try again.'
      );
    }
    if (!st.isDirectory()) {
      throw new Error(`Refusing to write preview files: "${dirPath}" is not a directory.`);
    }
    return true;
  };

  if (!checkDirSegment(resolvedBase)) {
    return;
  }

  let current = resolvedBase;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!checkDirSegment(current)) {
      return;
    }
  }
}

/**
 * Unlinks a file path if it already exists (including broken or live symlinks) so a subsequent
 * tool write (like esbuild's outfile) cannot follow a planted file symlink.
 */
export function unlinkIfExists(filePath: string): void {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isDirectory()) {
      throw new Error(`Refusing to overwrite directory ${filePath}`);
    }
    fs.unlinkSync(filePath);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Writes a file without following a pre-existing symlink/hardlink at the destination:
 * any existing entry is removed and the file is created exclusively (`wx`).
 */
export function safeWriteFile(filePath: string, contents: string): void {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isDirectory()) {
      throw new Error(`Refusing to overwrite directory ${filePath}`);
    }
    fs.unlinkSync(filePath);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }
  fs.writeFileSync(filePath, contents, { encoding: 'utf-8', flag: 'wx' });
}
