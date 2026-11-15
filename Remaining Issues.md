# Remaining Issues

## OpenCode V1 Bridge: missing functionality, limitations, and opportunities to contribute

OpenCode V1 Bridge is a **server-first compatibility adapter** intended to run supported, unchanged OpenCode V1 plugins on **stock OpenCode V2.0.27**. It is functional, but it does **not** reproduce the entire V1 plugin environment. Some features are implemented only in experimental development candidates; others lack full native-host acceptance; and some cannot be reproduced faithfully using the public interfaces available in V2.0.27.

This document explains the principal known gaps, why they exist, and approaches contributors might investigate. It is **not** a claim that every V1 API has been individually implemented or exhaustively tested. The public [README](README.md) should remain the authority for which features are actually supported in a particular release.

The initial release scope is server-first. Experimental work is outside the supported server-first workflow. Where `0.82.0-beta.4` exposes an experimental option, this document identifies it explicitly. The exact beta.4 archive passed a scoped native scheduler test on stock OpenCode 2.0.27. The unchanged Personality `setMood` ran once, persisted the expected output and project state, and delivered the result to the next scripted request. That acceptance was server-only. The separate command-output and TUI findings remain open.

### How to read the status labels

- **Bridge-solvable / integration work:** A plausible adapter-side implementation or test improvement exists; no change to OpenCode itself has yet been shown to be necessary.
- **Host-contract limitation:** V2.0.27 does not expose enough information, ordering, or authority through its public plugin API for a faithful V1 translation. A documented, opt-in subset may still be possible.
- **Experimental / excluded:** Development code or offline evidence exists, but the feature is not part of the supported server-first beta.
- **Verification gap:** Functionality is implemented or partially tested, but a particular native-host scenario has not been accepted.

A similarly named V2 hook is **not automatically equivalent** to its V1 counterpart. Unsupported operations should fail explicitly rather than silently appear to succeed while changing a plugin's meaning or security guarantees.

---

## 1. V1 `config` — mutable host configuration

**Status:** Host-contract limitation; possible subset implementation.  
**Estimated difficulty:** Medium to high, depending on which mutations are needed.

**What V1 provided.** A plugin could receive and change a mutable host configuration during initialization. Potential changes included commands, tools, provider options, permissions, and other settings.

**Why this is missing.** V2.0.27 exposes more specialized mechanisms, but not a proven public phase equivalent to V1's complete mutable configuration hook. Treating a V2 configuration-related interface as a drop-in replacement would risk accepting changes that never take effect.

**Ideas worth investigating:**

- Translate individual, well-understood V1 configuration changes into supported V2 transforms.
- Provide an explicitly documented subset, with clear rejection of unsupported mutations.
- Propose a new public host hook if V2 cannot expose a needed configuration phase safely.
- Study authentic plugins to find the most commonly used configuration properties before deciding implementation priority.

**Specific plugin finding:** In the authenticated `opencode-command-hooks@0.8.0` V1 implementation, its `config` callback only logs; its event and tool handlers load the plugin's own configuration. That narrows what this particular callback needs, but the bridge still does not accept the unsupported hook, and the plugin independently requires `chat.params`.

## 2. V1 `chat.params` — effective model-request parameters

**Status:** Host-contract limitation for faithful translation.  
**Estimated difficulty:** High for full compatibility; potentially medium for a carefully bounded subset.

**What V1 provided.** A callback received the selected model, runtime provider, originating user message, and request options with applicable defaults already merged. V1 awaited callbacks in order and carried their mutations into request preparation.

**Why this is missing.** V2.0.27's writable `session.context` hook supplies a different set of inputs and an **override draft**, not the same effective request options. Deleting a key or setting it to `undefined` in the V2 override does not necessarily remove an inherited default. The exact V1 model, provider, and originating-message inputs are also not all available through that public hook.

**Illustrative distinction:**

```js
// V1: remove an option from the effective parameters.
delete options.customSetting;

// V2 override draft: removing the override may restore a default.
delete event.options.customSetting;
```

A bridge that invoked V1 callbacks but discarded or reinterpreted their mutations would offer misleading compatibility.

**Ideas worth investigating:**

- Implement an opt-in subset only for mutations whose effects are demonstrably equivalent.
- Investigate supported provider-specific request transformation facilities.
- Propose a public V2 hook exposing authoritative, final effective request parameters and the requisite model/message context.
- Reassess the contract on later host versions without claiming they are supported by the V2.0.27 release.

