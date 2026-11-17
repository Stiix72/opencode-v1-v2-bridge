# OpenCode V1 Bridge

OpenCode V1 Bridge lets stock OpenCode load explicitly configured V1 plugins through its server-plugin interface. The bridge translates supported V1 tools, hooks, and client calls into native V2 operations. If a plugin uses those interfaces, you can try it unchanged before deciding whether to port it.

> **Experimental preview · offline verified only.** `0.82.0-preview.1` targets stock OpenCode **2.3.0** and retains an exact **2.0.27** entrypoint. This preview has yet to pass genuine-host acceptance on either version. Use it in a disposable, trusted-local project.

## Host versions and evidence

| Version and package | Evidence |
| --- | --- |
| OpenCode 2.3.0 with preview.1 | Primary preview target. Offline bridge tests and released-source contract checks passed. Actual OpenCode scheduler, database, cancellation, and shutdown acceptance remain open. |
| OpenCode 2.0.27 with preview.1 | Retained compatibility target. Offline bridge tests and archived-source tool checks passed. The current candidate’s native regression remains open. |
| OpenCode 2.0.27 with historical beta.4 | The separately published beta.4 package passed a scoped native scheduler witness with one unchanged V1 tool. See [third-party compatibility evidence](#tested-with-unchanged-v1-plugins). |

Use **direct tool exposure** with 2.3.0. Its scheduler can expose eligible CodeMode tools directly when the `execute` gateway is denied. The public Promise plugin interface cannot require that gateway per request, so the bridge refuses the experimental CodeMode profile on 2.3.0 before loading a legacy target. The experimental CodeMode option on 2.0.27 retains separate semantics and falls outside the server-first preview profile.

## Install and configure on Windows

1. Save `opencode-v1-bridge-0.82.0-preview.1.tgz` and its companion `SHA256SUMS.txt` together. The PowerShell example below verifies the checksum and installs into a new local directory. GitHub’s generated source archives serve a different purpose. The [historical beta.4 release](https://github.com/Stiix72/opencode-v1-v2-bridge/releases/tag/v0.82.0-beta.4) has its own tarball and checksum.
2. For isolated installation, use Node 20 or later. The offline packaging and installation checks used Node 24.20.0 and npm 11.19.0. OpenCode supplies its own plugin runtime. The bridge has no external npm dependencies and is marked `private: true` to prevent accidental npm publication. Provision the trusted V1 plugin and its dependencies separately.

Use a dedicated, password-protected OpenCode instance bound to `127.0.0.1`, with one trusted project and trusted clients. Keep the server off shared, proxied, tunneled and remotely reachable listeners. Read [Security and trust boundaries](SECURITY.md) before enabling compatibility commands.

```powershell
$archiveName = 'opencode-v1-bridge-0.82.0-preview.1.tgz'
$archive = (Resolve-Path -LiteralPath (Join-Path (Get-Location).Path $archiveName)).Path
$checksum = (Get-Content -Raw -LiteralPath '.\SHA256SUMS.txt').Trim()
$pattern = '^([0-9A-Fa-f]{64})  ' + [regex]::Escape($archiveName) + '$'
if ($checksum -notmatch $pattern) { throw 'The checksum file must identify the preview tarball.' }
$expected = $Matches[1]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) {
  throw 'Bridge archive SHA-256 mismatch.'
}
$adapterHome = Join-Path (Get-Location).Path 'opencode-bridge-local'
New-Item -ItemType Directory -Path $adapterHome -ErrorAction Stop | Out-Null
Push-Location -LiteralPath $adapterHome
try {
  npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false --no-save "$archive"
  if ($LASTEXITCODE -ne 0) { throw 'Bridge installation failed.' }
} finally {
  Pop-Location
}
```

3. In the disposable project’s `opencode.json`, add one bridge entry to `plugins`. Replace both example paths. Point `package` to the installed **bridge package directory**. Put the V1 plugin only in the bridge’s `targets` list. Leave your normal profile and installation out of this workflow.

```json
{
  "plugins": [
    {
      "package": "C:/example/opencode-bridge-local/node_modules/opencode-v1-bridge",
      "options": {
        "version": 1,
        "toolExposure": "direct",
        "targets": [
          {
            "id": "my-legacy-plugin",
            "module": "./legacy/my-plugin/dist/index.js"
          }
        ]
      }
    }
  ]
}
```

Each target needs a unique `id` and a `module`. A relative `package` path starts at the configuration file. A relative target entry starts at the activation directory and must stay inside the worktree. An explicit absolute entry file or unqualified local file URL can identify a trusted target elsewhere. Bare package names and exported subpaths use the nearest installed package within the worktree and the native ESM import resolver. Require-only exports are unsupported. For standalone Node use, bare resolution needs `node:module.registerHooks`. Use an explicit file entry with older Node versions. The loader uses the runtime’s module cache and executes trusted plugin code with the host account’s access. Provision dependencies before loading a target. When using Bun, disable runtime auto-install for this workflow.

### Optional profiles

Add these keys under the bridge entry’s `options` only when the plugin needs them.

| Option | Behavior |
| --- | --- |
| `clientOptions: {"responseStyle":"data","throwOnError":true}` | Selects the reduced client contract. |
| `logging: "stderr"` | Adds acknowledged legacy logging. Requires the data/throw client options. `body.extra` is unsupported. |
| `system: "session-text"` | Enables session-scoped system text transformation. |
| `events: "terminal-assistant"` | Selects the reduced creation and terminal assistant `message.updated` event subset. |
| `events: "session-lifecycle"` | An alternative profile for `session.idle` after success, or `session.error` followed by `session.idle` for the supported `UnknownError` projection. Set `sessionCreated: true` on a target with an event hook to receive eligible titled creation events for that project and directory outside workspace-scoped routing. |
| `metadata: "live-json"` | Publishes supported JSON tool metadata as native progress. The historical durable metadata lifecycle and independent title behavior are unavailable. |
| `targets[].commands` | Explicit, experimental opt-in for a target with `command.execute.before`. Trust the entire local server and all its clients. Leave it disabled for targets that work without it. The stock package exposes the producer only. An eligible consumer is required before the hook runs. |

## Implemented server features

- **Plugin activation.** Load trusted V1 entry files, installed packages, or exported package subpaths. Provide per-plugin JSON factory options when needed. Declared `dispose` hooks participate in activation cleanup.
- **Direct legacy tools.** Register supported argument schemas under the original tool names and keep the plugin’s argument parser and executor. Canonical registered tools support before-hook argument changes and supported after-hook result changes. OpenCode owns tool selection, authorization, and scheduling.
- **System text and events.** Opt into session-scoped system text transformation or one of the reduced event profiles below.
- **Reduced client operations.** `client.vcs.get` returns the current Git branch when one is available. `client.tool.ids` returns effective registry IDs. `client.app.agents` can represent an empty native list. Explicit stderr logging adds `client.app.log`.

## Compatibility limits

| Area | Preview scope |
| --- | --- |
| V1 client | The four operations above have reduced contracts. The other 79 known V1 methods are unavailable through this entrypoint, including `client.command.list`, `client.event.subscribe`, `client.session.messages`, session prompting, and provider, auth, shell/PTY, and TUI operations. |
| Hooks | `config`, `chat.params`, `chat.headers`, and auth hooks are unsupported. Unsupported declared hooks can cause activation to fail. |
| Tools | The preview scope is direct tools with admitted schemas and canonical names. The 2.3.0 entrypoint refuses CodeMode. The 2.0.27 experimental CodeMode route has different scheduling and hook semantics. |
| Permissions | The standard server profile does not supply V1 `ToolContext.ask`. The experimental, opt-in pending-permission observer reports certain already-pending native requests. It has no authority to make or change a decision. |
| Events and UI | Session deletion, historical event replay, per-delta parity, and end-to-end TUI command output are outside the supported server-first workflow. The public preview entrypoint does not supply `client.tui.showToast`. |

## How the host shapes compatibility

- **Tool identity.** OpenCode can rename or remap tools for an individual request. The public before-hook gets the invocation name without the request’s resolved target. Before-hooks are supported for canonical registered tools. A plugin that relies on before-hooks to enforce policy must avoid request-local aliases.
- **Client responses.** The public Promise plugin context supplies location and scoped services. The reduced client methods return data and throw errors. V1 HTTP envelopes, arbitrary cancellation forwarding, `PluginInput.serverUrl`, and the V1 Bun shell helper are unavailable. The native agent list cannot supply the required V1 fields for nonempty results.
- **Prompt and event data.** The session text profile exposes the session ID and mutable system text. V1 `input.model` rejects on access because the host exposes a narrower model reference. Event profiles project only the supported native lifecycle and message data for the owned location.
- **Delivery.** Logging acknowledges completion of the individual stderr write. Durable logging requires a sink that verifies persistence. Confirmed command output needs a selected compatible UI consumer and matching receipt. The receipt correlates acceptance on a cooperative UI path. The stock RPC endpoint does not authenticate an originating session, project principal, or TUI identity. The host event feed can expose the output to other authenticated subscribers. Workspace-scoped confirmed output is refused. Physical terminal painting and authenticated ownership require separate evidence.

## Tested with unchanged V1 plugins

The plugins listed here are independent third-party projects used to test compatibility. Each is developed and distributed separately by its own maintainers. The results identify the exact earlier release or offline scope that produced them.

| Plugin | Evidence |
| --- | --- |
| `opencode-personality@1.2.0` | The exact beta.4 tarball passed one scheduler-selected original `setMood` call on stock OpenCode 2.0.27 using two scripted local responses. The run verified the project JSON update, one acknowledged stderr log, a durable successful tool result, its delivery to the second request, and natural shutdown. The test used no provider inference or TUI. |
| `opencode-yaml-hooks@2026.3.29` | Native beta.2 loaded the original package with an action-free configuration. A separate probe in that run received the native creation callback. Beta.3 exercised the original plugin’s selected lifecycle callbacks offline using the installed bridge. Configured shell, command, and prompt actions remain unverified. |
| `@mohak34/opencode-notifier@0.1.11` | Evaluated offline. The reduced event and pending-permission profiles cover only part of the original plugin’s needs. Native activation, desktop notifications, and sound remain unverified. |

The Personality `setMood` test used an active project personality with known moods in `.opencode/personality.json`, with mood drift and toast disabled. The tool received `{"mood":"angry","duration":"permanent"}` and returned `Mood changed to angry`. The fixture listed `mood` and `personality` as command names for activation. The scheduler test invoked only `setMood`.

In project scope, the original `savePersonality` writes `.opencode/personality.json` before calling the unsupported `client.tui.showToast` method. An error can leave the file changed.

The frozen beta.2 server-only run recorded an audit failure. A separate re-audit traced it to the comparison of a SQLite row’s object prototype and verified the recorded observation without changing the original verdict.

## Known issues and troubleshooting

- Historical Windows ConPTY runs hit EPIPE during the host's terminal exit write. The cause of the broken stdout destination remains unresolved. Server-only shutdown passed in the earlier scoped native checks. Command-output refusal with no consumer at entry was observed on beta.2. Native command-output caller ownership, the distinct after-disconnect NO-CONSUMER case, and the separate missing-toast-consumer test remain open.
- A legacy plugin factory that never settles can leave activation pending and block later plugins. The disposal timeout does not bound factory initialization.
- The 2.3.0 adapter observes the native abort signal, rejects new progress or a successful result after cancellation, and ignores first-token telemetry when projecting legacy events. It cannot undo side effects or forcibly stop a non-cooperative plugin.
- A state-changing tool can finish its write before result publication or delivery fails. Check persisted state before retrying a failed command or tool.
- For activation errors, check the host version, installed bridge directory, target entrypoint and dependencies, and selected profiles. Read the nested activation error. To disable the bridge, remove its entry from `plugins` and let OpenCode dispose the activation.

## Verification and package provenance

Preview.1 was checked offline with Node, standalone Bun, declaration checks, and four source-backed host-contract tests. The tests support the exact implemented boundaries. Native 2.3.0 scheduler/database acceptance and the new 2.0.27 regression remain open. A separate Windows custody control verified probe creation and cleanup but failed its cumulative Job count. That control ran no OpenCode and provides no compatibility evidence.

See [Release provenance](RELEASE-PROVENANCE.md) for the inspected source and package identities, and [Remaining Issues](Remaining%20Issues.md) for the compatibility gaps.

## Work from source

From a development source checkout, use Node 24 for the verified workflow. The installable tarball excludes the development test scripts. The ESM JavaScript in `server.js` and `src/` is the implementation used by OpenCode. The checked-in declarations describe its public API. There is no compilation step and no runtime package to download.

```text
npm run build
npm test
```

The build command checks the executable source without generating output. To check the declarations, make TypeScript 5.9.3 available as `tsc` and run `npm run typecheck`. The portable tests use Node built-ins, synthetic plugin modules, and controlled adapters. See [Contributing](CONTRIBUTING.md) for scope and development guidance.

## Contributing and reporting problems

Contributions and alternative designs are welcome. You can help even if you have just one small plugin or failing workflow to share.

- **Extend V1 API coverage.** Pick a client method or hook and show the original V1 contract, the public V2 interface it could use, and a small regression that checks results and errors.
- **Investigate V2 host limits.** If you know the V2 architecture, help trace tool identity, event data, result publication, or UI delivery. A minimal reproduction or an alternative design using public host APIs is welcome.
- **Report a real plugin.** Working and failing reports both help. Include the exact plugin, bridge, and OpenCode versions, OS, a minimal redacted configuration, what you tried, and what happened. Say whether your evidence comes from a real OpenCode session or an offline test. Keep credentials, personal paths, and private databases out of reports.

## License

The bridge contributions of **Sir Fancybritches Fizzlebottom (Stiix72)** are distributed under [MIT](LICENSE). Development was AI-assisted. OpenCode-derived material retains its upstream MIT terms and copyright notice in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). OpenCode and the example V1 plugins are separate projects.
