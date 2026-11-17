# Preview.1 release provenance

The proposed installable asset is `opencode-v1-bridge-0.82.0-preview.1.tgz`. Its companion `SHA256SUMS.txt` authenticates the archive. The package inventory records a SHA-256 for each shipped file. GitHub-generated source archives serve a separate purpose.

## Source identity

The reviewed bridge candidate is based on public source commit `f53a11493d3b351630e2cd555bc537138046393c` with the verified 2.3.0 worktree changes. Its frozen 77-file input inventory has aggregate SHA-256 `3E1546154D9E615DB59AE22897AAF4B653A1BF7654E0B6CABC66C6E9E8FF01A3`. Preview.1 keeps all 71 JavaScript and declaration files byte-identical to those inputs. Packaging changes cover the preview version, package description and document allowlist, and the preview documentation. MIT licensing and upstream notices are unchanged.

The 2.3.0 source-contract review used the released OpenCode source commit `a6b15d33daf6ab7d35569f6d711fdb630b9f04e7`. The retained 2.0.27 path was checked against archived source. The package contains no OpenCode binary, V1 plugin, external npm dependency, or native test fixture. The target plugin supplies its own separately provisioned dependencies.

## Evidence boundary

- **Preview.1:** 444 portable Node tests, 81 focused tests in each of the standalone Bun 1.4.2 and 1.4.3 environments, four source-backed host-contract tests, and syntax and declaration checks. The 2.3.0 host bundles Bun 1.4.4. Actual scheduler and database acceptance on 2.3.0 and the native 2.0.27 candidate regression remain open.
- **Historical beta.4:** The published archive at SHA-256 `D8B934B6E9BC4654F3DA2241C93572A696B78D563871AA04CBD665C8ECBEE254` passed the scoped native `setMood` scheduler witness on stock 2.0.27. [Published beta.4](https://github.com/Stiix72/opencode-v1-v2-bridge/releases/tag/v0.82.0-beta.4)
- **Windows custody control:** R10 ran one harmless probe and verified suspended creation, resume, lease-driven stdin closure, natural exit and owned cleanup. Its private Job recorded two total entries instead of one and the control failed. It ran no OpenCode.

See the [README](README.md), [Security](SECURITY.md), and [Remaining Issues](Remaining%20Issues.md) for test scope and limitations.
