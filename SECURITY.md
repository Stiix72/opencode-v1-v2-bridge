# Security and trust boundaries

The preview loads explicitly configured V1 plugins with the OpenCode process’s access. Use trusted plugins, dependencies, project files and native OpenCode clients. Keep credentials and unrelated data outside the test project. Verify the release asset checksum before installing.

## Trusted-local preview profile

The 2.3.0 preview and its retained 2.0.27 path have offline verification. The earlier genuine-host beta.4 witness used one local owner and one isolated Windows project on stock OpenCode 2.0.27. Use a dedicated, password-protected instance bound to `127.0.0.1`, with only trusted clients. Do not expose, share, proxy or tunnel its listener. Loopback controls where connections arrive. It supplies no per-project authentication.

## Experimental command output

The bridge registers command-output RPC only when the owner explicitly supplies `targets[].commands`. Keep that option absent when the target can run without a V1 command hook. A plugin that declares the hook may require the option to activate. If you need it, use the dedicated local environment above and keep sensitive data out of command output.

Selection IDs and receipts correlate the command, session, location and consumer. The generic host RPC authenticates server access. It supplies no independently authenticated caller session, project principal or TUI identity to the receipt handler. The host event stream can deliver the output and selection fields to other authenticated subscribers. Treat all clients of the instance as equally trusted. Do not rely on this feature for confidentiality or caller authorization across clients, projects or accounts. Workspace-scoped confirmed output is refused, and native authenticated caller ownership remains unverified. The package has no public TUI companion entrypoint.

Read the [README](README.md) and [Remaining Issues](Remaining%20Issues.md) for the exact preview scope. For native verification, use the historical evidence only with its stated version, package and test scope.

## Reporting security problems

Send the repository owner a private report with the exact host, bridge and plugin versions, the deployment topology and the impact. Share minimal redacted evidence. Keep credentials, session data and working exploit details out of public issues.
