import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import {
  markShellReadyWrapperRootInUse,
  pruneStaleShellReadyWrapperRoots,
  resolveShellReadyWrapperRoot,
  type ShellWrapperFileBuilder
} from './shell-ready-wrapper-store'
import { writeShellWrapperFiles } from './shell-wrapper-file-writer'

const DAY_MS = 24 * 60 * 60 * 1000

function builderFor(marker: string): ShellWrapperFileBuilder {
  // Why the root is embedded: mirrors .zshenv, the one wrapper file that names
  // its own tree. The digest must stay stable despite it.
  return (root) => [
    [join(root, 'zsh', '.zshrc'), `zshrc ${marker} root=${root}`],
    [join(root, 'bash', 'rcfile'), `rcfile ${marker}`]
  ]
}

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'orca-wrapper-store-'))
}

function write(root: string, build: ShellWrapperFileBuilder): void {
  writeShellWrapperFiles(build(root), '[test]')
  markShellReadyWrapperRootInUse(root)
}

describe('resolveShellReadyWrapperRoot', () => {
  it('gives builds with different wrapper contents different trees', () => {
    const base = makeBase()
    expect(resolveShellReadyWrapperRoot(base, builderFor('ORCA_SHELL_READY_MARKER'))).not.toEqual(
      resolveShellReadyWrapperRoot(base, builderFor('ORCA_SHELL_FEATURES'))
    )
  })

  it('is stable for identical contents', () => {
    const base = makeBase()
    expect(resolveShellReadyWrapperRoot(base, builderFor('a'))).toEqual(
      resolveShellReadyWrapperRoot(base, builderFor('a'))
    )
  })

  // Why: `*/shell-ready/zsh` globs baked into the wrapper scripts, plus TS
  // guards, detect a self-referential ZDOTDIR by this exact suffix. Losing it
  // makes a wrapper source itself until zsh hits its recursion limit.
  it('keeps the zsh dir ending in /shell-ready/zsh', () => {
    const root = resolveShellReadyWrapperRoot(makeBase(), builderFor('a'))
    // Compare in POSIX form: the guards match a POSIX suffix, and the value they
    // see is built with POSIX concatenation regardless of the host separator.
    expect(join(root, 'zsh').split(sep).join('/').endsWith('/shell-ready/zsh')).toBe(true)
  })

  it('lets two contracts coexist instead of clobbering each other', () => {
    const base = makeBase()
    const oldBuild = builderFor('old')
    const newBuild = builderFor('new')
    const oldRoot = resolveShellReadyWrapperRoot(base, oldBuild)
    const newRoot = resolveShellReadyWrapperRoot(base, newBuild)

    write(oldRoot, oldBuild)
    write(newRoot, newBuild)

    // The regression: the second writer used to overwrite the first writer's
    // file in place, leaving the first build launching shells it cannot read.
    expect(readFileSync(join(oldRoot, 'bash', 'rcfile'), 'utf8')).toBe('rcfile old')
    expect(readFileSync(join(newRoot, 'bash', 'rcfile'), 'utf8')).toBe('rcfile new')
  })
})

describe('pruneStaleShellReadyWrapperRoots', () => {
  it('collects month-old trees but never the one in use', () => {
    const base = makeBase()
    const build = builderFor('a')
    const keepRoot = resolveShellReadyWrapperRoot(base, build)
    write(keepRoot, build)

    const staleDir = join(base, '00112233445566aa')
    mkdirSync(join(staleDir, 'shell-ready'), { recursive: true })
    const longAgo = new Date(Date.now() - 40 * DAY_MS)
    utimesSync(staleDir, longAgo, longAgo)

    pruneStaleShellReadyWrapperRoots(base, keepRoot)

    expect(existsSync(staleDir)).toBe(false)
    expect(existsSync(join(keepRoot, 'bash', 'rcfile'))).toBe(true)
  })

  // Why: older builds still write the unversioned `<userData>/shell-ready/` tree
  // and long-lived daemons launch shells from it. The pruner walks a different
  // base dir and must never be able to reach it, however old it looks.
  it('cannot reach the legacy unversioned tree older daemons still depend on', () => {
    const userData = makeBase()
    const legacyZshrc = join(userData, 'shell-ready', 'zsh', '.zshrc')
    mkdirSync(dirname(legacyZshrc), { recursive: true })
    writeShellWrapperFiles([[legacyZshrc, 'tree an older daemon still launches from']], '[test]')
    const ancient = new Date(Date.now() - 400 * DAY_MS)
    utimesSync(join(userData, 'shell-ready'), ancient, ancient)

    const base = join(userData, 'shell-wrappers')
    const build = builderFor('a')
    const keepRoot = resolveShellReadyWrapperRoot(base, build)
    write(keepRoot, build)

    pruneStaleShellReadyWrapperRoots(base, keepRoot)

    expect(existsSync(legacyZshrc)).toBe(true)
  })

  // Why: the delete is recursive, so it must only ever consider names this store
  // could itself have produced.
  it('ignores directories it could not have created', () => {
    const base = makeBase()
    const build = builderFor('a')
    const keepRoot = resolveShellReadyWrapperRoot(base, build)
    write(keepRoot, build)

    const foreign = join(base, 'not-a-wrapper-tree')
    mkdirSync(foreign, { recursive: true })
    const longAgo = new Date(Date.now() - 400 * DAY_MS)
    utimesSync(foreign, longAgo, longAgo)

    pruneStaleShellReadyWrapperRoots(base, keepRoot)

    expect(existsSync(foreign)).toBe(true)
  })

  // Why: main and the daemon hash to different trees under one base dir and each
  // exempts only its own, so an aged-but-live sibling is the tree most likely to
  // be collected out from under a running process. Writes land two levels down,
  // so without an explicit liveness stamp the hash dir's mtime never advances
  // past its creation time and this deletes an actively-used tree.
  it('keeps an aged sibling tree that is still launching shells', () => {
    const base = makeBase()
    const mine = builderFor('mine')
    const sibling = builderFor('sibling')
    const myRoot = resolveShellReadyWrapperRoot(base, mine)
    const siblingRoot = resolveShellReadyWrapperRoot(base, sibling)
    write(myRoot, mine)
    write(siblingRoot, sibling)

    const longAgo = new Date(Date.now() - 40 * DAY_MS)
    utimesSync(dirname(myRoot), longAgo, longAgo)
    utimesSync(dirname(siblingRoot), longAgo, longAgo)

    // The sibling process launches a shell: it takes the cached ensure path and
    // stamps liveness without rewriting anything.
    markShellReadyWrapperRootInUse(siblingRoot)

    pruneStaleShellReadyWrapperRoots(base, myRoot)

    expect(existsSync(join(siblingRoot, 'bash', 'rcfile'))).toBe(true)
  })

  it('still collects an aged tree that nothing has launched from', () => {
    const base = makeBase()
    const mine = builderFor('mine')
    const abandoned = builderFor('abandoned')
    const myRoot = resolveShellReadyWrapperRoot(base, mine)
    const abandonedRoot = resolveShellReadyWrapperRoot(base, abandoned)
    write(myRoot, mine)
    write(abandonedRoot, abandoned)

    const longAgo = new Date(Date.now() - 40 * DAY_MS)
    utimesSync(dirname(abandonedRoot), longAgo, longAgo)

    pruneStaleShellReadyWrapperRoots(base, myRoot)

    expect(existsSync(dirname(abandonedRoot))).toBe(false)
  })
})
