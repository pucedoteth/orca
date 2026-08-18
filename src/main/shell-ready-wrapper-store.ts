/**
 * Content-addressed placement for the generated shell wrapper trees.
 *
 * Why: every writer that shares a userData dir -- main's local PTY path, the
 * daemon fork, and the daemons of other builds that outlive the app that
 * spawned them -- wrote one fixed `shell-ready/` tree. Last writer won, and the
 * guard only re-checked that the files were present, never that they were this
 * build's. A daemon whose spawn env no longer agreed with the wrapper on disk
 * then kept launching shells it could not read: the ready marker never fired
 * and every startup command waited out the full readiness timeout, silently.
 *
 * Keying each tree by a hash of its own contents gives every variant its own
 * directory, so writers cannot clobber each other and "present" once again
 * means "written by this build". Writing itself stays in
 * shell-wrapper-file-writer.ts.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, rmSync, statSync, utimesSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ShellWrapperFile } from './shell-wrapper-file-writer'

/** Builds the wrapper set for a tree rooted at `root`, as the writer takes it. */
export type ShellWrapperFileBuilder = (root: string) => readonly ShellWrapperFile[]

// Why a placeholder: only .zshenv embeds the tree path, so hashing a build
// against a fixed root keeps the digest stable across machines and user data
// dirs while still covering every difference that matters.
const HASH_PROBE_ROOT = '/__orca_shell_ready_root__'
const ROOT_HASH_LENGTH = 16
// Why the hash sits ABOVE this leaf rather than below it: ZDOTDIR
// self-reference guards -- in TS and as `*/shell-ready/zsh` globs baked into
// the wrapper scripts -- match on that exact suffix. Without it a wrapper
// sources itself and zsh dies with "job table full or recursion limit
// exceeded". `<base>/<hash>/shell-ready/zsh` leaves every guard intact and
// keeps older builds able to recognize a newer build's dir.
const WRAPPER_ROOT_LEAF = 'shell-ready'
// Why: bounds the recursive delete below to names this store could itself have
// produced, so an unrelated directory sharing the base dir is never a candidate.
const WRAPPER_ROOT_DIR_PATTERN = /^[0-9a-f]{16}$/
// Why this long: far longer than any plausible gap between launches, so a tree
// in active use is never collected. Measured against the liveness stamp below.
const STALE_ROOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function resolveShellReadyWrapperRoot(
  baseDir: string,
  build: ShellWrapperFileBuilder
): string {
  const digest = createHash('sha256')
  for (const [path, content] of build(HASH_PROBE_ROOT)) {
    // Relative, so the digest does not vary with the base dir it is naming.
    digest.update(path.slice(HASH_PROBE_ROOT.length))
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
  }
  return join(baseDir, digest.digest('hex').slice(0, ROOT_HASH_LENGTH), WRAPPER_ROOT_LEAF)
}

/** Records that this tree is still in use, so a sibling build's pruner leaves it
 *  alone. Callers must invoke this on every launch, not only when writing.
 *
 *  Why it is needed: writes land two levels down (`<hash>/shell-ready/zsh/...`),
 *  and a directory's mtime only moves when its direct children change -- so the
 *  hash dir's mtime is its CREATION time and never advances on rewrite. Without
 *  this, staleness would mean "created 30 days ago" rather than "unused for 30
 *  days", and because main and the daemon hash to different trees under one base
 *  dir, each would collect the other's live tree on any month-old install. */
export function markShellReadyWrapperRootInUse(root: string): void {
  const now = new Date()
  try {
    // The hash dir is what the pruner stats, so that is what has to move.
    utimesSync(dirname(root), now, now)
  } catch {
    // Best effort: a tree we cannot stamp is not worth failing a spawn over.
  }
}

/** Drops wrapper trees no build has launched a shell from in a month. Safe
 *  because a daemon still pointing at a collected tree regenerates it on its
 *  next spawn. */
export function pruneStaleShellReadyWrapperRoots(
  baseDir: string,
  keepRoot: string,
  now = Date.now()
): void {
  const keepDir = dirname(keepRoot)
  let entries: Dirent[]
  try {
    // Why lstat first: readdir follows a symlinked base dir, which would point
    // the recursive delete below at real directories somewhere else entirely.
    if (lstatSync(baseDir).isSymbolicLink()) {
      return
    }
    entries = readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // isDirectory() is false for a symlink-to-directory, so entries pointing
    // outside the base dir are skipped here rather than followed.
    if (!entry.isDirectory() || !WRAPPER_ROOT_DIR_PATTERN.test(entry.name)) {
      continue
    }
    const candidate = join(baseDir, entry.name)
    if (candidate === keepDir) {
      continue
    }
    try {
      if (now - statSync(candidate).mtimeMs < STALE_ROOT_MAX_AGE_MS) {
        continue
      }
      rmSync(candidate, { recursive: true, force: true })
    } catch {
      // Best effort: a tree we cannot stat or remove is not worth failing a spawn over.
    }
  }
}
