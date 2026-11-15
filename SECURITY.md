# Security and trust boundaries

Beta.4 loads explicitly configured V1 plugins with the OpenCode process’s access. Use trusted plugins, dependencies, project files and native OpenCode clients. Keep credentials and unrelated data outside the test project. Verify the release asset checksum before installing.

## Supported beta environment

The tested workflow uses one local owner and one isolated Windows project on stock OpenCode 2.0.27. Use a dedicated, password-protected instance bound to `127.0.0.1`, with only trusted clients. Do not expose, share, proxy or tunnel its listener. Loopback controls where connections arrive. It supplies no per-project authentication.

## Experimental command output

The bridge registers command-output RPC only when the owner explicitly supplies `targets[].commands`. Keep that option absent when the target can run without a V1 command hook. A plugin that declares the hook may require the option to activate. If you need it, use the dedicated local environment above and keep sensitive data out of command output.

Selection IDs and receipts correlate the command, session, location and consumer. The generic host RPC authenticates server access. It supplies no independently authenticated caller session, project principal or TUI identity to the receipt handler. The host event stream can deliver the output and selection fields to other authenticated subscribers. Treat all clients of the instance as equally trusted. Do not rely on this feature for confidentiality or caller authorization across clients, projects or accounts. Workspace-scoped confirmed output is refused, and native authenticated caller ownership remains unverified. The package has no public TUI companion entrypoint.

Use the current [README](README.md) and [Remaining Issues](Remaining%20Issues.md) alongside the frozen tarball. The archived README predates the final native evidence and this deployment guidance.

## Reporting security problems

Send the repository owner a private report with the exact host, bridge and plugin versions, the deployment topology and the impact. Share minimal redacted evidence. Keep credentials, session data and working exploit details out of public issues.
