# Unified Check Command

<div align="center">
  <a href="https://codecov.io/gh/middleapi/uncheck">
      <img alt="codecov" src="https://codecov.io/gh/middleapi/uncheck/branch/main/graph/badge.svg">
  </a>
  <a href="https://www.npmjs.com/package/uncheck">
    <img alt="weekly downloads" src="https://img.shields.io/npm/dw/uncheck?logo=npm" />
  </a>
  <a href="https://app.codspeed.io/middleapi/uncheck?utm_source=badge">
    <img src="https://img.shields.io/endpoint?url=https://codspeed.io/badge.json" alt="CodSpeed" />
  </a>
  <a href="https://github.com/middleapi/uncheck/blob/main/LICENCE">
    <img alt="MIT License" src="https://img.shields.io/github/license/middleapi/uncheck?logo=open-source-initiative" />
  </a>
  <a href="https://discord.gg/TXEbwRBvQn">
    <img alt="Discord" src="https://img.shields.io/discord/1308966753044398161?color=7389D8&label&logo=discord&logoColor=ffffff" />
  </a>
  <a href="https://deepwiki.com/middleapi/uncheck">
    <img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki">
  </a>
</div>

`uncheck` lints, format checks and type checks your project with one command, and keeps a monorepo consistent. It runs the tools your project already has, so you, your git hooks and your coding agents all run the same check.

```sh
npm i -D uncheck oxlint oxfmt typescript   # add sherif in a monorepo

npx uncheck                        # check everything
npx uncheck --fix                  # fix what can be fixed, report the rest
npx uncheck prepare --pre-commit   # check every commit
npx uncheck hooks install claude   # check every agent turn
```

uncheck needs Node 22.20 or later. Install only the tools you want: a check runs when its tool is installed and is skipped otherwise, except that a `tsconfig.json` without TypeScript installed fails. uncheck always uses the versions you installed.

