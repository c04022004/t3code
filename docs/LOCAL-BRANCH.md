<!--
README for the local branch feat/local-meter-and-tool-rows — local-only
customizations on top of t3code v0.0.42. This branch mixes three kinds of
commits, and only one kind is upstreamed:

  1. meter fixes (3 commits)  → submitted upstream as PR #13659
  2. UI features (4 commits)  → local-only, may become upstream PRs later
  3. local-only patches (5+)  → NEVER upstream, see "Local-only features"

Upstream PRs from this branch must cherry-pick individual commits — never
merge the branch — or the local-only patches would leak.
-->

# Local branch: `feat/local-meter-and-tool-rows`

Local customizations on top of t3code **v0.0.42** (base `719a76ca1d`). The
branch carries three distinct groups of work; only the meter fixes are headed
upstream.

| Group                        | Commits | Destination                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------------- |
| Context-meter fixes          | 3       | Upstream PR [#13659](https://github.com/pingdotgg/t3code/pull/13659) |
| History import & UI features | 9       | Local; import features may be proposed upstream later                |
| Local-only patches           | 1 (MCP) | **Never upstream**                                                   |

## Running the standalone release

A bundled, self-contained release is staged at
`/mnt/models/t3-releases/t3-0.0.40-features-<commit>/` and runs against a data
directory under `/mnt/models/t3-data` (not your `~/.t3-dev`):

```sh
node /mnt/models/t3-releases/t3-0.0.40-features-3113d2d2b6/bin.mjs start \
  --port 5733 --host 0.0.0.0 --base-dir /mnt/models/t3-data --no-browser
```

Pairing URL is printed on startup and mirrored to `/tmp/t3-pairing-url.txt`.
The release `node_modules/` holds the native addons (fff-node, ffi-rs,
node-pty) copied from the previous release — do not delete it.

> Note: the release reads fresh event-sourced state from
> `/mnt/models/t3-data`. Replaying the same bundle over an older
> `~/.t3-dev` data directory can fail to decode persisted events (e.g.
> `role: "reasoning"`) — use a fresh base dir when in doubt.

To cut a new release after committing changes:

```sh
# from ~/t3code
./node_modules/.bin/vp run --filter t3 --filter='@t3tools/web...' build

REL=/mnt/models/t3-releases/t3-0.0.40-features-<new-commit>
mkdir -p "$REL"
cp apps/server/dist/bin.mjs "$REL/bin.mjs"
cp apps/server/dist/*.mjs "$REL/"          # worker bundles
cp -r apps/server/dist/client "$REL/client"
cp -rL /mnt/models/t3-releases/t3-0.0.40-features-<prev>/node_modules "$REL/node_modules"
```

then start it in a tmux window (`tmux new-window -t 0 -a -n t3-release "…"`,
kill the old server PID first).

## Group 1 — context-meter fixes (upstream, PR #13659)

The context-window meter showed multiples of the real context size (2×–5×,
red clamp at "full") on any backend where assistant frames lack usage or any
turn spanning multiple model round-trips. The meter must only ever consume
**per-request usage evidence**; four code paths fed it turn-wide totals
instead, and all four now route to `totalProcessedTokens`:

- `cebad8ec28` — stop inflating the Claude context-window meter
- `7dcfc590e2` — keep multi-round-trip result usage out of the meter
- `7df2b02fff` — test coverage for aggregate-result meter edge cases

Details and the reproduction rig: `docs/pr-draft.md`.

## Group 2 — history import & UI features

### Claude/Codex history import (per-session picker)

t3 already shipped a bulk importer (onboarding "welcome wizard"); this branch
extends it with three pieces:

1. **Per-session picker** (`9bda02f452`) — Project settings → Agent history
   → "Pick sessions…" opens a dialog listing every Claude Code / Codex
   transcript for the project's workspace root: search, filter tabs
   (new / outdated / imported) with counts, recency groups, and import
   exactly the checked sessions. Old sessions outside the 30-day bulk window
   are pickable here.

2. **Sync outdated imports** (`44f0eb9dae`) — sessions whose transcript file
   changed on disk since import show as "outdated" (badge + filter). One
   smart **Sync N selected** button imports new ones _and_ replaces outdated
   threads with the fresh transcript (`mode: "auto"` server default). Replays
   are guarded: a thread you've chatted in since the import is never
   clobbered — the server refuses with `AgentSessionThreadModifiedError` and
   the session is reported as skipped.

3. **Per-thread context-menu sync** (`ff63a1fac7`, `3113d2d2b6`) — imported
   threads get a **"Bring history up to date"** item in the sidebar
   right-click menu and the chat-header thread menu. Staleness is resolved
   at menu-open via a new `agentSessions.threadSync` RPC (stat-only compare
   of the recorded transcript identity — no reparse):
   - transcript changed → enabled, clicking replaces the thread history
   - transcript unchanged → greyed out as "History up to date"
   - not an imported thread → item hidden entirely

### Other UI features

- `1056f5b97a` — setting: expand all tool call rows
- `55cb0e3cfd` — tool call contents open inside expanded groups
- `35735ae10d` — settled turns stay unfolded under expand-all
- `c1bae2b3b0` — cache hit % shown in the context window popover

## Group 3 — local-only patches (never upstream)

- `3d9fdac529` — the t3-code MCP server is never attached to provider
  sessions: no credential is issued, so agents see none of the t3 tools
  (pull-request linking, `preview_*`, `device_*`). The browser/device access
  settings exist but have no effect while this patch is in place; reverting
  the `prepareMcpSession` early return restores all three toolkits together.

## Gotchas for future work on this branch

- **Settle state is organizational, not content.** Every `thread.history.import`
  ends by emitting `thread.settled` (backdated to the transcript's last
  message), so imported threads always arrive settled — and un-settling one
  (re-opening it) must not wedge later syncs. The sync guard
  `hasImportBlockingActivity` ignores the settle group for already-imported
  threads; it still blocks on real user content (turns, chat messages,
  activities, pins…). Fixed in `3113d2d2b6` — don't reintroduce.
- **Sync failures must not report success.** `importAgentSessionsById`
  swallows per-session errors and reports them as `skippedCount`; the UI
  surfaces a skip of a requested session as an error toast, never as
  "History already up to date".
- **Replacement path**: imported history refresh = `thread.delete` →
  `thread.create` → `thread.history.import` on the _same_ thread id.
  Soft-delete + re-create is the supported route; every projector resets its
  rows on `thread.created`.
- **Upstream hygiene**: PR #13659 must contain only the 3 meter commits.
  Cherry-pick, don't merge, and never push the local-only patches.
- **Typecheck baselines** (pre-existing, not yours to fix): server 0 clean,
  web 0 clean in recent runs (historically 4 known errors in
  `MessagesTimeline.logic.ts` + `vite.config.ts`; counts have shifted across
  dependency updates — compare counts against the last run, not a fixed
  number).
- **Test suites to keep green**: `AgentSessionImporter.test.ts` (17),
  `threadActionMenu.logic.test.ts` (12).