This is a potentially high-impact area for plugins that customize model requests.

## 3. V1 `session.deleted` — safe deletion events

**Status:** Host-contract **and ownership** limitation.  
**Estimated difficulty:** Medium with additional authoritative host data; very high as a faithful bridge-only workaround.

**What V1 provided.** The deletion event included the full session record captured as removal began.

**Why this is missing.** V2.0.27 emits a `sessionID` after deletion. By then, the public read API cannot recover the deleted record. Caching creation-time metadata is not a safe substitute: the host can move a session into a different project without that ownership change necessarily reaching the bridge. A stale snapshot could disclose information from another project. Faithful delivery also requires identifying the deleted session’s incarnation and the complete record at removal.

**Ideas worth investigating:**

- Have the host publish the authenticated pre-deletion session record.
- Expose an ownership/revision token that proves cached metadata is still valid.
- Add a verified pre-deletion callback or other supported, ownership-safe API.
- Provide narrowly scoped internal state retirement without presenting it as full V1 `session.deleted` compatibility.

**Security requirement:** Do not synthesize a deletion event from stale ownership information merely because the session ID matches.

## 4. V1 `client.session.messages` — historical session transcripts

**Status:** Host-contract limitation.  
**Estimated difficulty:** High for full historical fidelity.

**What V1 provided.** Plugins could retrieve past messages, parts, and associated historical metadata. This supports transcript analysis, token tracking, conversation-dependent automation, and other features.

**Why this is missing.** The V2.0.27 public history representation does not preserve all required V1 fields, including some original part IDs, user agent/model information, and assistant parent relationships. Server authentication alone cannot authorize a particular plugin target to read a session. The public result supplies no owner or revision proof for the requested history. A faithful projection needs target-level ownership, stable pagination and completeness guarantees.

**Ideas worth investigating:**

- A full-fidelity, ownership-checked public history API.
- A versioned host-provided projection retaining V1-required fields and pagination/completeness semantics.
- A deliberately reduced read-only subset for consumers that do not require those fields.
- Investigation of whether later supported host contracts improve transcript access.

**Correctness requirement:** Do not invent missing historical values or silently treat an incomplete history as complete.

## 5. Full V1 permission authorization

**Status:** Security-sensitive compatibility limitation.  
**Estimated difficulty:** High.

**What V1 provided.** Plugins could participate in permission decisions, potentially allowing, denying, or requesting approval for operations.

**What the bridge has.** Beta.4 exposes the experimental, per-target `pendingPermissionObserver` option. It reports selected already-pending native requests and has no authority to approve or deny them. The standard server profile leaves V1 `ToolContext.ask` unavailable. Native tool permissions still apply.

**Why this is missing.** A faithful translation needs verified request identity, ownership, decision ordering, and an authoritative V2 permission-decision interface. The v2.0.27 public predecision callback lacks the authoritative request identity. The pending request becomes visible afterward and may settle independently, so a later lookup cannot supply the missing predecision correlation.

**Ideas worth investigating:**

- Map only provably equivalent V1 decisions through supported V2 evaluation hooks.
- Require exact authorization-request identity and deterministic lifecycle correlation.
- Keep observational callbacks read-only when decision authority is unavailable.
- Propose additional public host context where needed.

**Security requirement:** Never treat an observer notification as permission to authorize an operation. This area would particularly benefit from experienced security reviewers.

## 6. Confirmed command output ownership and workspace routing

**Status:** Opt-in experimental delivery with a host routing and caller-ownership limitation.  
**Estimated difficulty:** Likely medium if workspace-aware host routing becomes available.

**Implemented mechanism.** Declaring `targets[].commands` explicitly enables confirmed command output. The bridge selects a consumer, correlates its receipt, and refuses the command before the legacy hook runs when consumer readiness cannot be established. An earlier beta.2 server-only run recorded pre-entry no-consumer behavior. Beta.4’s after-disconnect NO-CONSUMER acceptance and authenticated caller ownership (Witness B) remain open.

