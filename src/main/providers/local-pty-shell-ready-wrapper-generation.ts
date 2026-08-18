/**
 * Generates the zsh ZDOTDIR tree and bash rcfile Orca launches shells with.
 *
 * Why: the wrappers emit an OSC 777 marker after startup files finish, which the
 * readiness scanner watches for before a startup command is written.
 */
import {
  buildZshStartupWrapperFiles,
  type ZshStartupWrapperFiles
} from '../zsh-startup-wrapper-builder'
import {
  markShellReadyWrapperRootInUse,
  pruneStaleShellReadyWrapperRoots
} from '../shell-ready-wrapper-store'
import { writeShellWrapperFiles } from '../shell-wrapper-file-writer'
import {
  buildLocalShellReadyWrapperFiles,
  getLocalZshWrapperSpec
} from './local-pty-shell-ready-wrapper-fileset'
import {
  getShellReadyWrapperBaseDir,
  getShellReadyWrapperRoot,
  shellReadyWrappersExist
} from './local-pty-shell-ready-wrapper-root'

// Why keyed on the base dir rather than a bare flag: it mirrors the root cache,
// so a re-pointed ORCA_USER_DATA_PATH sweeps its new base too.
let prunedShellReadyWrapperBaseDir: string | null = null

export function getZshShellReadyWrapperFiles(): ZshStartupWrapperFiles {
  return buildZshStartupWrapperFiles(getLocalZshWrapperSpec(`${getShellReadyWrapperRoot()}/zsh`))
}

/** True when every wrapper file is present and non-empty afterwards. */
export function ensureShellReadyWrappersAt(root = getShellReadyWrapperRoot()): boolean {
  // Why existence alone decides, with no per-process flag: the root is keyed by
  // a hash of the exact bytes we would write, so a tree that is present and
  // non-empty is a tree this build wrote. Rewriting it would replace a live file
  // on the terminal-spawn path for no gain.
  if (!shellReadyWrappersExist(root)) {
    const written = writeShellWrapperFiles(buildLocalShellReadyWrapperFiles(root), '[shell-ready]')
    if (!written || !shellReadyWrappersExist(root)) {
      // Why no flag to reset: the next launch re-checks the files themselves, so
      // a half-written tree is retried without any extra bookkeeping.
      return false
    }
  }

  // Why unconditional: the common path now writes nothing, and this stamp is the
  // only thing telling a sibling build's pruner the tree still launches shells.
  markShellReadyWrapperRootInUse(root)

  // Why guarded: callers may target an explicit root (tests, snapshots); only the
  // managed default owns the base dir and may collect siblings there. Why once
  // per base dir: the sweep is process-startup work, not per-spawn work.
  const baseDir = getShellReadyWrapperBaseDir()
  if (prunedShellReadyWrapperBaseDir !== baseDir && root === getShellReadyWrapperRoot()) {
    prunedShellReadyWrapperBaseDir = baseDir
    pruneStaleShellReadyWrapperRoots(baseDir, root)
  }
  return true
}

export function ensureShellReadyWrappers(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  return ensureShellReadyWrappersAt()
}
