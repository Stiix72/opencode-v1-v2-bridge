# Contributing to OpenCode V1 Bridge

Bug reports, compatibility reports, small fixes, documentation, research, and alternative designs are welcome. Working examples from unchanged V1 plugins are as useful as failures when they identify the exact workflow and versions.

## Start with the public source

Use a fresh checkout and Node 24 for the verified development baseline. The adapter has no runtime dependencies and no transpilation step. Run the JavaScript syntax and portable test checks from the repository root.

```text
npm run build
npm test
```

Run `npm run typecheck` with TypeScript 5.9.3 available as `tsc`. Node 20 is the package’s minimum install requirement. The development tests for native ESM resolution use a current Node release with `node:module.registerHooks`. The tests run offline with synthetic inputs and controlled adapters. You can contribute without a private fixture or a model provider.

## Propose a change

1. Describe the plugin or use case and the version-specific compatibility problem. Check [Remaining Issues](Remaining%20Issues.md) for adjacent work.
2. For a compatibility change, show the historical V1 contract, the OpenCode 2.0.27 public contract, and how the translation will behave. Identify fields, timing, errors, or ordering the proposed mapping cannot preserve.
3. Add focused tests with synthetic or redistributable inputs. Mark evidence as source inspection, offline execution, or native OpenCode observation. Include exact versions and describe what ran.
4. For permissions, client transports, disposal, or cross-project access, show that failures stay explicit and that unrelated projects, sessions, and plugins retain their existing isolation and permissions.
5. Keep a patch small enough to review. Alternative approaches and constructive disagreement are welcome. Explain which tradeoffs your proposal changes.

## Report a problem

Provide the exact bridge, host and plugin versions, platform, a minimal redacted configuration, steps, expected and actual behavior, and the smallest relevant diagnostics. State whether the result came from a native host or an offline check. Share code or logs only when you have permission. Remove credentials, private paths, transcripts, and personal or project data.

For a potential security vulnerability, use the repository’s private vulnerability reporting option if available. If private reporting is unavailable, avoid posting sensitive details publicly.