**What is missing.** Workspace-scoped confirmed delivery cannot safely route a receipt to the required workspace using V2.0.27's public HTTP RPC mechanism. The public location query selects by directory and carries no workspace selector, including when two workspaces share a directory. Those requests fail before hook execution. The stock host authenticates access to the server and uses a caller-supplied directory for RPC routing. It supplies no independent originating session, project principal, or TUI identity to the receipt handler. The host event stream can expose output to other authenticated subscribers. Selection IDs provide correlation, expiry and replay handling within a trusted environment. They do not establish confidentiality or authenticated acknowledgment across clients.

**Deployment boundary.** Keep command output disabled where possible. If a target requires explicit command registration, use a dedicated password-protected loopback instance for one trusted project and trusted clients. Do not enable it on shared or remotely reachable servers, including proxied or tunneled loopback listeners. Avoid sensitive command output. The shipped package has no public TUI companion entrypoint. [Security and trust boundaries](SECURITY.md)

**Ideas worth investigating:**

- A public workspace-aware RPC route.
- A host-supported workspace-targeted receipt mechanism.
- Another authenticated routing design with equivalent project/workspace isolation.

The existing fail-closed behavior must remain until an alternative meets those safeguards.

## 7. `client.tui.showToast` — experimental toast support

**Status:** Implemented experimentally; **not exposed by the beta.4 server-first package**.  
**Estimated difficulty:** Medium; meaningful implementation work already exists.

An isolated development candidate provides per-target opt-in toast handling with consumer leases and correlated acknowledgments. It successfully executed the unchanged `opencode-personality@1.2.0` `savePersonality` tool **offline**, including one project-local JSON write, one accepted receipt through a controlled presentation port, and the original successful result.

**Still needed:**

- Genuine-host acceptance involving an authorized presentation consumer.
- More lifecycle, disconnection, and shutdown evidence. The native missing-toast-consumer check remains open and is independent of command-output `NO-CONSUMER`.
- A decision about what UI-facing behavior should belong in a supported release.

**Important partial-success hazard:** The original `savePersonality` implementation writes its JSON **before** awaiting the toast. If delivery fails after the write, the persistent state has changed even though the tool can return an error. The bridge does not provide automatic rollback. Do not blindly retry state-changing operations after a presentation failure.

An offline receipt proves controlled-consumer acceptance, not necessarily that text was visibly painted in a real TUI.

## 8. Other legacy TUI functionality and Windows shutdown

**Status:** Incomplete and partly unverified; outside the initial server-first release scope.  
**Estimated difficulty:** Medium to high.

The bridge does not yet provide a complete historical V1 TUI compatibility layer. Individual TUI client methods should be inventoried and classified rather than all being described as identically impossible.

Historical Windows ConPTY runs recorded **`EPIPE`** in the native TUI’s exit-epilogue stdout write. The failure also reproduced in a bridge-free native control. The first operation that invalidated the stdout destination remains unresolved. The separate beta.2 **server-only** native witness exited naturally without EPIPE.

**Ideas worth investigating:**

- A genuine V2 TUI companion implementing supported presentation/RPC operations.
- Additional method-level UI adapters with explicit consumer requirements.
- Source-backed diagnosis of the Windows stdout/ConPTY shutdown path.
- Independent tests for TUI-specific teardown that do not affect server-only execution.

Developers experienced with terminal interfaces, Windows process lifecycles, and RPC are especially welcome.

## 9. Broader V1 client SDK coverage

**Status:** Partial implementation; many methods unavailable.  
**Estimated difficulty:** Highly variable by method.

The currently described public server entrypoint offers **reduced forms of four V1 client operations**:

- `client.vcs.get` — current Git branch when available.
- `client.tool.ids` — effective tool registry identifiers.
- `client.app.agents` — an empty native agent list within the documented reduction.
- `client.app.log` — acknowledged stderr logging under its explicit logging profile.

The **other 79 known V1 client methods** are unavailable through this entrypoint, including historical session, prompt, provider, authentication, shell/PTY, and TUI operations. This is a substantial compatibility gap: successful plugin activation does not imply broad V1 client SDK coverage.

Some methods may have straightforward public V2 equivalents. Others need fields, authorization, or semantics V2.0.27 does not expose.

**A useful contribution pattern:** Choose one method, document the exact V1 contract, identify the supported V2 interface, state any semantic reduction, and add positive/negative tests. Classify each method as **supported**, **reduced**, **unsupported**, or **not yet verified**.

### Request-local tool aliases and CodeMode

