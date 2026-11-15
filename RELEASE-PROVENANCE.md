# Beta.4 release provenance

The installable asset is `opencode-v1-bridge-0.82.0-beta.4.tgz` (121,204 bytes). The SHA-256 recorded in the companion `SHA256SUMS.txt` is:

```text
d8b934b6e9bc4654f3da2241c93572a696b78d563871aa04cbd665c8ecbee254
```

The release tag `v0.82.0-beta.4` identifies the audited source snapshot with all 77 package members byte-identical to the installable asset, including the 71 shipped JavaScript and declaration files. It descends from approved source commit `93a38fd8a1b5087e25894c81b9865e8ca70e46b7`. The package was checked offline with Node 24.20.0 and npm 11.19.0. GitHub’s generated source archives are separate from the npm tarball and include test files.

The default branch updates the README and Remaining Issues after the tarball was frozen. Runtime and declaration bytes are unchanged. This document and the security guidance are outside the archive allowlist. Use the current documentation if the archived README still describes private staging or pending native acceptance.

Native acceptance covers the original Personality 1.2.0 scheduler workflow on stock OpenCode 2.0.27. The unchanged tool ran once, returned the expected successful result to the next scripted request, and the server exited naturally. See the [README](README.md), [Remaining Issues](Remaining%20Issues.md) and [Security](SECURITY.md) for scope and limitations.
