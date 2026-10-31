<div align="center">
  <img src="assets/hero.png" alt="Looptree Dashboard — swimlanes of milestones, supports and execution records" width="100%">
</div>

<h1 align="center">Looptree Dashboard</h1>

<p align="center">
  <b>Every project gets one milestone tree that can actually be closed.</b><br>
  A DSH plugin that puts <code>project vision → milestone → support → execution</code> on one screen,
  gives every node a structured prompt, launches DSH sessions from the node that needs them,
  and reports the live status of the dev services behind it.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#data-model">Data model</a> ·
  <a href="#http-api">HTTP API</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security--boundaries">Security</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="INSTALL.md">Troubleshooting</a>
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/github/package-json/v/Roshenn/dsh-looptree-dashboard?label=version" alt="version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Roshenn/dsh-looptree-dashboard" alt="MIT license"></a>
  <a href="https://github.com/Roshenn/dsh-looptree-dashboard/stargazers"><img src="https://img.shields.io/github/stars/Roshenn/dsh-looptree-dashboard" alt="stars"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-green" alt="node >= 20">
  <img src="https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.3-blueviolet" alt="dsh >= 0.2.1-rc.3">
</p>

## Why

Agent sessions end and the reason for the work evaporates with them. A plan becomes a dozen commits
nobody can trace back to a vision, and the next session starts by guessing what "done" was supposed to mean.

Looptree Dashboard keeps that intent on disk, next to the code. Each project starts with a **project
vision** and a `rotation/v1` card file: a milestone (milestone vision + core metrics + important
supports), the **support items** that turn those supports into executable work (each with its own core
metric and approach), the plans those supports generate, and the execution records of the sessions that
did the work. The panel is the view; DSH is the engine.

## Features

