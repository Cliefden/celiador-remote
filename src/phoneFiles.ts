/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'fs';
import * as path from 'path';

// Path rules for the phone's file explorer (fs.list / fs.read / fs.write over
// the relay). The phone works on the run's files; it never touches git
// internals or the editor and agent configuration that runs code on this
// machine, and never follows a link out of the run's root.

/** Folders the phone may not write into: git internals and editor/agent config that runs commands. */
const PROTECTED_DIRS = new Set(['.git', '.vscode', '.claude']);
/** Files the phone may not write, at any depth: config that starts processes. */
const PROTECTED_FILES = new Set(['.mcp.json', '.envrc', '.gitmodules']);
/** Folders the phone may not read or list either. */
const HIDDEN_DIRS = new Set(['.git']);

export type PhoneAccess = 'read' | 'write';

/** Thrown for a path the phone may not use; the message goes back to the phone. */
export class PhonePathError extends Error {}

/** Why `segments` (relative to the root) is off limits for `access`, or undefined when allowed. */
export function protectedReason(segments: readonly string[], access: PhoneAccess): string | undefined {
  // Case-insensitive: the default macOS and Windows file systems are.
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.some((s) => HIDDEN_DIRS.has(s))) {return 'git internals are not available from the phone';}
  if (access === 'read') {return undefined;}
  if (lower.some((s) => PROTECTED_DIRS.has(s))) {return `${segments.find((s) => PROTECTED_DIRS.has(s.toLowerCase()))} is not writable from the phone`;}
  const name = lower[lower.length - 1];
  if (name && PROTECTED_FILES.has(name)) {return `${segments[segments.length - 1]} is not writable from the phone`;}
  return undefined;
}

/** Splits a phone path into segments; rejects `..`, separators inside a segment and NUL. */
export function splitPhonePath(rel: string): string[] {
  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..' || s.includes('\\') || s.includes('\0') || (process.platform === 'win32' && s.includes(':')))) {
    throw new PhonePathError('bad path');
  }
  return segments;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The real path of `rel` under `root`, for `access`. Symbolic links are
 * resolved and the result must still be inside the root's real path and pass
 * the deny-list again (a link named `notes` pointing at `.git` is `.git`). A
 * write to a file that does not exist yet resolves its parent folder, which
 * must exist.
 */
export async function resolvePhonePath(root: string, rel: string, access: PhoneAccess): Promise<string> {
  const segments = splitPhonePath(rel);
  const lexical = protectedReason(segments, access);
  if (lexical) {throw new PhonePathError(lexical);}
  const realRoot = await fs.promises.realpath(root);
  const joined = path.join(realRoot, ...segments);
  let real: string;
  try {
    real = await fs.promises.realpath(joined);
  } catch (err) {
    if (access !== 'write' || (err as NodeJS.ErrnoException).code !== 'ENOENT' || segments.length === 0) {throw err;}
    // A new file: its folder must exist and resolve inside the root. A dangling
    // link is not a new file: writing it would create the link's target.
    if (await fs.promises.lstat(joined).then(() => true, () => false)) {throw new PhonePathError('the path is a broken link');}
    real = path.join(await fs.promises.realpath(path.dirname(joined)), path.basename(joined));
  }
  if (!isInside(realRoot, real)) {throw new PhonePathError('the path leads outside the repository');}
  const resolved = protectedReason(path.relative(realRoot, real).split(path.sep).filter((s) => s.length > 0), access);
  if (resolved) {throw new PhonePathError(resolved);}
  return real;
}