| Check    | Checks               | Runs when                                                                                          |
| -------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `sherif` | monorepo consistency | [sherif](https://github.com/QuiiBz/sherif) 1.10+ is installed, at the [workspace root](#monorepos) |
| `oxlint` | lint rules           | [oxlint](https://oxc.rs) 1.60+ is installed                                                        |
| `oxfmt`  | formatting           | [oxfmt](https://oxc.rs) is installed                                                               |
| `tsc`    | types                | the project has a `tsconfig.json`                                                                  |

## Check your project

```text
$ npx uncheck
uncheck in /home/me/my-app
○ sherif skipped, not installed
▶ oxlint
✔ oxlint passed 67ms
▶ oxfmt --check
Format issues found in above 2 files. Run without `--check` to fix.
✘ oxfmt failed 65ms
▶ tsc -p tsconfig.json --noEmit
src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
✘ tsc failed 384ms

✘ 2 of 3 checks failed: oxfmt, tsc
  rerun with `--fix` to apply oxfmt fixes
```

Every check runs, so one run shows every problem. uncheck exits with 1 when a check fails, and also when no check could run, so a broken setup never passes quietly.

```sh
npx uncheck --only=oxlint --only=oxfmt   # run only these checks
npx uncheck --skip=tsc                   # skip a check
npx uncheck --require=tsc                # fail when tsc cannot run, instead of skipping it
npx uncheck --cwd packages/app           # run in another directory
```

`--only`, `--skip` and `--require` can be repeated and work on every command. Flags go after the command name (`npx uncheck staged --fix`), and `npx uncheck <command> --help` lists them all.

`--fix` applies oxlint's fixes, rewrites the formatting with oxfmt, and applies sherif's fixes, which runs your package manager's install afterwards. Type errors are yours to fix.

## Check only some files

```sh
npx uncheck src/index.ts src/cli.ts   # files
npx uncheck src/app                   # a directory
npx uncheck 'src/**/*.test.ts'        # a glob, quoted so your shell leaves it alone
npx uncheck src '!src/generated'      # a directory, minus a part of it
npx uncheck '!**/*.gen.ts'            # everything except some files
```

uncheck turns your paths into one file list that every tool gets, so they never disagree about what a path means. Directories and globs match the files git knows about (tracked, or new and not ignored), dot files included. A path that exists is never read as a glob, so `'app/[id]/page.tsx'` and `'app/(marketing)/**'` just work. A path that matches nothing fails the run, unless you pass `--no-error-on-unmatched-pattern`.

tsc then checks only the projects that include one of the files, and sherif runs only when a `package.json` or `pnpm-workspace.yaml` is among them.

## Run it before every commit

Add a `prepare` script, so every clone sets up the hook on install, and run it once now:

```json
{
  "scripts": {
    "prepare": "uncheck prepare --pre-commit"
  }
}
```

Every commit then runs `uncheck staged --fix`: it checks the staged files, fixes what oxlint and oxfmt can, and stages those fixes. A failing check blocks the commit, and `git commit --no-verify` skips the hook. No lint-staged or simple-git-hooks needed.

| `prepare` flag                  | Effect                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| `--no-fix`                      | The hook only checks and never changes your files                      |
| `--allow-empty`                 | The hook lets a commit through when the fixes undo every staged change |
| `--only`, `--skip`, `--require` | Written into the hook command                                          |

Run `prepare` again with other flags to change the hook. What it guarantees:

- **You commit what was checked.** After `git add -p`, the unstaged part of a file is set aside while the checks run and put back afterwards, even after Ctrl-C.
- **Nothing is lost.** If a fix clashes with your unstaged changes, every fix is undone and the commit stops. Stage the whole file, or stash the rest, and commit again.
- **Only fixes to staged files are staged.** During a merge, only files that differ from the branch being merged in are checked.
- **No empty commits.** If the fixes undo every staged change, the commit fails, unless you pass `--allow-empty`.

Good to know:

- tsc checks whole projects, so it can report errors in files you did not stage. `--only=oxlint --only=oxfmt` keeps the hook inside the commit.
- sherif only reports in the hook, since its fixes reach beyond the commit. Run `npx uncheck --fix` for them.
- A commit no selected check covers, such as a README change with `--only=tsc`, passes. Add `--require=tsc` to make it fail.
- An existing hook is kept: uncheck adds one line after its setup (comments, `source`, `export`, variables) and before its commands. With husky 9 or Vite+, it writes the `pre-commit` file they run.
- uncheck writes nothing, and says why, outside a git repository, when `core.hooksPath` comes from your global or system git config, or when the existing hook is not a shell script. Your install keeps working.
- The hook runs uncheck through your package manager (`pnpm exec`, `yarn run --silent`, `bunx --no-install` or `npx --no`), so a missing install fails instead of downloading uncheck.
- Yarn 2+ does not run `prepare`. Use `postinstall` instead, and in a package you publish, turn it off while packing, for example with `"prepack": "pinst --disable"` and `"postpack": "pinst --enable"`.

## Run it after every agent turn

```sh
npx uncheck hooks install claude codebuddy   # name the agents
npx uncheck hooks install                    # or pick them from a list
```

| Agent          | Name        | Config file                  |
| -------------- | ----------- | ---------------------------- |
| Claude Code    | `claude`    | `.claude/settings.json`      |
| CodeBuddy      | `codebuddy` | `.codebuddy/settings.json`   |
| Cursor         | `cursor`    | `.cursor/hooks.json`         |
| GitHub Copilot | `copilot`   | `.github/hooks/uncheck.json` |

Whenever the agent finishes a turn, the hook runs `uncheck hooks run --fix`. It checks the files changed since the last commit, fixes what it can, and when problems remain, sends the agent back to fix them. That happens at most once per turn, so an agent that cannot fix something is never stuck in a loop.

- **Too slow?** Leave the typecheck to CI: `npx uncheck hooks install claude --only=oxlint --only=oxfmt`. Install again to change the flags.
- **Your config is kept.** Other hooks and settings stay, and installing again only updates uncheck's entry. Comments in the file are lost when it is rewritten.
- **Avoid double runs.** Cursor and Copilot CLI also run the hooks in `.claude/settings.json`, so add `cursor` or `copilot` next to `claude` only where they do not read that file.
- **Copilot** reads `.github/hooks` only at the top of the repository, so install `copilot` from there.

## Monorepos

Run uncheck from the workspace root, the folder whose `package.json` has `workspaces` or that has a `pnpm-workspace.yaml`, to check the whole monorepo.

**sherif** checks the workspace as a whole, so it only runs at the root. Configure it in the `sherif` field of the root `package.json`, [as sherif documents](https://github.com/QuiiBz/sherif). With `--fix`, mismatched versions move to the highest one (unless you set `select`), and your install runs afterwards (unless you set `"noInstall": true`). When `CI` is set, sherif only reports.

**TypeScript.** uncheck finds every `tsconfig.json` and follows their `references`:

- Projects linked by `references` are built with one `tsc -b`, which writes what your configs ask for, such as declarations.
- Every other project is checked with `tsc -p --noEmit`, a few at a time.
- When only some files are checked, tsc runs just the projects that include them, and the projects that reference those. A changed tsconfig selects every project that extends it.

**Hooks.** Each package that runs `uncheck prepare --pre-commit` gets its own line in the one pre-commit hook, with its own flags:

```sh
#!/bin/sh
# Written by `uncheck prepare`, run it again to change the command.
pnpm exec uncheck staged --fix || exit 1
(cd "packages/a" && pnpm exec uncheck staged --fix --only=oxlint) || exit 1
(cd "packages/b" && pnpm exec uncheck staged --fix) || exit 1
```

An agent hook installed from a package folder checks only that package, wherever the agent moves to.

## Presets

uncheck also ships the lint, format and TypeScript configs the [middleapi](https://github.com/middleapi) projects share. They are optional.

```ts
// oxlint.config.ts
import { defineConfig } from 'oxlint'
import { middleapi } from 'uncheck/oxlint'

export default defineConfig({ extends: [middleapi] })
```

```ts
// oxfmt.config.ts
import { defineConfig } from 'oxfmt'
import { middleapi } from 'uncheck/oxfmt'

export default defineConfig({ ...middleapi })
```

```jsonc
// tsconfig.json: `uncheck/tsconfig/middleapi` to only type check,
// `uncheck/tsconfig/middleapi/lib` for a package that emits its declarations to dist
{
  "extends": "uncheck/tsconfig/middleapi",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"],
}
```

The presets need oxlint 1.70+, oxfmt 0.41+ and TypeScript 5.6+. The tsconfig presets load no runtime types, so name yours: `"types": ["node"]` for Node.js, or `"lib": ["ES2022", "DOM", "DOM.Iterable"]` for browsers.

## Troubleshooting

**A path looks like a command, a flag or an exclusion.** Start it with `./`: `./staged`, `./-draft.ts`, `'./!notes.ts'`.

**`uncheck dist` says "No files match".** git ignores that folder, so it holds no project files. You can still name an ignored file directly.

**A commit stops with "An earlier run left the unstaged versions of your files in …".** A pre-commit run was killed before it could put your unstaged changes back. Copy what your files are missing from the folder the message names, delete the folder, and commit again.

## Sponsors

Like what we build over at [middleapi](https://github.com/middleapi)? You can help keep it going through [GitHub Sponsors](https://github.com/sponsors/dinwwwh) or [Open Collective](https://opencollective.com/middleapi). Every bit helps! 🚀

<table>
  <tr>
   <td width="2000"><a href="https://screenshotone.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener" title="The screenshot API for developers"><img src="https://avatars.githubusercontent.com/u/97035603?v=4" width="64" align="left" hspace="12" alt="ScreenshotOne.com"/><b>ScreenshotOne.com</b></a><br /><sub>The screenshot API for developers</sub></td>
  </tr>
  <tr>
   <td width="2000"><a href="https://yuzu.health/careers?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="We&#39;re hiring NYC based engineers"><img src="https://avatars.githubusercontent.com/u/102488956?v=4" width="64" align="left" hspace="12" alt="Yuzu"/><b>Yuzu</b></a><br /><sub>We&#39;re hiring NYC based engineers</sub></td>
  </tr>
  <tr>
   <td width="2000"><a href="https://misskey.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Decentralized microblogging SNS born on Earth"><img src="https://github.com/MisskeyIO.png" width="64" align="left" hspace="12" alt="MisskeyHQ"/><b>MisskeyHQ</b></a><br /><sub>Decentralized microblogging SNS born on Earth</sub></td>
  </tr>
</table>

### Special Sponsors

<table>
  <tr>
   <td align="center"><a href="http://twitter.com/rauchg?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Guillermo Rauch"><img src="https://avatars.githubusercontent.com/u/13041?u=1ee8d111657cdd02ff6d253df00978d17ee6d722&amp;v=4" width="279" alt="Guillermo Rauch"/><br />Guillermo Rauch</a></td>
  </tr>
</table>

### Premium Sponsors

<table>
  <tr>
   <td align="center"><a href="https://github.com/nexa-ca?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Nexa"><img src="https://avatars.githubusercontent.com/u/199146462?v=4" width="209" alt="Nexa"/><br />Nexa</a></td>
  </tr>
</table>

### Organization Sponsors

<table>
  <tr>
   <td align="center"><a href="https://lnmarkets.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="LN Markets"><img src="https://avatars.githubusercontent.com/u/70597625?v=4" width="167" alt="LN Markets"/><br />LN Markets</a></td>
  </tr>
</table>

### Sponsors

<table>
  <tr>
   <td align="center"><a href="https://github.com/hrmcdonald?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Reece McDonald"><img src="https://avatars.githubusercontent.com/u/39349270?v=4" width="139" alt="Reece McDonald"/><br />Reece McDonald</a></td>
   <td align="center"><a href="https://soymilk.party/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="あわわわとーにゅ"><img src="https://avatars.githubusercontent.com/u/17376330?u=de3353804be889f009f7e0a1582daf04d0ab292d&amp;v=4" width="139" alt="あわわわとーにゅ"/><br />あわわわとーにゅ</a></td>
   <td align="center"><a href="https://github.com/nicognaW?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="nk"><img src="https://avatars.githubusercontent.com/u/66731869?u=4699bda3a9092d3ec34fbd959450767bcc8b8b6d&amp;v=4" width="139" alt="nk"/><br />nk</a></td>
   <td align="center"><a href="https://supastarter.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="supastarter"><img src="https://avatars.githubusercontent.com/u/110960143?v=4" width="139" alt="supastarter"/><br />supastarter</a></td>
   <td align="center"><a href="https://github.com/divmgl?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Dexter Miguel"><img src="https://avatars.githubusercontent.com/u/5452298?u=645993204be8696c085ecf0d228c3062efe2ed65&amp;v=4" width="139" alt="Dexter Miguel"/><br />Dexter Miguel</a></td>
   <td align="center"><a href="https://github.com/herrfugbaum?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="herrfugbaum"><img src="https://avatars.githubusercontent.com/u/12859776?u=644dc1666d0220bc0468eb0de3c56b919f635b16&amp;v=4" width="139" alt="herrfugbaum"/><br />herrfugbaum</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://laststance.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ryota Murakami"><img src="https://avatars.githubusercontent.com/u/5501268?u=599389e03340734325726ca3f8f423c021d47d7f&amp;v=4" width="139" alt="Ryota Murakami"/><br />Ryota Murakami</a></td>
   <td align="center"><a href="https://cra.mr/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="David Cramer"><img src="https://avatars.githubusercontent.com/u/23610?v=4" width="139" alt="David Cramer"/><br />David Cramer</a></td>
   <td align="center"><a href="https://valerii15298.github.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Valerii Petryniak"><img src="https://avatars.githubusercontent.com/u/44531564?u=88ac74d9bacd20401518441907acad21063cd397&amp;v=4" width="139" alt="Valerii Petryniak"/><br />Valerii Petryniak</a></td>
   <td align="center"><a href="https://letstri.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Valerii Strilets"><img src="https://avatars.githubusercontent.com/u/13253748?u=c7b10399ccc8f8081e24db94ec32cd9858e86ac3&amp;v=4" width="139" alt="Valerii Strilets"/><br />Valerii Strilets</a></td>
   <td align="center"><a href="https://blacklight.sh/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kyle Mistele"><img src="https://avatars.githubusercontent.com/u/18430555?u=3afebeb81de666e35aaac3ed46f14159d7603ffb&amp;v=4" width="139" alt="Kyle Mistele"/><br />Kyle Mistele</a></td>
   <td align="center"><a href="https://github.com/christ12938?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="christ12938"><img src="https://avatars.githubusercontent.com/u/25758598?v=4" width="139" alt="christ12938"/><br />christ12938</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://github.com/Ryanjso?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ryan Soderberg"><img src="https://avatars.githubusercontent.com/u/39172778?u=5ed913c31d57e7221b75784abcad48c7ebddde27&amp;v=4" width="139" alt="Ryan Soderberg"/><br />Ryan Soderberg</a></td>
   <td align="center"><a href="https://github.com/itigoore01?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="shota"><img src="https://avatars.githubusercontent.com/u/11831107?u=c976a6dc7e055eb026304c46c99100ed22b0c8e0&amp;v=4" width="139" alt="shota"/><br />shota</a></td>
   <td align="center"><a href="https://github.com/ellis-driscoll?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ellis Driscoll"><img src="https://avatars.githubusercontent.com/u/70685966?u=c5f95bc33b5991d9744abe00052542e4a2ed3cb9&amp;v=4" width="139" alt="Ellis Driscoll"/><br />Ellis Driscoll</a></td>
   <td align="center"><a href="https://github.com/hoangbn?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Hoang Nguyen"><img src="https://avatars.githubusercontent.com/u/38968280?u=c90084c6de65c56facabab7ba13a72a49ddbc3e4&amp;v=4" width="139" alt="Hoang Nguyen"/><br />Hoang Nguyen</a></td>
   <td align="center"><a href="https://opencollective.com/guest-ac41de3b?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Orestis Ioannou"><img src="https://images.opencollective.com/guest-ac41de3b/avatar/460.png" width="139" alt="Orestis Ioannou"/><br />Orestis Ioannou</a></td>
   <td align="center"><a href="https://automatio.ai/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Stefan Smiljkovic"><img src="https://avatars.githubusercontent.com/u/1984909?u=b7bf5bc40ed49df3c22f69d2da7b8d78709c49ed&amp;v=4" width="139" alt="Stefan Smiljkovic"/><br />Stefan Smiljkovic</a></td>
  </tr>
</table>

### Backers

<table>
  <tr>
   <td align="center"><a href="https://github.com/rhinodavid?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="David Walsh"><img src="https://avatars.githubusercontent.com/u/5778036?u=b5521f07d2f88c3db2a0dae62b5f2f8357214af0&amp;v=4" width="119" alt="David Walsh"/><br />David Walsh</a></td>
   <td align="center"><a href="https://github.com/IPv4Addr?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="IPv4Addr"><img src="https://avatars.githubusercontent.com/u/100147665?u=59996b72f69bb53063cb7e9ff8b8f898616cd94d&amp;v=4" width="119" alt="IPv4Addr"/><br />IPv4Addr</a></td>
   <td align="center"><a href="https://robbevaes.be/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Robbe Vaes"><img src="https://avatars.githubusercontent.com/u/44748019?u=e0232402c045ad4eac7cbd217f1f47e083103b89&amp;v=4" width="119" alt="Robbe Vaes"/><br />Robbe Vaes</a></td>
   <td align="center"><a href="https://github.com/aidansunbury?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Aidan Sunbury"><img src="https://avatars.githubusercontent.com/u/64103161?v=4" width="119" alt="Aidan Sunbury"/><br />Aidan Sunbury</a></td>
   <td align="center"><a href="https://github.com/soonoo?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="soonoo"><img src="https://avatars.githubusercontent.com/u/5436405?u=5d0b4aa955c87e30e6bda7f0cccae5402da99528&amp;v=4" width="119" alt="soonoo"/><br />soonoo</a></td>
   <td align="center"><a href="https://kevinporten.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kevin Porten"><img src="https://avatars.githubusercontent.com/u/1839345?u=dc2263d5cfe0d927ce1a0be04a1d55dd6b55405c&amp;v=4" width="119" alt="Kevin Porten"/><br />Kevin Porten</a></td>
   <td align="center"><a href="https://github.com/pumpkinlink?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Denis"><img src="https://avatars.githubusercontent.com/u/11864620?u=5f47bbe6c65d0f6f5cf011021490238e4b0593d0&amp;v=4" width="119" alt="Denis"/><br />Denis</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://github.com/christopher-kapic?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Christopher Kapic"><img src="https://avatars.githubusercontent.com/u/59740769?u=e7ad4b72b5bf6c9eb1644c26dbf3332a8f987377&amp;v=4" width="119" alt="Christopher Kapic"/><br />Christopher Kapic</a></td>
   <td align="center"><a href="http://ballingt.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Tom Ballinger"><img src="https://avatars.githubusercontent.com/u/458879?u=4b045ac75d721b6ac2b42a74d7d37f61f0414031&amp;v=4" width="119" alt="Tom Ballinger"/><br />Tom Ballinger</a></td>
   <td align="center"><a href="https://lee-sam.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Sam"><img src="https://avatars.githubusercontent.com/u/102863520?u=3c89611f549d5070be232eb4532f690c8f2e7a65&amp;v=4" width="119" alt="Sam"/><br />Sam</a></td>
   <td align="center"><a href="https://github.com/Titoine?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Titoine"><img src="https://avatars.githubusercontent.com/u/3514286?u=1bb1e86b0c99c8a1121372e56d51a177eea12191&amp;v=4" width="119" alt="Titoine"/><br />Titoine</a></td>
   <td align="center"><a href="https://rigtch.fm/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Igor Makowski"><img src="https://avatars.githubusercontent.com/u/56691628?u=ee8c879478f7c151b9156aef6c74243fa3e247a8&amp;v=4" width="119" alt="Igor Makowski"/><br />Igor Makowski</a></td>
   <td align="center"><a href="https://blog.cwang.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="hanayashiki"><img src="https://avatars.githubusercontent.com/u/26056783?u=06c3b9205a16fd41a871e82da1cc2a09306d53f5&amp;v=4" width="119" alt="hanayashiki"/><br />hanayashiki</a></td>
   <td align="center"><a href="https://dubinets.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Lev Dubinets"><img src="https://avatars.githubusercontent.com/u/3114081?u=f547f5d5012cab54851f1b1ad72d10e537f78fc2&amp;v=4" width="119" alt="Lev Dubinets"/><br />Lev Dubinets</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://kellychan.im/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kelly Peilin Chan"><img src="https://avatars.githubusercontent.com/u/520852?u=6b0f7105f694e7b5cacf410a3f04c7044b469dc8&amp;v=4" width="119" alt="Kelly Peilin Chan"/><br />Kelly Peilin Chan</a></td>
   <td align="center"><a href="https://guyariely.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Guy Ariely"><img src="https://avatars.githubusercontent.com/u/42813496?u=edb6b7f563bf28e160a290832e7da57c0506f8ca&amp;v=4" width="119" alt="Guy Ariely"/><br />Guy Ariely</a></td>
   <td align="center"><a href="https://paulsenon.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="PaulSenon"><img src="https://avatars.githubusercontent.com/u/19531087?u=6385741eb91d200b8c513ec6045482e301767ca6&amp;v=4" width="119" alt="PaulSenon"/><br />PaulSenon</a></td>
   <td align="center"><a href="https://piscis.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Alex"><img src="https://avatars.githubusercontent.com/u/326163?u=b245f368bd940cf51d08c0b6bf55f8257f359437&amp;v=4" width="119" alt="Alex"/><br />Alex</a></td>
   <td align="center"><a href="https://opensource.gubanov.eu/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Andrey Gubanov"><img src="https://avatars.githubusercontent.com/u/1082083?u=c5f2daf7ebece498e85c83367bb37b4e10e2649d&amp;v=4" width="119" alt="Andrey Gubanov"/><br />Andrey Gubanov</a></td>
  </tr>
</table>

With thanks to [36 past sponsors](https://htmlpreview.github.io/?https://github.com/middleapi/static/blob/main/sponsors.svg) who helped get us here.

## License

Distributed under the MIT License. See [LICENCE](https://github.com/middleapi/uncheck/blob/main/LICENCE) for more information.