- **One swimlane per project.** Milestone, support and execution-record columns at a glance. Closed
  supports fold into a `▸ closed N` chip instead of taking up space, and the **Hide closed** display-style
  toggle removes even that chip (the count moves onto the card's chips); execution records never fold, so
  you always see what just ran.
- **Vision first, supports second.** A milestone starts with a 3–6 sentence vision (≤ 1000 chars) of what
  the project should *become*, then 3–5 **important supports**: what must exist for that vision to hold,
  ordered by importance and derived from first principles. The **确认达成** gate is **at least one support
  child + every child closed** — it no longer depends on whether the supports list is filled.
- **Two kinds of core metric.** `milestone.metrics` (2–5 lines) measure whether the **vision** was
  reached; each support's own `metric` measures whether **that support** holds the milestone up and at
  what point it counts as enough. The project vision sits above both: `project.vision` (≤ 1000 chars) is
  edited from the project name's `⋯ → Project info` dialog.
- **Candidate pool with reasoning, sorted by importance.** A milestone generates candidate supports that
  carry support / necessity / causal / evidence / importance (1–5); they are stored in descending
  importance order and each row reveals a hover card. Adopting writes only the **read-only trio**
  (support / necessity / causal); the core metric and approach stay empty and are filled with
  **Generate 2 items**.
- **Plan, execute, reflect from the support.** Fill the core metric and approach to enable **Generate
  plan** (`409 FILL_REQUIRED`); when a plan exists, **Execute plan** (`409 PLAN_MISSING`). Generate plan
  sends `/plan`; execute runs `/plan off` then `/goal <objective>` in the *same* session. When the record
  finishes, reflection runs once more and stores lessons on the milestone.
- **Prompts are previewed before they are sent.** One implementation (`lib/prompt.mjs`) composes every
  prompt from the same four blocks — background, current node, task, output — and the panel shows the
  structure before sending. Per-node overrides beat card-level overrides, which beat built-ins.
- **Services live in the same lane.** Each project lists the services it depends on, probes them every
  5s, and starts them with one click using the command mapped to the current platform (`mac` /
  `windows` / `linux`). An AI pass can read the project and propose its services — as a draft you
  review and probe before anything is written back.
- **Start all / stop all across projects.** The toolbar has two batch buttons. **Start all** runs a
  port-conflict precheck first: when two services point at the same port, nothing is started and the
  panel lists the collision (fail closed); services already up are skipped. **Stop all** kills whatever
  is listening on the configured loopback ports, including services you started in a terminal, and
  reports per-port failures instead of stopping the batch.
- **Item fields are lists you edit in place.** Important-support and core-metric editors add and remove
  one item at a time (`+ Add one` / `×`), and renumber on save. There is no drag ordering: the order you
  type is the order that is written back.
- **The arithmetic is on screen.** Convergence health, close span, close rate, in-flight ages, overdue
  count and ETA are computed from the tree, not typed in by hand. Formulas are in
  [rotation-card-spec.md](rotation-card-spec.md).
- **Idle branches are highlighted.** The panel applies the parallel rule the other way round — a node
  cannot start a session while an ancestor is running — and marks the branches you can start on now:
  a `ready` tag plus a teal rail on the card, `running N · ready N` in the lane head, and a clickable
  **idle branch →** footer that scrolls to it. A lone branch that is running lights nothing up; a lone
  idle branch gets a quiet emphasis. A parent whose children are running stays dark, so you never see
  "milestone ready" next to three running supports. Single-versus-multiple is counted per project, and no
  new field is written to the card.

## See it work

| Swimlane matrix | Node detail |
|---|---|
| ![Swimlane matrix](assets/hero.png) | ![Node detail card](assets/detail.png) |
| Every project in one matrix: milestone → support → execution record. | Click any node for fields, issues, plan, execution records and prompts. |

| Prompt structure before sending |
|---|
| ![Prompt structure](assets/prompt-structure.png) |
| Every prompt shows its blocks (background / current node / task / output) before it leaves the panel. |

<details>
<summary>Full matrix — all six sample projects</summary>

![Full swimlane matrix](assets/hero-full.png)

</details>

<sub>Screenshots are the real panel at v0.12 (the current panel is three columns), running on the sample cards in `samples/`.</sub>

## Installation

Requires **DSH ≥ 0.2.1-rc.3** and **Node ≥ 20**. The plugin has no build step — `web/` is served
straight from disk.

### A. From a checkout you already have (recommended for development)

Register the repo as a link dependency of the profile you run, using **the pnpm that ships with DSH**:

```json
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-looptree-dashboard": "link:../../dsh-looptree-dashboard" }
}
```

Then restart DSH. Because the profile points at the working tree, updating is just `git pull`:
a `web/` change is live on the next page refresh, a `lib/` change needs a DSH restart.

### B. From the GUI plugin market

Open the plugin market in DSH → add plugin → paste the **absolute path of this repository**
(not a `.tgz`; the market takes directories, and this repo no longer produces tarballs).

Full steps, profile traps and rollback: [INSTALL.md](INSTALL.md).

### Verify

```bash
curl -s http://127.0.0.1:<dsh-port>/rotation/api/health
# {"ok":true,"name":"dsh-looptree-dashboard","version":"0.13.3","base":"/rotation",...}
```

Then open `http://127.0.0.1:<dsh-port>/rotation/app/`, or click **轮转里程碑树** in the left sidebar.
If `health` 404s the host half is not mounted — see [INSTALL.md](INSTALL.md).

## Usage

Three steps, once per day:

1. **Read the lanes.** A milestone expands into its supports; execution records show running / done /
   failed with the session result. Milestones waiting for review are amber, and execution records never fold.
2. **Close what is closed.** Support records close themselves once every record is done; the milestone
   enters **待确认达成** and only a click on **确认达成** writes `closed_at`, snapshots it into the milestone
   history and keeps the project in the main lane. The gate is **at least one support child + every child
   closed**; a milestone that never spawned a support keeps its button greyed out.
3. **Push the next step.** Fill a support's **core metric + approach** (or press **Generate 2 items**),
   then **Generate plan**; only after the plan is written can you **Execute plan**. Every node has a prompt
   template; **发起** previews the prompt, then starts a real DSH session in that project's `workspace`.

The panel writes back on every edit; the toolbar shows `已写入 <file> · <time>`.

## Data model

```
~/.dsh/rotation/registry.json          project registry: [{ id, name, workspace, file }]
~/.dsh/rotation/candidates/            candidate pools: <card>__<node id>.json (runtime data, not in project git)
<workspace>/.dsh/rotation.json         the card itself (rotation/v1, travels with the project)

project (the card's `project` block)
└── vision            ≤ 1000 chars: what this project should become

milestone (one per card)
├── vision            3–6 sentences, ≤ 1000 chars
├── metrics[]         2–5 milestone core metrics: the observable result that proves the vision
├── supports[]        3–5 important supports: what must exist for the vision to hold (importance order)
├── children[]        support items (kind: support, depth 2)
│   ├── support       the support entry it carries — copied verbatim (read-only, ≤ 80 chars)
│   ├── necessity     why it helps the milestone (read-only, ≤ 200 chars)
│   ├── causal        doing X → which step of the milestone becomes true (read-only, ≤ 200 chars)
│   ├── metric        this support's core metric: how far it must go to hold the milestone up
│   ├── approach      the implementation approach
│   ├── plan          plan book, written by Generate plan
│   └── children[]    execution records (kind: exec, depth 3+): one DSH session each
└── closed_milestones[]    ≤ 10 snapshots, written on 确认达成
```

A candidate row reveals a hover card (support / necessity / causal / evidence / importance); adopting
writes only the read-only trio into the card, and the core metric + approach are filled with
**Generate 2 items**.

The registry is shared between machines (`~/.dsh` syncs through git) while `workspace` is a path that
only exists on one machine. Entries whose workspace is missing here are treated as another machine's
registrations: they are hidden, they do not reserve ids, and they are preserved verbatim on write.

Card fields, invariants and the panel mapping: [rotation-card-spec.md](rotation-card-spec.md).

## HTTP API

Both halves are mounted under `/rotation` (override with `basePath`). All endpoints return JSON;
writes are validated first and rejected with `422` before anything touches disk, then written
atomically (`tmp` + rename, no `.bak` — git is the history).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/rotation/api/health` | version + resolved paths |
| `GET` `POST` | `/rotation/api/projects` | list / register a project (`{name, workspace, provider?, model?}`) |
| `DELETE` | `/rotation/api/projects/<id>` | unregister (the project's card file is kept) |
| `GET` `PUT` | `/rotation/api/cards` · `/rotation/api/cards/<id>` | read / validated write of card files |
| `GET` | `/rotation/api/prompts?file=&nodeId=` | composed prompt + summary + lint warnings |
| `POST` | `/rotation/api/action/plan` · `exec` · `reflect` | run a node action in a DSH session |
| `POST` `GET` | `/rotation/api/run` · `/rotation/api/runs` · `/rotation/api/run/cancel` · `/rotation/api/run-config` | node sessions and the concurrency cap |
| `GET` `PUT` | `/rotation/api/services` | read / write the service list of a card |
| `POST` | `/rotation/api/service/start` · `/rotation/api/service/stop` | one-click start / stop |
| `POST` | `/rotation/api/services/probe` · `/rotation/api/services/collect` | probe a service / AI discovery (draft → preview → write-back) |
| `GET` | `/rotation/api/services/collect?file=` | the pending service draft for a card |
| `GET` | `/rotation/api/services/all` | every project's services, ports and conflicts (`?probe=0` skips probing) |
| `POST` | `/rotation/api/services/start-all` | start all offline services; `409` + conflicts means nothing was started |
| `POST` | `/rotation/api/services/stop-all` | kill listeners on the configured loopback ports; remote hosts are reported as skipped |

The panel also calls a few UI-only endpoints (`/rotation/api/sessions`, `/session`, `/workspaces`,
`/pick-directory`, `/candidates/*`, `/fill`, `/splits`); they are not a stable contract — read
`lib/index.js` if you are building on them.

## Configuration

**Plugin options** (`cordis.patch.yml` / profile patch layer):

| Option | Default | Meaning |
|---|---|---|
| `basePath` | `/rotation` | route prefix; change it if another plugin claims `/rotation` |
| `provider` / `model` | GUI selection | pin node sessions to a provider route instead of the GUI default |

**Environment:** `ROTATION_MAX_CONCURRENT` (default `3`) caps concurrent sessions across actions,
runs and service collection.

**Services** are per card, and every command field accepts either a string or a per-platform map:

```json
"services": [
  { "id": "panel", "name": "Panel :4173", "url": "http://127.0.0.1:4173", "health": "/api/run-config",
    "start": { "mac": "node serve.mjs", "windows": "node serve.mjs" } },
  { "id": "preview", "name": "Preview :5800", "url": "http://127.0.0.1:5800",
    "start": { "mac": "python3 -m http.server 5800", "windows": "python -m http.server 5800" },
    "cwd": "/tmp/rt-workspace" }
]
```

Platform keys: `mac` (also `darwin` / `macos`), `windows` (also `win32` / `win`), `linux`, `default`.
When the current platform has no command, **Start** is hidden and the block says why.

**Prompt overrides** live in the card: `prompts.<type>` at card level, or `prompts[]` on a node.
Precedence is node → card → built-in, and the detail card labels the source.

## Security & boundaries

Nothing leaves the machine except the model calls that DSH already routes.

- The panel is served by DSH's own web server and answers on the loopback interface only.
- There is **no authentication**. The host sets `access-control-allow-origin: *` and accepts an
  `x-rotation-token` header whose value is `in-process` — it is a routing convention, not a secret.
  Any local page can therefore read and write cards while DSH is running. Do not bind DSH to a
  public interface while this plugin is installed.
- **Start service executes a shell command taken from the card file.** Treat a `rotation.json` you did
  not write as executable code: the panel always shows platform, command and `cwd` before spawning,
  and the process runs in its own group so it can be stopped.
- Node sessions run in-process through `ctx.agents`, so they inherit the GUI's credentials and provider
  routing — the plugin never stores a key.
- Data stays in two places: the project's `.dsh/rotation.json` and `~/.dsh/rotation/`. Uninstalling the
  plugin removes neither.

## Known limitations

- The panel has no session list or conversation history; the exec record links to a session id, not to
  a transcript.
- The listener is loopback-only and unauthenticated by design (see above).
- UI copy is Chinese-only for now; the data model and API are language-neutral.
- Markdown in prompts is plain text on purpose — DSH chat bubbles do not render it.
- Candidate pools are runtime data under `~/.dsh/rotation/candidates/` and are not synced through the
  project's git: candidates do not follow you to another machine, only adopted support items do.
- Stop all locates listeners by port: on Windows it uses `Get-NetTCPConnection` then `netstat` /
  `taskkill`, on macOS it needs `lsof` (bundled with the OS), on Linux it falls back to `ss` /
  `netstat`. Services whose URL is not a loopback address (`localhost`, `127.0.0.0/8`, `::1`) are
  reported as skipped and never killed — a configured `https://example.com` must not take down
  whatever listens on the local `:443`.

## Development

```bash
npm run dev            # fake host, no DSH needed → http://127.0.0.1:4180/rotation/app/
npm run preflight      # lint:plugin → client contract → session state machine → samples → packaging
npm run check          # against a running DSH: health / panel / registry
```

Individual suites: `npm run lint:plugin`, `mock:client`, `mock:session`, `mock:action`, `mock:prompt`,
`mock:candidates`, `mock:genbtn`, `mock:closure`, `mock:registry`, `mock:services`, `mock:services-batch`,
`mock:stale-run`, `validate:samples`. Migration for older cards: `npm run migrate:supports` — folds goals
and ideas into support items and renames blockers to important supports; dry-run by default, `--write`
persists and writes `<card>.supports-backup.json`. Cards older than 0.13 need `migrate`, `migrate:single-idea`,
`migrate:blockers`, `migrate:milestone` first (also dry-run by default).

Architecture, event flow and directory map: [docs/architecture.md](docs/architecture.md).

## Documentation

| Document | Read it when |
|---|---|
| [INSTALL.md](INSTALL.md) | installing, updating, verifying, rolling back, troubleshooting |
| [rotation-card-spec.md](rotation-card-spec.md) | writing or migrating a `rotation/v1` card by hand |
| [docs/architecture.md](docs/architecture.md) | changing the host/client halves or the session runner |
| [docs/prompts.md](docs/prompts.md) | changing prompt structure, overrides or lint rules |
| [docs/execution-records.md](docs/execution-records.md) | reading the plan / exec / reflect record format |
| [docs/dev-setup.md](docs/dev-setup.md) | setting up a machine to develop the plugin |
| [CHANGELOG.md](CHANGELOG.md) | checking what changed between versions |
| [docs/devlog.md](docs/devlog.md) | the historical log behind the current design |

## Contributing

This is a personal tool that happens to be public. Issues and bug reports are welcome — include the
`/rotation/api/health` output and the console error. For anything larger than a bug fix, open an issue
first so the data model does not fork; if you would rather not wait, fork it, the MIT license allows it.

## License

[MIT](LICENSE) © 2026 jrri
