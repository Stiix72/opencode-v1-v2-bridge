# OpenCode V1 Bridge

OpenCode V1 Bridge lets stock OpenCode **2.0.27** load explicitly configured V1 plugins through its server-plugin interface. The bridge translates supported V1 tools, hooks, and client calls into native V2 operations. If a plugin uses those interfaces, you can try it unchanged before deciding whether to port it.

**Beta status.** Version `0.82.0-beta.4` is a server-first beta for stock OpenCode **2.0.27**. Verification has focused on Windows. The exact beta.4 package passed a genuine-host scheduler test with an unchanged V1 plugin. See the [compatibility evidence](#tested-with-unchanged-v1-plugins) for the test scope and [Remaining Issues](Remaining%20Issues.md) for unsupported behavior and ways to help.

## Install and configure on Windows

Use stock OpenCode **2.0.27**. Download `opencode-v1-bridge-0.82.0-beta.4.tgz` and `SHA256SUMS.txt` from the [beta.4 release assets](https://github.com/Stiix72/opencode-v1-v2-bridge/releases/tag/v0.82.0-beta.4). The GitHub-generated source archives serve a different purpose. For a local source checkout, put its absolute directory in the configuration’s `package` field and skip the tarball steps.

The archive declares Node 20 or later. The Windows installation was tested with Node 24.20.0 and npm 11.19.0. OpenCode supplies its own plugin runtime, so this workflow needs no separate Bun install. The bridge has no external npm dependencies. Install the trusted V1 plugin and its dependencies separately. The package’s `private: true` setting prevents npm publication and permits installation from the local archive.

Use a dedicated password-protected OpenCode server bound to `127.0.0.1` for one trusted project and trusted clients. Keep compatibility commands out of shared servers, proxies, tunnels, and remotely reachable listeners. See [Security and trust boundaries](SECURITY.md) before enabling `targets[].commands`.

1. Save both release assets in the same directory. The script below verifies the published checksum before installing.
2. Install the verified tarball into a new disposable directory. Run the script from the directory containing the two assets. Change the destination if it already exists.

```powershell
$archive = (Resolve-Path -LiteralPath '.\opencode-v1-bridge-0.82.0-beta.4.tgz').Path
$checksum = Get-Content -Raw -LiteralPath '.\SHA256SUMS.txt'
if ($checksum.Trim() -notmatch '^([0-9A-Fa-f]{64})  opencode-v1-bridge-0\.82\.0-beta\.4\.tgz$') {
  throw 'The checksum file must identify the beta.4 tarball.'
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $Matches[1]) {
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

3. In the disposable project’s `opencode.json`, add one bridge entry to `plugins`. Replace both example paths. Point `package` to the installed **bridge package directory**. Put the V1 plugin only in the bridge’s `targets` list.

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

## What works

- **Plugin activation.** Load trusted V1 entry files, installed packages, or exported package subpaths. Provide per-plugin JSON factory options when needed. Declared `dispose` hooks participate in activation cleanup.
- **Direct legacy tools.** Register supported argument schemas under the original tool names and keep the plugin’s argument parser and executor. Canonical registered tools support before-hook argument changes and supported after-hook result changes. OpenCode owns tool selection, authorization, and scheduling.
- **System text and events.** Opt into session-scoped system text transformation or one of the reduced event profiles below.
- **Reduced client operations.** `client.vcs.get` returns the current Git branch when one is available. `client.tool.ids` returns effective registry IDs. `client.app.agents` can represent an empty native list. Explicit stderr logging adds `client.app.log`.

## Compatibility limits

| Area | Beta scope |
| --- | --- |
| V1 client | The four operations above have reduced contracts. The other 79 known V1 methods are unavailable through this entrypoint, including `client.command.list`, `client.event.subscribe`, `client.session.messages`, session prompting, and provider, auth, shell/PTY, and TUI operations. |
| Hooks | `config`, `chat.params`, `chat.headers`, and auth hooks are unsupported. Unsupported declared hooks can cause activation to fail. |
| Tools | The beta scope is direct tools with admitted schemas and canonical names. CodeMode is an experimental route with different scheduling and hook semantics. |
| Permissions | The standard server profile does not supply V1 `ToolContext.ask`. The experimental, opt-in pending-permission observer reports certain already-pending native requests. It has no authority to make or change a decision. |
| Events and UI | Session deletion, historical event replay, per-delta parity, and end-to-end TUI command output are outside the supported beta workflow. The experimental `client.tui.showToast` capability is excluded from beta.4. |

## How the host shapes compatibility

- **Tool identity.** OpenCode can rename or remap tools for an individual request. The public before-hook gets the invocation name without the request’s resolved target. Before-hooks are supported for canonical registered tools. A plugin that relies on before-hooks to enforce policy must avoid request-local aliases.
- **Client responses.** The public Promise plugin context supplies location and scoped services. The reduced client methods return data and throw errors. V1 HTTP envelopes, arbitrary cancellation forwarding, `PluginInput.serverUrl`, and the V1 Bun shell helper are unavailable. The native agent list cannot supply the required V1 fields for nonempty results.
- **Prompt and event data.** The session text profile exposes the session ID and mutable system text. V1 `input.model` rejects on access because the host exposes a narrower model reference. Event profiles project only the supported native lifecycle and message data for the owned location.
- **Delivery.** Logging acknowledges completion of the individual stderr write. Durable logging requires a sink that verifies persistence. Confirmed command output needs a selected compatible UI consumer and matching receipt. The receipt correlates acceptance on a cooperative UI path. The stock RPC endpoint does not authenticate an originating session, project principal, or TUI identity. The host event feed can expose the output to other authenticated subscribers. Workspace-scoped confirmed output is refused. Physical terminal painting and authenticated ownership require separate evidence.

## Tested with unchanged V1 plugins

The plugins listed here are independent third-party projects used to test compatibility. Each is developed and distributed separately by its own maintainers.

| Plugin | Evidence |
| --- | --- |
| `opencode-personality@1.2.0` | The exact beta.4 tarball passed one scheduler-selected original `setMood` call on stock OpenCode 2.0.27 using two scripted local responses. The run verified the project JSON update, one acknowledged stderr log, a durable successful tool result, its delivery to the second request, and natural shutdown. The test used no provider inference or TUI. |
| `opencode-yaml-hooks@2026.3.29` | Native beta.2 loaded the original package with an action-free configuration. A separate probe in that run received the native creation callback. Beta.3 exercised the original plugin’s selected lifecycle callbacks offline using the installed bridge. Configured shell, command, and prompt actions remain unverified. |
| `@mohak34/opencode-notifier@0.1.11` | Evaluated offline. The reduced event and pending-permission profiles cover only part of the original plugin’s needs. Native activation, desktop notifications, and sound remain unverified. |

The Personality `setMood` test used an active project personality with known moods in `.opencode/personality.json`, with mood drift and toast disabled. The tool received `{"mood":"angry","duration":"permanent"}` and returned `Mood changed to angry`. The fixture listed `mood` and `personality` as command names for activation. The scheduler test invoked only `setMood`.

In project scope, the original `savePersonality` writes `.opencode/personality.json` before calling the unsupported `client.tui.showToast` method. An error can leave the file changed.

The frozen beta.2 server-only run recorded an audit failure. A separate re-audit traced it to the comparison of a SQLite row’s object prototype and verified the recorded observation without changing the original verdict.

## Known issues and troubleshooting

- Historical Windows ConPTY runs hit `EPIPE` during the host’s terminal exit write. The cause of the broken stdout destination remains unresolved. Server-only shutdown passed in the scoped native checks. Command-output refusal with no consumer at entry was observed on beta.2. Beta.4 native command-output acceptance and the distinct after-disconnect NO-CONSUMER case remain open.
- A state-changing tool can finish its write before result publication or delivery fails. Check persisted state before retrying a failed command or tool.
- For activation errors, check the host version, installed bridge directory, target entrypoint and dependencies, and selected profiles. Read the nested activation error. To disable the bridge, remove its entry from `plugins` and let OpenCode dispose the activation.

## Release source and package

The release tag identifies the exact package inputs. This default-branch guide reflects evidence and safety guidance established after the archive was frozen. Use this guide if the bundled README still describes native acceptance as pending. See [Release provenance](RELEASE-PROVENANCE.md) for the archive identity and source relationship.

## Work from source

Use Node 24 for the verified development workflow. The ESM JavaScript in `server.js` and `src/` is the implementation used by OpenCode. The checked-in declarations describe its public API. There is no compilation step and no runtime package to download.

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