Canonical registered tools support legacy before/after hooks in the direct-tool scope. A request can remap an invocation name to a different tool. The v2.0.27 public before-hook lacks the resolved canonical target at the point when a legacy hook must inspect or modify the arguments. The registered-tool inventory cannot supply that request-local identity. CodeMode is a distinct experimental execution route. Contributors can investigate a public resolved-target field that preserves hook order, native permissions, and coexistence with V2 plugins.

---

## 10. Work that exists but still needs verification

These items should not be mistaken for completely missing implementations or for fully accepted behavior.

### Command output after consumer disconnection

Offline work corrected a defect where multiple companions could display the same output or an unselected companion could acknowledge it after the chosen one disconnected. Consumer identity now follows readiness, publication, and receipt, with duplicate suppression and explicit failure classification. The separate historical native **`NO-CONSUMER`** command was withheld after the TUI shutdown EPIPE. It was designed to observe a post-entry receipt deadline. The later beta.2 server-only check verified pre-entry refusal with no eligible consumer. Offline tests also exercise failure when a previously selected consumer disconnects after admission. The historical native negative remains unexecuted. Once a legacy hook has executed, delivery failure must never trigger an automatic replay.

### Restricted `client.mcp.status`

The internal restricted adapter supports settled `connected` and `disabled` states. A separate internal profile can also project `failed` with its error. Pending and authentication-required states fail explicitly. The beta.4 public server entrypoint does not expose the method. MCP service initialization can establish connections even if the method eventually reads only a status snapshot. No confirmed authentic plugin consumer has been identified in the reviewed set. This is a possible future addition rather than a demonstrated initial-release blocker.

### Final artifact scheduler acceptance

The genuine beta.1 host witness successfully selected and ran the unchanged Personality `setMood` tool. The beta.2 host witness recorded loading, session creation, command refusal, and shutdown. Its frozen verdict remains **FAIL** on the database watermark check. A separate supplemental re-audit passed after identifying the auditor’s SQLite row-prototype comparison defect. The final licensed package still requires genuine scheduler acceptance against the **exact package bytes intended for distribution**. This is a release-qualification task, not a missing V1 API.

---

## Suggested contribution priorities

These are provisional priorities based on likely compatibility value, **not** a measured ranking of how many real plugins each change would unlock.

| Priority | Area | Potential benefit |
| --- | --- | --- |
| High | `chat.params` | Request-parameter customization for legacy plugins |
| High | Carefully bounded `config` support | Configuration-dependent plugins and hooks |
| High | Individual V1 client methods | Incremental, testable compatibility improvements |
| High | Full session history | Transcript-dependent and analysis plugins |
| Medium | Permission compatibility | More faithful hooks, with strict security requirements |
| Medium | `session.deleted` | Lifecycle cleanup with authenticated ownership |
| Medium | Toast and TUI | Expands beyond server-only use; experimental code exists |
| Medium | Workspace-aware confirmed output | Safe delivery in workspace contexts |
| Lower initially | `client.mcp.status` | Potential support for a future verified consumer |

Priorities should change in response to reproducible reports from users of **authentic, unmodified V1 plugins**. A single heavily used hook may be more valuable than numerous rarely used SDK methods.

## How to contribute

See [Contributing](CONTRIBUTING.md) for repository and test guidance. Help is welcome in two complementary areas:

1. **Bridge-side contributions:** Implement supported translations, expand method coverage, improve regression tests, strengthen isolation, and test real legacy plugins.
2. **Upstream-facing investigations:** Identify missing V2 host information or public hooks, prepare minimal reproductions, and propose supported interfaces that would make faithful V1 compatibility possible.

For a proposed change, please include:

- The V1 hook, method, or behavior in question and the plugin/version that uses it.
- The relevant V2.0.27 public API behavior and the exact mismatch.
- A concrete suggested approach, including any deliberate reduction in semantics.
- How the change handles errors, ownership, concurrency, and authorization where relevant.
- A focused regression or reproducible example, plus a statement of whether it was tested **offline** or in the **genuine OpenCode host**.

For bug reports, include the OpenCode version, bridge version, plugin name and version, operating system, expected and actual behavior, and a minimal **redacted** configuration. Never post API keys, personal conversations, private databases, or credential-bearing logs.

Ideas and alternative designs are welcome even without a finished patch. **The goal is useful, honestly documented compatibility—not inflated method counts or silent approximations that make plugins behave incorrectly.**
