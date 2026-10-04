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

One command to lint, format check and type check your project, find unused code, and keep a monorepo consistent. `uncheck` runs the oxlint, oxfmt, knip, tsc and sherif you installed, so you, your git hooks and your coding agents all run the same check.

```sh
npx uncheck init    # set up your project, step by step
npx uncheck         # check everything
npx uncheck --fix   # fix what can be fixed, report the rest
```

## Get started

You need Node 22.20 or later and a `package.json`. In your project folder, run:

```sh
npx uncheck init   # or pnpm dlx, yarn dlx, bunx
```

`init` asks up to four quick questions. Space toggles a choice and Enter confirms.

1. **Which tools to install:** oxlint and oxfmt, plus sherif at a [workspace root](#monorepos). It lists the ones you're missing, all selected.
2. **Which tools get a [preset](#presets) config:** opt-in, nothing is preselected.
3. **Whether to check every commit:** adds a [pre-commit hook](#check-every-commit).
4. **Which coding agents run it [after each turn](#check-every-agent-turn):** agents whose config folder you have, such as `.claude` or `.github/hooks`, are preselected.

Then it installs everything with your package manager and sets it up:

```text
$ npx uncheck init
uncheck init in /home/me/my-app
✔ Which tools should uncheck install? …  oxlint, oxfmt
✔ Which tools should get a config from the middleapi preset? …  oxlint, oxfmt
✔ Check the staged files before every commit? … yes
✔ Which agents should run uncheck when they finish a turn? …  Claude Code
▶ npm install --save-dev uncheck oxlint oxfmt
✔ oxlint oxlint.config.ts created
✔ oxfmt oxfmt.config.ts created
✔ package.json scripts check, fix and prepare written
✔ pre-commit .git/hooks/pre-commit created
✔ Claude Code .claude/settings.json created

Run npm run check to check the project, and npm run fix to fix what can be fixed.
```

That's it! TypeScript and knip are up to you: tsc joins in once you install it and add a `tsconfig.json`, and knip once you install it. `init` keeps any `check` or `fix` scripts you already have, and running it again only sets up what's missing.

<details>
<summary>Set up without questions</summary>

Without a terminal, `npx uncheck init --yes` takes the default answers: it installs the missing tools, checks every commit, and sets up the agents whose config folders exist. It writes no preset config.

Or set up by hand: `npm i -D uncheck oxlint oxfmt typescript` (plus `sherif` in a monorepo), then add the scripts `"check": "uncheck"`, `"fix": "uncheck --fix"` and [`prepare`](#check-every-commit).

</details>

## Check your project

Run `npx uncheck`, or `npm run check`, locally and in CI. Every check runs, even after one fails, so one run shows you every problem:

```text
$ npx uncheck
uncheck in /home/me/my-app
○ sherif skipped, not installed
▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern
✔ oxlint passed 67ms
▶ oxfmt --check --no-error-on-unmatched-pattern
Format issues found in above 2 files. Run without `--check` to fix.
✘ oxfmt failed 65ms
○ knip skipped, not installed
▶ tsc -p tsconfig.json --noEmit
src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
✘ tsc failed 384ms

✘ 2 of 3 checks failed: oxfmt, tsc
  rerun with `--fix` to apply oxfmt fixes
```

A check runs only when your project uses its tool, with the version and config you already have:

| Check    | Checks                                 | Runs when                                                                                                  |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sherif` | monorepo consistency                   | [sherif](https://github.com/QuiiBz/sherif) is installed (needs 1.10+), at the [workspace root](#monorepos) |
| `oxlint` | lint rules                             | [oxlint](https://oxc.rs) is installed (needs 1.60+)                                                        |
| `oxfmt`  | formatting                             | [oxfmt](https://oxc.rs) is installed                                                                       |
| `knip`   | unused files, exports and dependencies | [knip](https://knip.dev) is installed (needs 6+), in a folder with a `package.json`                        |
| `tsc`    | types                                  | the project has a `tsconfig.json`                                                                          |

uncheck exits with code 1 when a check fails, when no check could run, or when there's a `tsconfig.json` but no TypeScript, so a broken setup never passes quietly.

### Fix what can be fixed

```sh
npx uncheck --fix   # or npm run fix
```

This applies oxlint's fixes, rewrites the formatting with oxfmt, and applies [sherif's fixes](#monorepos), after which sherif runs your install. Type errors are yours to fix, and so is what knip finds: `knip --fix` rewrites exports and dependencies across the whole project, so uncheck leaves it to you to run and review.

### Pick the checks

```sh
npx uncheck --only=oxlint --only=oxfmt   # run only these checks
npx uncheck --skip=tsc                   # skip a check
npx uncheck --require=tsc                # fail when tsc cannot run, instead of skipping it
npx uncheck --cwd packages/app           # run in another folder
```

You can repeat `--only`, `--skip` and `--require`, and the [commit](#check-every-commit) and [agent](#check-every-agent-turn) hooks take them too. Run `npx uncheck <command> --help` to see every flag.

### Check specific files

```sh
npx uncheck src/index.ts src/cli.ts   # files
npx uncheck src/app                   # a folder
npx uncheck 'src/**/*.test.ts'        # a glob, quoted so your shell leaves it alone
npx uncheck src '!src/generated'      # a folder, minus a part of it
npx uncheck '!**/*.gen.ts'            # everything except some files
```

Every tool gets the same file list, so they never disagree about what a path means.

- Folders and globs match the files git knows about: tracked, or new and not ignored.
- A path that exists is never read as a glob, so `'app/[id]/page.tsx'` just works.
- A path that matches nothing fails the run, unless you pass `--no-error-on-unmatched-pattern`.
- tsc checks only the projects that include those files, and the projects that depend on them. knip checks the whole project, unless every file is an image, a font or audio. sherif runs only when a `package.json` or `pnpm-workspace.yaml` is among them.

## Check every commit

Said yes to this in `init`? You're all set. (If you ran `init` before `git init`, run `npm run prepare` once to write the hook.)

Otherwise, run `npx uncheck init` again and say yes, or add the `prepare` script yourself and run `npm run prepare` once. Every clone then gets the hook on install:

```json
{
  "scripts": {
    "prepare": "uncheck prepare --pre-commit"
  }
}
```

Already have a `prepare` script? Chain them: `"prepare": "husky && uncheck prepare --pre-commit"`.

Now every commit runs `uncheck staged --fix`, no lint-staged needed. It checks your staged files, fixes what oxlint and oxfmt can, and stages those fixes:

```text
uncheck staged in /home/me/my-app
○ sherif skipped, not installed
▶ oxlint --fix --no-error-on-unmatched-pattern src/y.ts
✔ oxlint passed 111ms
▶ oxfmt --no-error-on-unmatched-pattern src/y.ts
✔ oxfmt passed 106ms
○ knip skipped, not installed
○ tsc skipped, no tsconfig.json found
✔ staged the fixes to src/y.ts

✔ all checks passed (oxlint, oxfmt)
```

A failing check stops the commit. In a hurry? `git commit --no-verify` skips the hook.

To change the hook, add flags to the `prepare` script and run it again, for example `"prepare": "uncheck prepare --pre-commit --only=oxlint --only=oxfmt"`. A flag you pass only by hand is undone by the next install.

| Flag                            | Effect                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `--no-fix`                      | Only check, never change your files                          |
| `--allow-empty`                 | Let a commit through when the fixes undo every staged change |
| `--only`, `--skip`, `--require` | Pick the checks the hook runs                                |

Your work stays safe. After `git add -p`, the unstaged part of a file is set aside during the checks and put back afterwards, even if you press Ctrl-C. If a fix clashes with your unstaged changes, every fix is undone and the commit stops.

Good to know:

- **tsc and knip check whole projects as they are on disk**, so they can report problems in files you didn't stage, such as a scratch file knip finds unused, or pass thanks to one you forgot to `git add`. `--only=oxlint --only=oxfmt` keeps the hook fast and limited to what you staged.
- **Yarn 2+** doesn't run `prepare`, so use `postinstall` (`init` does this for you). In a package you publish, turn `postinstall` off while packing, for example with [pinst](https://github.com/typicode/pinst).
- **Production installs** that skip devDependencies (`npm ci --omit=dev`, `NODE_ENV=production`) still run the script, but without uncheck. Append `|| exit 0` so they pass: `"prepare": "uncheck prepare --pre-commit || exit 0"`.

<details>
<summary>More about the pre-commit hook</summary>

- An existing shell hook is kept, and uncheck adds its own line. With husky 9 or Vite+, it writes the `pre-commit` file they run.
- When uncheck can't safely write the hook, for example outside git, with a global `core.hooksPath` or when the existing hook isn't a shell script, it says why and your install keeps working.
- Removing uncheck? Also delete its line from the `pre-commit` hook and its entries in your agent configs, or they fail.

</details>

## Check every agent turn

Let your coding agent clean up after itself. Picked your agents in `init`? You're all set. Otherwise, add uncheck to your project (`npm i -D uncheck`, the hook never downloads it) and pick your agents from the list:

```text
$ npx uncheck hooks install
✔ Which agents should run uncheck when they finish a turn? …  Claude Code
✔ Claude Code .claude/settings.json created

The hook runs npx --no uncheck hooks run --fix whenever the agent finishes a turn.
```

In a script, name them instead: `npx uncheck hooks install claude cursor`.

| Agent          | Name        | Config file                  |
| -------------- | ----------- | ---------------------------- |
| Claude Code    | `claude`    | `.claude/settings.json`      |
| CodeBuddy      | `codebuddy` | `.codebuddy/settings.json`   |
| Cursor         | `cursor`    | `.cursor/hooks.json`         |
| GitHub Copilot | `copilot`   | `.github/hooks/uncheck.json` |

When the agent finishes a turn, the hook checks the files changed since the last commit and fixes what oxlint and oxfmt can. If problems remain, it sends the agent back to fix them, but never twice in a row, so an agent can't get stuck in a loop. Outside git, or before the first commit, it checks and fixes the whole folder.

- **Too slow or noisy?** tsc and knip check whole projects, so they can flag problems the agent didn't cause. Leave them to CI: `npx uncheck hooks install --only=oxlint --only=oxfmt`. Install again to change the flags.
- **Avoid double runs.** Cursor and Copilot CLI also run the hooks in `.claude/settings.json`. If you set up `claude`, add `cursor` or `copilot` only where they don't read that file.
- **Your config is kept.** Other hooks and settings stay, but comments in the file are lost.

## Monorepos

Run both `init` and uncheck at the workspace root: the folder whose `package.json` has `workspaces` or whose `pnpm-workspace.yaml` lists `packages`. One run checks every package.

**sherif** checks the workspace as a whole, so it runs only at the root. Configure it in the `sherif` field of the root `package.json`, [as sherif documents](https://github.com/QuiiBz/sherif). It only reports in the hooks and when `CI` is set, so run `npx uncheck --fix` locally to apply its fixes. Leave out `"fix": true`, or every run that only reports fails.

**knip** analyzes the workspace as a whole and reads its config at the root. In a package, uncheck runs it from the workspace root with `--workspace`, so it reports only on that package.

**TypeScript.** uncheck finds every `tsconfig.json` and follows their `references`, so a config with another name, like `tsconfig.app.json`, is checked when a reference leads to it. Projects linked by `references` are built together with one `tsc -b`, and the rest are checked with `tsc -p --noEmit`.

**Hooks.** The root's pre-commit hook already covers every package. A package whose own `prepare` script runs `uncheck prepare --pre-commit` adds a line with its own flags, which also runs when a commit touches that package. An agent hook installed in a package checks only that package; add uncheck to the workspace root too if the agent may work outside it.

<details>
<summary>How uncheck runs tsc</summary>

- `tsc -b` writes what your configs ask for, such as declarations. A project in a references graph that would write JavaScript next to its sources, like the `tsconfig.node.json` of older Vite templates, is checked with `tsc -p --noEmit` instead, and so are the projects that reference it. If git ignores that JavaScript, the project stays in `tsc -b`.
- In a folder without its own `tsconfig.json`, such as a package, uncheck uses the nearest `tsconfig.json` above it in the same git repository, if that one includes files of the folder.

</details>

## Presets

uncheck ships the lint, format and TypeScript configs the [middleapi](https://github.com/middleapi) projects share. They're optional, and `init` can write the oxlint and oxfmt ones for you. They need oxlint 1.70+, oxfmt 0.43+ and TypeScript 5.6+. Copying one by hand? Name the file `.mts` unless your `package.json` has `"type": "module"`.

```ts
// oxlint.config.ts: oxlint's defaults plus a few rules that catch real bugs
import { defineConfig } from 'oxlint'
import { middleapi } from 'uncheck/oxlint'

export default defineConfig({ extends: [middleapi] })
```

```ts
// oxfmt.config.ts: no semicolons, single quotes and sorted imports
import { defineConfig } from 'oxfmt'
import { middleapi } from 'uncheck/oxfmt'

export default defineConfig({ ...middleapi })
```

```jsonc
// tsconfig.json: extend `uncheck/tsconfig/middleapi` to type check only,
// or `uncheck/tsconfig/middleapi/lib` in a package that emits declarations to dist
{
  "extends": "uncheck/tsconfig/middleapi",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"],
}
```

The tsconfig presets include no Node.js or browser types, so add the ones you need: `"types": ["node"]` for Node.js, or `"lib": ["ES2022", "DOM", "DOM.Iterable"]` for browsers.

## Troubleshooting

**"✘ nothing to check".** No check could run, and the message says why. Usually no tool is installed yet, so run `npx uncheck init`. A "○ nothing to check" line is only a notice, and the run passes.

**A path looks like a command, a flag or an exclusion.** Start it with `./`: `./staged`, `./-draft.ts`, `'./!notes.ts'`.

**`npx uncheck dist` says "No files match".** git ignores that folder. You can still name an ignored file directly.

**"detected dubious ownership".** git doesn't trust a repository another user owns, for example in a container mount, so the hooks can't run there. Run the `safe.directory` command that `git status` prints, then `npm run prepare` to write the hook.

**A commit stops with "An earlier run left the unstaged versions of your files in …".** A pre-commit run was killed, or couldn't put your unstaged changes back. Unless another commit is still running, copy back what your files are missing from that folder, delete it, and commit again.

## Sponsors

Like what we build over at [middleapi](https://github.com/middleapi)? You can help keep it going through [GitHub Sponsors](https://github.com/sponsors/dinwwwh) or [Open Collective](https://opencollective.com/middleapi). Every bit helps! 🚀

<table>
  <tr>
   <td width="2000"><a href="https://screenshotone.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="The screenshot API for developers"><img src="https://avatars.githubusercontent.com/u/97035603?v=4" width="64" align="left" hspace="12" alt="ScreenshotOne.com"/><b>ScreenshotOne.com</b></a><br /><sub>The screenshot API for developers</sub></td>
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
   <td align="center"><a href="https://github.com/herrfugbaum?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="herrfugbaum"><img src="https://avatars.githubusercontent.com/u/12859776?u=644dc1666d0220bc0468eb0de3c56b919f635b16&amp;v=4" width="139" alt="herrfugbaum"/><br />herrfugbaum</a></td>
   <td align="center"><a href="https://laststance.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ryota Murakami"><img src="https://avatars.githubusercontent.com/u/5501268?u=599389e03340734325726ca3f8f423c021d47d7f&amp;v=4" width="139" alt="Ryota Murakami"/><br />Ryota Murakami</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://cra.mr/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="David Cramer"><img src="https://avatars.githubusercontent.com/u/23610?v=4" width="139" alt="David Cramer"/><br />David Cramer</a></td>
   <td align="center"><a href="https://valerii15298.github.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Valerii Petryniak"><img src="https://avatars.githubusercontent.com/u/44531564?u=88ac74d9bacd20401518441907acad21063cd397&amp;v=4" width="139" alt="Valerii Petryniak"/><br />Valerii Petryniak</a></td>
   <td align="center"><a href="https://letstri.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Valerii Strilets"><img src="https://avatars.githubusercontent.com/u/13253748?u=c7b10399ccc8f8081e24db94ec32cd9858e86ac3&amp;v=4" width="139" alt="Valerii Strilets"/><br />Valerii Strilets</a></td>
   <td align="center"><a href="https://blacklight.sh/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kyle Mistele"><img src="https://avatars.githubusercontent.com/u/18430555?u=3afebeb81de666e35aaac3ed46f14159d7603ffb&amp;v=4" width="139" alt="Kyle Mistele"/><br />Kyle Mistele</a></td>
   <td align="center"><a href="https://github.com/christ12938?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="christ12938"><img src="https://avatars.githubusercontent.com/u/25758598?v=4" width="139" alt="christ12938"/><br />christ12938</a></td>
   <td align="center"><a href="https://github.com/Ryanjso?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ryan Soderberg"><img src="https://avatars.githubusercontent.com/u/39172778?u=5ed913c31d57e7221b75784abcad48c7ebddde27&amp;v=4" width="139" alt="Ryan Soderberg"/><br />Ryan Soderberg</a></td>
  </tr>
  <tr>
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
   <td align="center"><a href="https://nakasyou.how/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Shotaro Nakamura"><img src="https://avatars.githubusercontent.com/u/79000684?u=f644df3f29f0e8677a90967115774564f1d9d6ab&amp;v=4" width="119" alt="Shotaro Nakamura"/><br />Shotaro Nakamura</a></td>
   <td align="center"><a href="https://piscis.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Alex"><img src="https://avatars.githubusercontent.com/u/326163?u=b245f368bd940cf51d08c0b6bf55f8257f359437&amp;v=4" width="119" alt="Alex"/><br />Alex</a></td>
   <td align="center"><a href="https://opensource.gubanov.eu/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Andrey Gubanov"><img src="https://avatars.githubusercontent.com/u/1082083?u=c5f2daf7ebece498e85c83367bb37b4e10e2649d&amp;v=4" width="119" alt="Andrey Gubanov"/><br />Andrey Gubanov</a></td>
  </tr>
</table>

With thanks to [38 past sponsors](https://htmlpreview.github.io/?https://github.com/middleapi/static/blob/main/sponsors.svg) who helped get us here.

## License

Distributed under the MIT License. See [LICENCE](https://github.com/middleapi/uncheck/blob/main/LICENCE) for more information.
