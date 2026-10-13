# T3 Code local server protocol (installed build 0.0.44)

Source of truth: the installed server bundle `resources/server.asar` → `apps/server/dist/bin.mjs`
(extracted copy: `/tmp/t3probe/server/apps/server/dist/bin.mjs`), desktop app `app.asar`
(`t3codeCommitHash` **451afcb22d93**, 2026-09-29). Line numbers below refer to the extracted `bin.mjs`.
Contracts live in the `//#region ../../packages/contracts/src/*.ts` sections of the bundle
(`orchestration.ts` @32656, `rpc.ts` @48885, `auth.ts` @24123, `environmentHttp.ts` @35900, `server.ts` @46095).

Verified live against `http://127.0.0.1:3773` with a read-only probe (`/tmp/t3probe/probe/probe.mjs`), see §7.

> **Upstream drift warning.** `pingdotgg/t3code@main` has already moved to **orchestration protocol v2**
> (`packages/contracts/src/orchestrationV2.ts`, introduced 2026-10-02, PR #2829; nightlies are `v0.0.46-*`).
> v2 keeps the same method *names* (`orchestration.subscribeShell`, `…subscribeThread`, `…dispatchCommand`)
> but changes payload schemas and adds `getThreadProjection`, `launchThread`, `subscribeArchivedShell`,
> `searchThread(Stream)`, `getTurnItem`, `stopWorkflow`. v2 clients append `?orchestrationProtocol=2` to the WS URL.
> The installed 0.0.44 server advertises `orchestrationProtocolVersion: 1` (no query param needed).
> **Your client must read `GET /.well-known/t3/environment` → `orchestrationProtocolVersion` (absent ⇒ 1) and refuse/branch
> when it is not the version you implement.** The desktop app auto-updates, so expect v2 to arrive.
> This document describes **v1** (what is installed).

---

## 1. Transport

### 1.1 Endpoints

The server is one HTTP server (Effect `HttpRouter`), bound to `0.0.0.0:3773` here (see `server-runtime.json`:
`host`, `port`, `origin`). Because it binds `0.0.0.0` in desktop mode the auth policy is **`remote-reachable`**
(i.e. it is reachable from the LAN; every privileged route still requires a credential).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/.well-known/t3/environment` | none | `ExecutionEnvironmentDescriptor`: `environmentId`, `label`, `platform{os,arch}`, `serverVersion` ("0.0.44"), **`orchestrationProtocolVersion` (1)**, `capabilities{...}` |
| GET | `/api/auth/session` | optional | `AuthSessionState` `{authenticated, auth:{policy,bootstrapMethods,sessionMethods,sessionCookieName}, scopes?, sessionMethod?, expiresAt?}`. Unauthenticated → `authenticated:false` (200). |
| POST | `/oauth/token` | bootstrap credential in body | Exchange a one-time/bootstrap credential for a bearer access token (form-urlencoded, §2.3) |
| POST | `/api/auth/browser-session` | bootstrap credential in body | JSON `{credential}` → sets HttpOnly cookie `t3_session_<port>` (here `t3_session_3773`), returns `{authenticated:true,scopes,sessionMethod,expiresAt}` |
| POST | `/api/auth/websocket-ticket` | bearer/cookie | → `{ticket, expiresAt}` (ticket TTL 5 min) for `?wsTicket=` |
| POST | `/api/auth/pairing-token` | bearer + `access:write` | `{label?, scopes?}` → `{id, credential, label?, expiresAt}` (one-time pairing credential) |
| GET | `/api/auth/pairing-links` | `access:read` | list active pairing links (no secrets) |
| POST | `/api/auth/pairing-links/revoke` | `access:write` | `{id}` → `{revoked}` |
| GET | `/api/auth/clients` | `access:read` | `AuthClientSession[]` |
| POST | `/api/auth/clients/revoke` | `access:write` | `{sessionId}` → `{revoked}` (cannot revoke self) |
| POST | `/api/auth/clients/revoke-others` | `access:write` | → `{revokedCount}` |
| GET | `/api/orchestration/snapshot` | `orchestration:read`* | full `OrchestrationReadModel` (all projects + full threads — heavy; the stock UI does not use it) |
| GET | `/api/orchestration/shell` | `orchestration:read`* | `OrchestrationShellSnapshot` (same as first item of `subscribeShell`) |
| GET | `/api/orchestration/threads/:threadId?turnLimit=N&beforeCursor=C&reasoningMessages=true` | `orchestration:read`* | `OrchestrationThreadDetailSnapshot` — use `beforeCursor` from `page` to load older history |
| POST | `/api/orchestration/dispatch` | `orchestration:operate`* | JSON `ClientOrchestrationCommand` → `{sequence}` (HTTP twin of `orchestration.dispatchCommand`) |
| POST | `/api/pull-requests/diff` | authed | large PR diffs (kept off the socket) |
| GET | `/api/assets/<resource>/<path>` | signed URL from `assets.createUrl` | file/image bytes (Range supported) |
| POST | `/api/attachments/upload/<token>` | token from `attachments.createUploadUrl` | upload attachment bytes |
| POST | `/api/observability/v1/traces` | `orchestration:operate` | browser OTLP trace proxy (ignore) |
| POST/GET | `/api/connect/*`, `/api/t3-connect/*` | mixed | T3 Connect cloud relay (ignore) |
| GET | `/ws` | ticket / bearer / cookie | **WebSocket RPC** (§1.2) |
| GET | `*` | none | static web client (`dist/client`, `index.html` SPA fallback) |

\* scope names inferred from the `EnvironmentScopeRequiredError` handlers; the RPC equivalents are authoritative (§3).

HTTP errors are JSON tagged errors, e.g. 401
`{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential"|"invalid_credential","traceId":"…"}`,
403 `{"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"…"}`,
404 `EnvironmentResourceNotFoundError{reason:"thread_not_found"}`, 400 `EnvironmentRequestInvalidError`, 500 `EnvironmentInternalError`.

### 1.2 WebSocket RPC

* URL: `ws://127.0.0.1:3773/ws?wsTicket=<ticket>[&clientSurface=desktop|web|mobile|cli&clientAppVersion=<≤64 chars>]`
  (optional analytics params also read: `clientDeviceType`, `clientOs`, `clientWebDeployment`, `clientBrowser`,
  `connectionMethod`, `clientOsMajorVersion`, `clientDeviceModel`). `clientSurface/clientAppVersion` are stamped on
  events your commands produce (`metadata.origin`).
* Upgrade auth (`EnvironmentAuth.authenticateWebSocketUpgrade`, @65375): `wsTicket` query param if present, otherwise the
  same credential selection as HTTP: cookie `t3_session_<port>` → `Authorization: Bearer <token>` → `Authorization: DPoP <token>`.
  A Node client can therefore skip the ticket and send `Authorization: Bearer …` on the upgrade request; browsers must use the ticket (or same-origin cookie).
* Failed auth → plain HTTP 401 JSON (no upgrade). **No Origin check** on `/ws`; CORS on HTTP is `Access-Control-Allow-Origin: *`,
  methods `GET, POST, OPTIONS`, allowed headers `authorization, b3, traceparent, content-type, dpop` (no credentials mode
  unless the server runs with `--dev-url`).
* Protocol: **Effect RPC (effect 4.0.0-rc.115), `RpcSerialization.layerJson`**, one JSON value per text frame. The server
  decodes either a single object or an array of objects per frame; it sends one object per frame. Acks are **enabled**
  (`supportsAck: true`).

#### Client → server messages

```jsonc
{"_tag":"Request","id":"1","tag":"orchestration.subscribeShell","payload":{...},"headers":[]}
// id: string or number, unique per connection (stock client uses an incrementing bigint serialized as a string)
// headers: array of [name, value] pairs (may be empty). Optional extra fields traceId/spanId/sampled are ignored by this server (tracing disabled).
{"_tag":"Ack","requestId":"1"}        // REQUIRED after every Chunk of a stream before the server sends the next Chunk
{"_tag":"Interrupt","requestId":"1"}  // cancel a running request/stream
{"_tag":"Ping"}                       // → {"_tag":"Pong"}
{"_tag":"Eof"}                        // client finished sending (optional)
```

#### Server → client messages

```jsonc
{"_tag":"Chunk","requestId":"1","values":[ <item>, <item>, ... ]}   // stream RPCs only; batch of ≥1 items
{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value": <result>}}   // unary result (value omitted/undefined for Void RPCs)
{"_tag":"Exit","requestId":"1","exit":{"_tag":"Failure","cause":[ <reason>, ... ]}}
{"_tag":"Pong"}
{"_tag":"Defect","defect": ...}       // connection-level protocol error
```

`cause` reasons (observed live):

```jsonc
{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: access:read.","requiredScope":"access:read"}}
{"_tag":"Die","defect":"Unknown request tag: no.such.method"}
{"_tag":"Die","defect":"Expected string\n  at [\"query\"]"}       // payload failed schema decode
{"_tag":"Interrupt","fiberId":545779}                             // after you sent Interrupt
```

Typed errors (`Fail.error`) are Effect `TaggedError`s: always have `_tag` and usually `message`
(e.g. `OrchestrationDispatchCommandError{message, bootstrapThreadDisposition?}`, `OrchestrationGetSnapshotError{message}`).

A stream ends with an `Exit` (Success with no value on normal completion, or Failure). Subscriptions in this API never complete on their own.

---

## 2. Authentication

### 2.1 Model

* Credentials are opaque session tokens `base64url(JSON claims) + "." + HMAC-SHA256(claims, secrets/server-signing-key.bin)`
  (`SessionStore`, @58316). Claims: `{v:1, kind:"session", sid, sub, scopes, method, jkt?, iat, exp}`.
  **Verification also requires a live, non-revoked row in `state.sqlite` (auth sessions table)**, so a token cannot be minted
  just by signing with the key file — don't try; use the flows below.
* Bootstrap credentials ("pairing links"/one-time tokens, `PairingGrantStore`) are exchanged for sessions.
  One-time tokens default to a 5-minute TTL and single use; default scopes = **standard client scopes**
  `orchestration:read, orchestration:operate, terminal:operate, review:write, relay:read`.
  Administrative scopes add `access:read, access:write, relay:write`.
* Session TTL: 30 days (bearer/cookie); DPoP-bound: 1 h; WS tickets: 5 min.
* Policy here: `remote-reachable`, `bootstrapMethods: ["desktop-bootstrap","one-time-token"]`,
  `sessionMethods: ["browser-session-cookie","bearer-access-token","dpop-access-token"]`, cookie name `t3_session_3773`.

### 2.2 How the stock desktop client authenticates

1. Electron main generates a random 24-byte hex `desktopBootstrapToken` (in memory only) and spawns the backend with
   `ELECTRON_RUN_AS_NODE=1 "T3 Code (Alpha).exe" <server.asar>/apps/server/dist/bin.mjs --bootstrap-fd 3`, writing the
   `DesktopBackendBootstrap` JSON (`mode:"desktop", port, host, t3Home, desktopBootstrapToken, …`) to **fd 3**.
2. The server seeds that token as a grant (`method:"desktop-bootstrap"`, administrative scopes, **unbounded uses, 24 h**).
3. Main/renderer (`getLocalEnvironmentBootstraps` IPC exposes `{httpBaseUrl, wsBaseUrl, bootstrapToken}` to the renderer)
   exchange it at `POST /oauth/token` (label "T3 Code Desktop") → bearer token. Desktop-bootstrap exchanges **replace**
   the previous active session for that subject.
4. Renderer: `POST /api/auth/websocket-ticket` with `Authorization: Bearer …` → `ws://…/ws?wsTicket=…&clientSurface=…`.

The desktop bootstrap token is never written to disk, so a third-party client **cannot** reuse it.

### 2.3 What a third-party client on the same machine must do

**Unauthenticated connections are rejected** (verified: `/ws` and `/api/orchestration/shell` return 401 `missing_credential`;
only `/.well-known/t3/environment`, `/api/auth/session`, `/oauth/token`, `/api/auth/browser-session` and static files are public).

Recommended (verified working): mint a one-time pairing credential with the server's own CLI against the same data dir —
the CLI writes the grant into the same `state.sqlite` the running server reads — then exchange it over HTTP.

```bat
:: uses the installed server bundle via Electron-as-Node (verified: prints "t3 v0.0.44")
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\t3code\T3 Code (Alpha).exe" ^
  "%LOCALAPPDATA%\Programs\t3code\resources\server.asar\apps\server\dist\bin.mjs" ^
  auth pairing create --base-dir "%USERPROFILE%\.t3" --label "My UI" --ttl 10m --json
:: → {"id","credential","label","scopes","expiresAt"}   (system Node ≥22 + an extracted copy also works)
```

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<credential>
&subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&scope=orchestration:read orchestration:operate        (optional, space-separated, must be ⊆ grant scopes)
&client_label=My UI&client_device_type=desktop&client_os=Windows   (optional; the grant's --label wins over client_label)

→ 200 {"access_token":"…","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":2592000,"scope":"orchestration:read orchestration:operate"}
```

Persist the access token (30 days) and use `Authorization: Bearer <token>` on HTTP, then either send the same header on the
WS upgrade (Node) or fetch a `wsTicket` (browser). Re-pair when you get `auth_invalid`.

Alternatives:
* `… bin.mjs auth session issue --base-dir "%USERPROFILE%\.t3" --label "My UI" [--ttl 30d] --token-only` → a bearer token
  directly, but with **administrative** scopes (incl. `access:write`).
* In the stock UI, *Settings → Connections* creates pairing links via `POST /api/auth/pairing-token`; paste that credential.
* If your UI is served by a page on the same host, `POST /api/auth/browser-session {"credential":…}` sets the
  `t3_session_3773` HttpOnly cookie (SameSite=Lax); cookies are host-scoped, not port-scoped.
* Housekeeping: `auth session list --json` / `auth session revoke <sessionId>` (positional arg), `auth pairing list|revoke`.

Your client appears in Settings → Connections as its own session; it does **not** disturb the stock UI's session.

---

## 3. Method catalog

Scope per method is enforced before the handler runs (`RPC_REQUIRED_SCOPES`, @185331). Full machine-generated list in §8.

### 3.1 Minimal set for an alternative chat UI

| Need | Call |
|---|---|
| server/provider/model info | `server.getConfig` `{}` → `ServerConfig` (or stream `subscribeServerConfig` `{}` → `snapshot` then `providerStatuses` / `settingsUpdated` / `keybindingsUpdated`) |
| list projects + threads (live) | `orchestration.subscribeShell` `{requestCompletionMarker:true, afterSequence?}` (stream) — or one-shot `GET /api/orchestration/shell` |
| archived threads | `orchestration.getArchivedShellSnapshot` `{}` (shell stream excludes archived threads) |
| read a thread (live) | `orchestration.subscribeThread` `{threadId, reasoningMessages:true, requestCompletionMarker:true, turnLimit?, afterSequence?}` (stream) |
| older history pages | `GET /api/orchestration/threads/:id?turnLimit=N&beforeCursor=<page.beforeCursor>&reasoningMessages=true` |
| create thread | `orchestration.dispatchCommand` `thread.create`, or `thread.turn.start` with `bootstrap.createThread` (create + first message atomically; this is what the stock "new thread" composer does) |
| send message / start turn | `dispatchCommand` `thread.turn.start` |
| interrupt turn | `dispatchCommand` `thread.turn.interrupt` (`turnId` optional = current) |
| stop provider session | `dispatchCommand` `thread.session.stop` |
| approve / deny tool use | `dispatchCommand` `thread.approval.respond` |
| answer agent question | `dispatchCommand` `thread.user-input.respond` / `thread.user-input.dismiss` |
| rename / change model / archive | `thread.meta.update`, `thread.archive`, `thread.unarchive`, `thread.delete` |
| diffs | `orchestration.getTurnDiff` `{threadId, fromTurnCount, toTurnCount, ignoreWhitespace?}` → `{threadId, fromTurnCount, toTurnCount, diff}`; `orchestration.getFullThreadDiff` `{threadId, toTurnCount}` |
| search | `orchestration.searchThreads` `{query (2–200 chars), limit? 1–50}` → `{matches:[{threadId,projectId,source,snippet,messageCreatedAt}]}` |
| liveness check | `server.probe` `{}` → `{}` |

Read methods need `orchestration:read`; `dispatchCommand` needs `orchestration:operate`.

### 3.2 `orchestration.dispatchCommand` (payload = `ClientOrchestrationCommand`, result `{sequence}`)

Every command has `type`, a client-generated unique `commandId` (stock client: UUID v4), and almost all have
`createdAt` (ISO string). Commands are **idempotent by `commandId`** (command receipts): resending an accepted command
returns its original `sequence`; reusing an id for a different aggregate fails. IDs (`ThreadId`, `ProjectId`, `MessageId`,
`CommandId`, `TurnId`, `ApprovalRequestId`) are branded trimmed non-empty strings — generate UUIDs.

Shared types:
* `ModelSelection` = `{instanceId: string /*provider instance slug, e.g. "codex","claudeAgent"*/, model: string /*model slug*/, options?: [{id, value: string|boolean}] }`
  (legacy `{provider, model}` and `options` as an object are still accepted). Available instances/models: `ServerConfig.providers[]`
  (`instanceId, driver, enabled, installed, status, models[{slug, name, isDefault?, capabilities:{optionDescriptors?:[{id,label,type:"select"|"boolean",options?:[{id,label,isDefault?}],currentValue?}]}}]`).
  Live here: `codex` (8 models), `claudeAgent` (13 models) enabled; `cursor`, `grok`, `opencode`, `antigravity` disabled.
* `RuntimeMode` = `"approval-required" | "auto-accept-edits" | "auto" | "full-access"` (default `full-access`).
  Use `approval-required` if you want approval prompts.
* `ProviderInteractionMode` = `"default" | "plan"`.
* `ProviderApprovalDecision` = `"accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"`.
* `ChatAttachment` (persisted) = `{type:"image", id, name, mimeType, sizeBytes, source?}` | `{type:"file", id, name, mimeType, sizeBytes, source?}`;
  client may instead send `UploadChatImageAttachment` `{type:"image", id?, name, mimeType, sizeBytes ≤10 MiB, dataUrl}` inline in `thread.turn.start`,
  or upload first via `attachments.createUploadUrl` + `POST /api/attachments/upload/<token>`. Limits: 100 attachments, 120 000 input chars, 80 MiB images total.

Client commands (v1):

```ts
{type:"project.create", commandId, projectId, title, workspaceRoot, createWorkspaceRootIfMissing?, defaultModelSelection?: ModelSelection|null, createdAt}
{type:"project.meta.update", commandId, projectId, title?, workspaceRoot?, defaultModelSelection?, defaultThreadEnvMode?: "local"|"worktree"|null, autoPull?, faviconPath?, projectIcon?, scripts?}
{type:"project.delete", commandId, projectId, force?}
{type:"thread.create", commandId, threadId, projectId, title, modelSelection, runtimeMode, interactionMode?, branch: string|null, worktreePath: string|null, createdAt, historyImport?: true}
{type:"thread.delete"|"thread.archive"|"thread.unarchive"|"thread.settle"|"thread.unpin", commandId, threadId}
{type:"thread.unsettle"|"thread.unsnooze", commandId, threadId, reason:"user"}
{type:"thread.snooze", commandId, threadId, snoozedUntil}
{type:"thread.pin", commandId, threadId, orderKey?}
{type:"thread.pin.reorder"|"thread.active.reorder", commandId, threadId, orderKey}
{type:"thread.auto-settle.set", commandId, threadId, enabled}
{type:"thread.meta.update", commandId, threadId, title? | regenerateTitle?: true, modelSelection?, branch?, expectedBranch?, worktreePath?, linkedPullRequest?}
{type:"thread.pull-request.link", commandId, threadId, host, repository, number, url, source}
{type:"thread.pull-request.unlink", commandId, threadId, host, repository, number}
{type:"thread.runtime-mode.set", commandId, threadId, runtimeMode, createdAt}
{type:"thread.interaction-mode.set", commandId, threadId, interactionMode, createdAt}
{type:"thread.turn.start", commandId, threadId,
   message:{messageId, role:"user", text, attachments: (UploadChatImageAttachment|ChatAttachment)[], context?},
   modelSelection?, titleSeed?, runtimeMode, interactionMode,           // runtimeMode & interactionMode REQUIRED for clients
   bootstrap?: {createThread?: {projectId, title, modelSelection, runtimeMode, interactionMode, branch, worktreePath, createdAt},
                prepareWorktree?: {projectCwd, baseBranch, branch?, startFromOrigin?, requireWorktree?},
                runSetupScript?},
   sourceProposedPlan?: {threadId, planId}, createdAt}
{type:"thread.turn.interrupt", commandId, threadId, turnId?, createdAt}
{type:"thread.approval.respond", commandId, threadId, requestId, decision, createdAt}
{type:"thread.user-input.respond", commandId, threadId, requestId, answers: Record<string, unknown>, attachmentsByQuestionId?, createdAt}
{type:"thread.user-input.dismiss", commandId, threadId, requestId, createdAt}
{type:"thread.checkpoint.revert"|"thread.conversation.revert", commandId, threadId, turnCount, createdAt}
{type:"thread.session.stop", commandId, threadId, createdAt, onlyIfSettled?}
```

Approval flow: a pending request shows up as a thread activity
`{tone:"approval", kind:"approval.requested", payload:{requestId, requestKind?: "command"|"file-read"|"file-change"|"mcp-elicitation"|"permission", requestType, detail?, appName?, options?: [{decision,label,warning?}]}, turnId}`;
it is pending until a matching `kind:"approval.resolved"` (same `payload.requestId`, `payload.decision`) appears. The shell exposes
`hasPendingApprovals` / `hasPendingUserInput` per thread. Agent questions: `kind:"user-input.requested"` `payload:{requestId, questions, responseMode?}`
→ resolved by `user-input.resolved`. Failures: `provider.approval.respond.failed`, `provider.user-input.respond.failed`.

Each question carries `{id, header, question, options: [{label, description, value?}], multiSelect?, allowCustomAnswer?}`.
The question UI displays options and descriptions, supports custom answers unless explicitly disabled,
and sends `thread.user-input.respond` with answers keyed by the original question IDs. Option values
fall back to their labels; multiple selections are joined with `, `, matching the string answer format
accepted by T3 providers and `responseMode:"message"`. A normal order is a separate turn-start command.

Other activity kinds seen: `tool.started|updated|completed|progress`, `task.started|updated|progress|completed`,
`turn.plan.updated`, `context-window.updated`, `context-compaction`, `runtime.warning`, `runtime.error`, `tool.denied`.
`activity.payload` is open-ended (`Unknown`).

### 3.3 Other groups (summary)

* **server.\***: `getConfig`, `getSettings`, `updateSettings {patch}`, `refreshProviders {instanceId?, cwd?, refreshModels?}`, `updateProvider`, keybindings, diagnostics/telemetry/usage, `signalProcess`, self-update (`updateServer`, `updateServerWithProgress` stream, `commitDesktopUpdate`), `reportClientActivity`, `reportHostPowerState`, `getBackgroundPolicy`.
* **provider.\***: auth (`auth.start|respond|complete|cancel|logout|subscribe`), install (`install.start|cancel|subscribe|remove`), ChatGPT/Codex profile helpers, `consumeResetCredit`, `uploadFeedback`.
* **projects.\*** (filesystem inside a project): `listEntries`, `readFile`, `writeFile`, `searchEntries`, `searchContents`; `filesystem.browse`; `shell.openInEditor`. (Note: `projects.list/add/remove` names exist in `WS_METHODS` but are **not** in the RPC group — projects are created via `project.create` commands and listed via the shell.)
* **vcs.\* / git.\***: `subscribeVcsStatus`, `vcs.refreshStatus|pull|listRefs|createWorktree|removeWorktree|createRef|switchRef|init`, `git.runStackedAction` (stream), `git.resolvePullRequest`, `git.preparePullRequestThread`, `subscribeWorktreeSetup`, `worktreeSetup.cancel`.
* **review.\***: `getDiffPreview`, `getDiffFileContents` (scope `review:write`).
* **terminal.\*** (scope `terminal:operate`): `open {threadId?, terminalId?, cwd, worktreePath?, cols?, rows?, env?, providerInstanceId?}`, `attach` (stream), `write {…, data ≤64 KiB}`, `resize`, `clear`, `restart`, `close`; `subscribeTerminalEvents`, `subscribeTerminalMetadata`.
* **pullRequests.\***, **sourceControl.\***, **projectClone.\***/`subscribeProjectClones`, **agentSessions.scan|import**, **assets.createUrl**, **attachments.createUploadUrl|delete**, **preview.\***/`previewAutomation.*`/`subscribePreviewEvents`/`subscribeDiscoveredLocalServers`, **device.\***/`subscribeDeviceState`, **cloud.\***.
* Streams: `subscribeServerConfig`, `subscribeServerLifecycle` (`welcome`/`ready` events with `sequence`), `subscribeAuthAccess` (`access:read`), `subscribeBackgroundPolicy`, `subscribeResourceTelemetry`.

---

## 4. State model

### Fleet resource and usage reads

`server.getHostResources {}` returns `{sampledAt, cpuUtilization, cpuCount,
availableMemoryBytes, totalMemoryBytes}`. CPU is a normalized whole-host fraction (or null),
not T3 process CPU. Command polls every 10 seconds while visible
and displays RAM utilization as `(totalMemoryBytes - availableMemoryBytes) / totalMemoryBytes`,
with the same increasing-fill convention and 85%/95% color thresholds as CPU. This is not
memory pressure. The browser retains at most 120 host samples
from the last 20 minutes in browser memory, and marks disconnected, failed or >35-second-old
samples stale. Host data is separate from environment shells so samples do not rebuild map
geometry. `getResourceTelemetryHistory` is T3 process telemetry and is not used as host history.

`server.getUsageSummary {sinceDay, untilDay, timeZone}` scans native provider history. Command
supports contract versions 4–6, requests seven viewer-local calendar days once per minute
while visible, and filters the same scan for today's estimate. Daily buckets carry provider,
model, sourcePath, costUsd, unpricedRecords, cacheSavingsUsd and token totals. Sources are
deduplicated by `{hostId, provider, resolvedHomePath, volumeId}`, preferring healthy then newer
scans. Cached-input share divides cached tokens by uncached + cached + cache-creation input;
cache savings use the server estimate. Unpriced responses, missing coverage and stale scans
are disclosed. All these reads use the existing `orchestration:read` grant.

Waiting age uses the original `createdAt` of the oldest unresolved approval/question that
matches the shell's pending flags; missing timestamps remain unavailable. Turn duration uses
`latestTurn.startedAt` through now for running turns or `completedAt` for completed turns,
including waits. Background work does not extend a completed turn's timer. Crew timers share
a one-second browser clock, pause while hidden, and resynchronize immediately on visibility.

### 4.1 Event log & sequences

The server is event-sourced: every accepted command appends `OrchestrationEvent`s with a **global, monotonically
increasing `sequence`** (one counter across all projects/threads; currently ≈55 000). `dispatchCommand` returns the
`sequence` of the last event it produced. Event envelope:

```ts
{ sequence, eventId, aggregateKind: "project"|"thread", aggregateId, occurredAt, commandId|null,
  causationEventId|null, correlationId|null,
  metadata: {providerTurnId?, providerItemId?, adapterKey?, requestId?, ingestedAt?, historyImport?, deferredTurn?, origin?:{surface?, appVersion?}},
  type, payload }
```

Event types: `project.created|meta-updated|deleted`, `thread.created|deleted|archived|unarchived|settled|unsettled|snoozed|unsnoozed|pinned|unpinned|pin-reordered|auto-settle-set|meta-updated|pull-request-linked|pull-request-unlinked|pull-request-synced|runtime-mode-set|interaction-mode-set|message-sent|turn-start-requested|turn-interrupt-requested|approval-response-requested|user-input-response-requested|checkpoint-revert-requested|reverted|session-stop-requested|session-set|proposed-plan-upserted|turn-diff-completed|activity-appended`.

### 4.2 Shell (sidebar) — `orchestration.subscribeShell`

Stream items (`OrchestrationShellStreamItem`):
1. `{kind:"snapshot", snapshot:{snapshotSequence, projects: ProjectShell[], threads: ThreadShell[], updatedAt}}` — sent first unless resuming.
2. `{kind:"synchronized"}` — only if `requestCompletionMarker:true`; marks end of snapshot/catch-up.
3. Live, already-projected deltas (coalesced in 50 ms windows):
   `{kind:"project-upserted", sequence, project}`, `{kind:"project-removed", sequence, projectId}`,
   `{kind:"thread-upserted", sequence, thread}`, `{kind:"thread-removed", sequence, threadId}`.
   Upserts carry the **whole** shell object: replace by id. Ignore items with `sequence ≤` what you already applied.

`ThreadShell` = `{id, projectId, title, modelSelection, runtimeMode, interactionMode, branch, worktreePath, latestTurn{turnId,state:"running"|"interrupted"|"completed"|"error",requestedAt,startedAt,completedAt,assistantMessageId}, session{threadId,status:"idle"|"starting"|"running"|"ready"|"interrupted"|"stopped"|"error",providerName,providerInstanceId?,runtimeMode,activeTurnId,lastError,updatedAt}|null, latestUserMessageAt, hasPendingApprovals, hasPendingUserInput, hasActionableProposedPlan, backgroundLiveness?, planProgress?, createdAt, updatedAt, archivedAt, settled*/snoozed*/pinned*/order keys, pullRequests[], titleState?, titleRegeneration?}`.
`ProjectShell` = `{id, title, workspaceRoot, repositoryIdentity?, defaultModelSelection|null, defaultThreadEnvMode?, autoPull?, faviconPath?, projectIcon?, scripts[], createdAt, updatedAt}`.
Archived threads are excluded (use `getArchivedShellSnapshot`).

### 4.3 Thread detail — `orchestration.subscribeThread`

Stream items (`OrchestrationThreadStreamItem`):
1. `{kind:"snapshot", snapshot:{snapshotSequence, thread: OrchestrationThread, page?:{beforeCursor|null, hasMore, snapshotSequence, threadSequence?}}}`
   (`page` present iff you passed `turnLimit`; window = last N user-anchored turns).
2. `{kind:"synchronized"}` (if requested).
3. `{kind:"event", event: OrchestrationEvent}` — only the 6 detail types below, for this thread.

`OrchestrationThread` = ThreadShell-like metadata + `messages[]`, `activities[]`, `proposedPlans[]`, `checkpoints[]`, `session`, `deletedAt`.
`Message` = `{id, role:"user"|"assistant"|"system"|"reasoning", text, attachments?, context?, turnId|null, streaming, createdAt, updatedAt}`
(`reasoning` role only if `reasoningMessages:true`; otherwise reasoning arrives as `system`).
`Activity` = `{id, tone:"info"|"tool"|"approval"|"error", kind, summary, payload, turnId|null, sequence?, createdAt}`.
`Checkpoint` = `{turnId, checkpointTurnCount, checkpointRef, status:"ready"|"missing"|"error", files[{path,kind,additions,deletions}], assistantMessageId, completedAt}`.

Reducer (mirrors the server projector, @76195):
* `thread.message-sent` — if a message with `payload.messageId` exists: when `payload.streaming` is true **append** `payload.text`
  (it is a delta); when false, replace text with `payload.text` if non-empty (else keep); update `streaming`, `updatedAt`, `turnId`,
  `attachments`/`context` if present. Otherwise insert a new message. (Cap 2000.)
* `thread.activity-appended` — push `payload.activity` (dedupe by `id`; order by `sequence`/`createdAt`). Live `tool.updated`
  activities for the same tool call are coalesced (only latest within 50 ms is delivered).
* `thread.session-set` — replace `session`; if `status==="running"` with `activeTurnId`, set `latestTurn` running; terminal statuses settle it.
* `thread.turn-diff-completed` — upsert checkpoint by `turnId`.
* `thread.proposed-plan-upserted` — upsert `payload.proposedPlan` by `id`.
* `thread.reverted` — drop checkpoints with `checkpointTurnCount > turnCount` and messages/activities/plans of dropped turns.
Title/branch/archive changes for the open thread arrive via the **shell** stream (`thread-upserted`), not this stream.

### 4.4 Resume after reconnect

Pass `afterSequence` = highest `sequence` you applied. Shell: server replays (coalesced) events if the gap ≤ 1000, else sends a
fresh `snapshot`. Thread: replays if ≤ 1000 events and ≤ 8 MiB, else sends a snapshot (windowed if `turnLimit` given).
Always handle a `snapshot` item at any point by replacing state. When merging older HTTP pages, first make sure you have applied
live events up to `page.threadSequence`.

---

## 5. Gotchas

1. **Ack every Chunk** (`{"_tag":"Ack","requestId"}`) — the server blocks the stream until you do. Per-subscription buffer
   limit 1000 items / 8 MiB; a slow/non-acking consumer gets the stream failed with
   `OrchestrationGetSnapshotError{"message":"The live event buffer is full. Resume from the last received sequence."}` → resubscribe with `afterSequence`.
2. **Protocol version**: check `/.well-known/t3/environment` `orchestrationProtocolVersion` (installed = 1). Upstream main/nightlies are v2 (§0).
3. No Origin check on WS, permissive CORS (`*`), no rate limiting observed in the server; but no unauthenticated access either.
4. Server binds `0.0.0.0` (LAN-reachable) in this install; prefer `127.0.0.1` in your client and keep tokens private.
5. Request `id` must be a string or number; unknown tags / bad payloads come back as `Die` defects, not typed errors.
6. `runtimeMode` and `interactionMode` are **required** on client `thread.turn.start` (unlike the internal schema).
7. Commands are idempotent per `commandId` — reuse the same id when retrying after a dropped connection.
8. Dispatch is rejected while a project clone is in progress for that project.
9. `thread.archive` also stops the provider session and closes thread terminals server-side.
10. One-time pairing credentials are single-use and expire in 5 min by default; `client_label` is overridden by the grant label.
11. Void RPCs return `{"_tag":"Success"}` with no meaningful value.
12. The server emits `server.getConfig` feature flags (`threadResumeCompletionMarker`, `threadSnapshotPagination`, `reasoningMessages`, `shellResumeCompletionMarker`) — all `true` here; gate optional fields on them.

---

## 6. Wire example (send a message to an existing thread)

```jsonc
→ {"_tag":"Request","id":"7","tag":"orchestration.dispatchCommand","headers":[],"payload":{
     "type":"thread.turn.start","commandId":"6f3c…","threadId":"<threadId>",
     "message":{"messageId":"a1b2…","role":"user","text":"Hello","attachments":[]},
     "modelSelection":{"instanceId":"claudeAgent","model":"<model slug from server.getConfig>"},
     "runtimeMode":"approval-required","interactionMode":"default","createdAt":"2026-10-11T18:30:00.000Z"}}
← {"_tag":"Exit","requestId":"7","exit":{"_tag":"Success","value":{"sequence":55031}}}
// then on the thread subscription: event thread.message-sent (user), thread.session-set (running),
// thread.message-sent (assistant, streaming:true deltas…), thread.activity-appended (tool.*), …, streaming:false, session-set (ready)

→ {"_tag":"Request","id":"8","tag":"orchestration.dispatchCommand","headers":[],"payload":{
     "type":"thread.approval.respond","commandId":"…","threadId":"<threadId>","requestId":"<activity.payload.requestId>",
     "decision":"accept","createdAt":"…"}}
```
(Not executed — the probe was read-only.)

---

## 7. Probe results (read-only, 2026-10-11)

`/tmp/t3probe/probe/probe.mjs` — usage: `node probe.mjs http://127.0.0.1:3773 <pairing.json>` where `pairing.json` is the
`auth pairing create --json` output. Flow: `/oauth/token` (scope `orchestration:read`) → `/api/auth/session` →
`GET /api/orchestration/shell` → `/api/auth/websocket-ticket` → WS RPC.

* Token exchange 200 (`token_type: Bearer`, `scope: orchestration:read`, `expires_in` ≈ 30 d); session `authenticated: true`, `bearer-access-token`.
* HTTP shell: `snapshotSequence` 55019, **2 projects, 27 threads**.
* WS: `Ping`→`Pong`; `server.probe` → `Success {}`; `server.getConfig` OK (6 provider instances; codex 8 models, claudeAgent 13 models).
* `subscribeShell {requestCompletionMarker:true}` → `snapshot` + `synchronized` (2 projects / 27 threads).
* `subscribeThread {turnLimit:2, reasoningMessages:true}` on most recent thread → snapshot with `page`; 2 user / 5 assistant / 5 reasoning messages, 53 activities.
* `subscribeAuthAccess` → `Fail EnvironmentAuthorizationError` (scope), unknown tag / bad payload → `Die`; `Interrupt` → `Failure [Interrupt]`.
* Cleanup: the probe's session was revoked via `auth session revoke`; no pairing links remain; no threads/projects/settings touched.

---

## 8. Full RPC list (tag · payload schema · success schema · stream · required scope)

See `/tmp/t3probe/probe/rpcs.tsv` (generated by `extract-rpcs.mjs` from the bundle). Schema names refer to
`const <Name> = …` declarations in `bin.mjs`. Blank success = Void.

| tag | payload | success | stream | scope |
|---|---|---|---|---|
| `server.upsertKeybinding` | ServerUpsertKeybindingInput | ServerUpsertKeybindingResult |  | orchestration:operate |
| `server.removeKeybinding` | ServerRemoveKeybindingInput | ServerRemoveKeybindingResult |  | orchestration:operate |
| `server.probe` | Struct({}) | Struct({}) |  | orchestration:read |
| `server.getConfig` | Struct({}) | ServerConfig |  | orchestration:read |
| `server.refreshProviders` | Struct({ instanceId: optional(ProviderInstanceId), cwd: optional(TrimmedNonEmptyString), refreshModels: optional(Boolean) }) | ServerProviderUpdatedPayload |  | orchestration:operate |
| `server.updateProvider` | ServerProviderUpdateInput | ServerProviderUpdatedPayload |  | orchestration:operate |
| `provider.consumeResetCredit` | ProviderConsumeResetCreditInput | ProviderConsumeResetCreditResult |  | orchestration:operate |
| `provider.auth.start` | ProviderAuthStartInput | ProviderAuthState |  | orchestration:operate |
| `provider.auth.respond` | ProviderAuthRespondInput | ProviderAuthState |  | orchestration:operate |
| `provider.auth.complete` | ProviderAuthCompleteInput | ProviderAuthState |  | orchestration:operate |
| `provider.chatgpt.reconnect-profile` | ChatGptReconnectProfileInput | NullOr(ChatGptReconnectProfile) |  | orchestration:operate |
| `provider.chatgpt.import-profile` | ChatGptImportProfileInput | ProviderAuthState |  | orchestration:operate |
| `provider.chatgpt.handoff.subscribe` | ChatGptHandoffInput | ChatGptHandoffState | yes | orchestration:operate |
| `provider.codex.auth-callback.subscribe` | CodexAuthCallbackInput | CodexAuthCallbackState | yes | orchestration:operate |
| `provider.auth.cancel` | ProviderAuthCancelInput | ProviderAuthState |  | orchestration:operate |
| `provider.auth.logout` | ProviderSetupInput | ProviderAuthState |  | orchestration:operate |
| `provider.auth.subscribe` | ProviderSetupInput | ProviderAuthState | yes | orchestration:operate |
| `provider.install.start` | ProviderSetupInput | ProviderInstallState |  | orchestration:operate |
| `provider.install.cancel` | ProviderInstallCancelInput | ProviderInstallState |  | orchestration:operate |
| `provider.install.subscribe` | ProviderSetupInput | ProviderInstallState | yes | orchestration:read |
| `provider.install.remove` | ProviderSetupInput | ProviderInstallState |  | orchestration:operate |
| `server.updateServer` | ServerSelfUpdateInput | ServerSelfUpdateResult |  | orchestration:operate |
| `server.updateServerWithProgress` | ServerSelfUpdateInput | ServerSelfUpdateProgressEvent | yes | orchestration:operate |
| `server.commitDesktopUpdate` | DesktopUpdateCommitInput | ServerSelfUpdateResult |  | orchestration:operate |
| `server.getSettings` | Struct({}) | ServerSettings |  | orchestration:read |
| `server.updateSettings` | Struct({ patch: ServerSettingsPatch }) | ServerSettings |  | orchestration:operate |
| `server.discoverSourceControl` | Struct({}) | SourceControlDiscoveryResult |  | orchestration:read |
| `server.getTraceDiagnostics` | Struct({}) | ServerTraceDiagnosticsResult |  | orchestration:read |
| `server.getProcessDiagnostics` | Struct({}) | ServerProcessDiagnosticsResult |  | orchestration:read |
| `server.getHostResources` | Struct({}) | HostResourcesSnapshot |  | orchestration:read |
| `server.getProcessResourceHistory` | ServerProcessResourceHistoryInput | ServerProcessResourceHistoryResult |  | orchestration:read |
| `server.getResourceTelemetryHistory` | ResourceTelemetryHistoryInput | ResourceTelemetryHistory |  | orchestration:read |
| `server.retryResourceTelemetry` | Struct({}) | ResourceTelemetryRetryResult |  | orchestration:operate |
| `server.getUsageSummary` | UsageSummaryInput | UsageSummary |  | orchestration:read |
| `server.refreshUsageRates` | Struct({}) | UsagePricing |  | orchestration:read |
| `server.signalProcess` | ServerSignalProcessInput | ServerSignalProcessResult |  | orchestration:operate |
| `cloud.getRelayClientStatus` | Struct({}) | RelayClientStatusSchema |  | relay:read |
| `cloud.installRelayClient` | Struct({}) | RelayClientInstallProgressEventSchema | yes | relay:write |
| `server.reportClientActivity` | ClientActivityReportInput | (Void) |  | orchestration:read |
| `server.reportHostPowerState` | HostPowerSnapshot | (Void) |  | orchestration:operate |
| `server.getBackgroundPolicy` | Struct({}) | BackgroundPolicySnapshot |  | orchestration:read |
| `pullRequests.list` | PullRequestListInput | PullRequestListResult |  | orchestration:read |
| `pullRequests.listStats` | PullRequestListStatsInput | PullRequestListStatsResult |  | orchestration:read |
| `pullRequests.routing` | PullRequestRef | PullRequestRoutingResult |  | orchestration:read |
| `pullRequests.routingIdentity` | PullRequestRoutingIdentityInput | PullRequestRoutingIdentityResult |  | orchestration:read |
| `pullRequests.summary` | PullRequestRef | PullRequestSummary |  | orchestration:read |
| `pullRequests.stack` | PullRequestRef | NullOr(PullRequestStack) |  | orchestration:read |
| `pullRequests.linkedThreads` | PullRequestRef | PullRequestLinkedThreadsResult |  | orchestration:read |
| `pullRequests.detail` | PullRequestRef | PullRequestDetail |  | orchestration:read |
| `pullRequests.preview` | PullRequestRef | PullRequestPreview |  | orchestration:read |
| `pullRequests.activity` | PullRequestRef | PullRequestActivity |  | orchestration:read |
| `pullRequests.threadComments` | PullRequestThreadCommentsInput | PullRequestThreadCommentsResult |  | orchestration:read |
| `pullRequests.diffFileContents` | PullRequestDiffFileContentsInput | PullRequestDiffFileContentsResult |  | orchestration:read |
| `pullRequests.filesViewed` | PullRequestRef | PullRequestFilesViewedResult |  | orchestration:read |
| `pullRequests.setFilesViewed` | PullRequestSetFilesViewedInput | Void |  | orchestration:operate |
| `pullRequests.runAction` | PullRequestActionInput | Void |  | orchestration:operate |
| `pullRequests.update` | PullRequestUpdateInput | Void |  | orchestration:operate |
| `pullRequests.comment` | PullRequestCommentInput | Void |  | orchestration:operate |
| `pullRequests.updateComment` | PullRequestCommentUpdateInput | Void |  | orchestration:operate |
| `pullRequests.submitReview` | PullRequestSubmitReviewInput | Void |  | orchestration:operate |
| `pullRequests.replyToThread` | PullRequestThreadReplyInput | Void |  | orchestration:operate |
| `pullRequests.setThreadResolution` | PullRequestThreadResolutionInput | Void |  | orchestration:operate |
| `pullRequests.setReaction` | PullRequestReactionInput | Void |  | orchestration:operate |
| `pullRequests.invalidate` | PullRequestInvalidateInput | Void |  | orchestration:read |
| `pullRequests.subscribeRefreshes` | Struct({}) | NonNegativeInt | yes | orchestration:read |
| `pullRequests.reviewerCandidates` | PullRequestRef | PullRequestReviewerCandidateList |  | orchestration:read |
| `pullRequests.requestReviewers` | PullRequestReviewerRequestInput | Void |  | orchestration:operate |
| `pullRequests.labelCandidates` | PullRequestRef | PullRequestLabelCandidateList |  | orchestration:read |
| `pullRequests.setLabels` | PullRequestLabelChangeInput | Void |  | orchestration:operate |
| `sourceControl.lookupRepository` | SourceControlRepositoryLookupInput | SourceControlRepositoryInfo |  | orchestration:read |
| `sourceControl.cloneRepository` | SourceControlCloneRepositoryInput | SourceControlCloneRepositoryResult |  | orchestration:operate |
| `projectClone.start` | ProjectCloneStartInput | ProjectCloneStartResult |  | orchestration:operate |
| `projectClone.cancel` | ProjectCloneActionInput | ProjectCloneActionResult |  | orchestration:operate |
| `projectClone.retry` | ProjectCloneActionInput | ProjectCloneActionResult |  | orchestration:operate |
| `subscribeProjectClones` | ProjectCloneSubscribeInput | ProjectCloneListEvent | yes | orchestration:read |
| `sourceControl.publishRepository` | SourceControlPublishRepositoryInput | SourceControlPublishRepositoryResult |  | orchestration:operate |
| `projects.searchEntries` | ProjectSearchEntriesInput | ProjectSearchEntriesResult |  | orchestration:read |
| `projects.searchContents` | ProjectSearchContentsInput | ProjectSearchContentsResult |  | orchestration:read |
| `projects.listEntries` | ProjectListEntriesInput | ProjectListEntriesResult |  | orchestration:read |
| `projects.readFile` | ProjectReadFileInput | ProjectReadFileResult |  | orchestration:read |
| `projects.writeFile` | ProjectWriteFileInput | ProjectWriteFileResult |  | orchestration:operate |
| `shell.openInEditor` | LaunchEditorInput | (Void) |  | orchestration:operate |
| `filesystem.browse` | FilesystemBrowseInput | FilesystemBrowseResult |  | orchestration:read |
| `agentSessions.scan` | AgentSessionScanInput | AgentSessionScanResult |  | orchestration:read |
| `agentSessions.import` | AgentSessionImportInput | AgentSessionImportResult |  | orchestration:operate |
| `assets.createUrl` | AssetCreateUrlInput | AssetCreateUrlResult |  | orchestration:read |
| `attachments.createUploadUrl` | AttachmentCreateUploadUrlInput | AttachmentCreateUploadUrlResult |  | orchestration:operate |
| `attachments.delete` | AttachmentDeleteInput | (Void) |  | orchestration:operate |
| `provider.uploadFeedback` | ProviderUploadFeedbackInput | ProviderUploadFeedbackResult |  | orchestration:operate |
| `subscribeVcsStatus` | VcsStatusInput | VcsStatusStreamEvent | yes | orchestration:read |
| `vcs.pull` | VcsPullInput | VcsPullResult |  | orchestration:operate |
| `vcs.refreshStatus` | VcsStatusInput | VcsStatusResult |  | orchestration:read |
| `subscribeWorktreeSetup` | WorktreeSetupSubscribeInput | WorktreeSetupStreamEvent | yes | orchestration:read |
| `worktreeSetup.cancel` | WorktreeSetupCancelInput | WorktreeSetupCancelResult |  | orchestration:operate |
| `git.runStackedAction` | GitRunStackedActionInput | GitActionProgressEvent | yes | orchestration:operate |
| `git.resolvePullRequest` | GitPullRequestRefInput | GitResolvePullRequestResult |  | orchestration:operate |
| `git.preparePullRequestThread` | GitPreparePullRequestThreadInput | GitPreparePullRequestThreadResult |  | orchestration:operate |
| `vcs.listRefs` | VcsListRefsInput | VcsListRefsResult |  | orchestration:read |
| `vcs.createWorktree` | VcsCreateWorktreeInput | VcsCreateWorktreeResult |  | orchestration:operate |
| `vcs.removeWorktree` | VcsRemoveWorktreeInput | (Void) |  | orchestration:operate |
| `vcs.createRef` | VcsCreateRefInput | VcsCreateRefResult |  | orchestration:operate |
| `vcs.switchRef` | VcsSwitchRefInput | VcsSwitchRefResult |  | orchestration:operate |
| `vcs.init` | VcsInitInput | (Void) |  | orchestration:operate |
| `review.getDiffPreview` | ReviewDiffPreviewInput | ReviewDiffPreviewResult |  | review:write |
| `review.getDiffFileContents` | ReviewDiffFileContentsInput | ReviewDiffFileContentsResult |  | review:write |
| `terminal.open` | TerminalOpenInput | TerminalSessionSnapshot |  | terminal:operate |
| `terminal.attach` | TerminalAttachInput | TerminalAttachStreamEvent | yes | terminal:operate |
| `terminal.write` | TerminalWriteInput | (Void) |  | terminal:operate |
| `terminal.resize` | TerminalResizeInput | (Void) |  | terminal:operate |
| `terminal.clear` | TerminalClearInput | (Void) |  | terminal:operate |
| `terminal.restart` | TerminalRestartInput | TerminalSessionSnapshot |  | terminal:operate |
| `terminal.close` | TerminalCloseInput | (Void) |  | terminal:operate |
| `preview.open` | PreviewOpenInput | PreviewSessionSnapshot |  | orchestration:operate |
| `preview.navigate` | PreviewNavigateInput | PreviewSessionSnapshot |  | orchestration:operate |
| `preview.resize` | PreviewResizeInput | PreviewSessionSnapshot |  | orchestration:operate |
| `preview.refresh` | PreviewRefreshInput | (Void) |  | orchestration:operate |
| `preview.close` | PreviewCloseInput | (Void) |  | orchestration:operate |
| `preview.list` | PreviewListInput | PreviewListResult |  | orchestration:read |
| `preview.reportStatus` | PreviewReportStatusInput | (Void) |  | orchestration:operate |
| `previewAutomation.connect` | PreviewAutomationHost | PreviewAutomationStreamEvent | yes | orchestration:operate |
| `previewAutomation.respond` | PreviewAutomationResponse | (Void) |  | orchestration:operate |
| `previewAutomation.focusHost` | PreviewAutomationHostFocus | (Void) |  | orchestration:operate |
| `subscribePreviewEvents` | Struct({}) | PreviewEvent | yes | orchestration:read |
| `subscribeDiscoveredLocalServers` | Struct({ configuredUrls: optional(ConfiguredLocalServerUrls) }) | DiscoveredLocalServerList | yes | orchestration:read |
| `device.testHost` | SshDeviceHostConfig | DeviceHostSummary |  | orchestration:operate |
| `device.list` | DeviceListInput | DeviceServiceState |  | orchestration:read |
| `device.configure` | DeviceConfigureInput | DeviceServiceState |  | orchestration:operate |
| `device.open` | DeviceOpenInput | DeviceSession |  | orchestration:operate |
| `device.close` | DeviceCloseInput | (Void) |  | orchestration:operate |
| `device.shutdown` | DeviceShutdownInput | (Void) |  | orchestration:operate |
| `device.detail` | DeviceDetailInput | DeviceDetail |  | orchestration:read |
| `device.action` | DeviceActionInput | DeviceDetail |  | orchestration:operate |
| `subscribeDeviceState` | Struct({}) | DeviceServiceState | yes | orchestration:read |
| `orchestration.dispatchCommand` | ClientOrchestrationCommand | OrchestrationRpcSchemas.dispatchCommand.output |  | orchestration:operate |
| `orchestration.getWorkflowScript` | OrchestrationRpcSchemas.getWorkflowScript.input | OrchestrationRpcSchemas.getWorkflowScript.output |  | orchestration:read |
| `orchestration.getTurnDiff` | OrchestrationGetTurnDiffInput | OrchestrationRpcSchemas.getTurnDiff.output |  | orchestration:read |
| `orchestration.getFullThreadDiff` | OrchestrationGetFullThreadDiffInput | OrchestrationRpcSchemas.getFullThreadDiff.output |  | orchestration:read |
| `orchestration.searchThreads` | OrchestrationSearchThreadsInput | OrchestrationRpcSchemas.searchThreads.output |  | orchestration:read |
| `orchestration.getArchivedShellSnapshot` | OrchestrationRpcSchemas.getArchivedShellSnapshot.input | OrchestrationRpcSchemas.getArchivedShellSnapshot.output |  | orchestration:read |
| `orchestration.subscribeShell` | OrchestrationRpcSchemas.subscribeShell.input | OrchestrationRpcSchemas.subscribeShell.output | yes | orchestration:read |
| `orchestration.subscribeThread` | OrchestrationRpcSchemas.subscribeThread.input | OrchestrationRpcSchemas.subscribeThread.output | yes | orchestration:read |
| `subscribeTerminalEvents` | Struct({}) | TerminalEvent | yes | terminal:operate |
| `subscribeTerminalMetadata` | Struct({}) | TerminalMetadataStreamEvent | yes | terminal:operate |
| `subscribeServerConfig` | Struct({ environmentThemes: optional(Boolean), usageLimitSources: optional(Boolean), usageLimitsCommand: optional(Boolean) }) | ServerConfigStreamEvent | yes | orchestration:read |
| `subscribeServerLifecycle` | Struct({}) | ServerLifecycleStreamEvent | yes | orchestration:read |
| `subscribeAuthAccess` | Struct({}) | AuthAccessStreamEvent | yes | access:read |
| `subscribeBackgroundPolicy` | Struct({}) | BackgroundPolicySnapshot | yes | orchestration:read |
| `subscribeResourceTelemetry` | Struct({}) | ResourceTelemetrySnapshot | yes | orchestration:read |

### Mission telemetry used by Command

- **Provider status:** `subscribeServerConfig {}` → `snapshot {config}`, then `providerStatuses
  {providers}`. Each `ServerProvider` may carry `message` (health note), `usageLimits {checkedAt,
  windows[{id, kind, label, usedPercent, resetsAt?}], credentialFingerprint?, unavailable?
  {reason: "unsupported"|"probeFailed", message?}}` and `supportsConversationRollback` (absent =
  supported). Servers without the stream (the Hermes bridge) get one `server.getConfig`.
- **Turn diffs:** `orchestration.getTurnDiff {threadId, fromTurnCount: n-1, toTurnCount: n}` →
  `{diff}` (unified git diff) for one turn's checkpoint.
- **Rollback:** `thread.checkpoint.revert {turnCount}` restores files *and* conversation to just after
  that turn, dropping later turns (`thread.conversation.revert` would leave files alone). T3
  rejects it only when the provider's `supportsConversationRollback` is `false`.
- **Git status:** `vcs.refreshStatus {cwd}` (fresh `VcsStatusResult`) plus `subscribeVcsStatus {cwd}` →
  `snapshot {local, remote}` / `localUpdated` / `remoteUpdated`. `local {isRepo, refName,
  isDefaultRef, hasWorkingTreeChanges, workingTree {files[{path, insertions, deletions}], insertions,
  deletions}}`, `remote {hasUpstream, aheadCount, behindCount, pr}`. New subscribers receive the
  cached status, hence the refresh. Command subscribes only while a module panel is open.
- **Pull requests:** `ThreadShell.pullRequests[{host, repository, number, url, snapshot {state, title,
  headBranch, baseBranch, isDraft, additions?, deletions?, checksState?, reviewDecision?}}]` arrive
  with the shell.
- **Plan progress:** `ThreadShell.planProgress {step, completedSteps, totalSteps} | null` is set while a
  turn runs and cleared when it settles; T3 keeps it in memory only. The full plan is the latest
  `turn.plan.updated` activity: `payload {plan [{step, status: "pending"|"inProgress"|"completed"}],
  explanation?}`. Claude's tasks/todos, Codex plans, ACP plans and OpenCode todos all map onto it.
- **Tokens:** `context-window.updated` payload `{usedTokens, maxTokens?, totalProcessedTokens?,
  inputTokens?, cachedInputTokens?, outputTokens?, reasoningOutputTokens?, last*Tokens?, toolUses?,
  durationMs?, compactsAutomatically?}`. `usedTokens` is the context fill. `totalProcessedTokens`
  differs by provider. Codex reports a thread-wide running total (`usage.total.totalTokens`, with
  `last*` fields present), so Command subtracts the previous turn's figure. Claude reports the
  turn's own accumulated total, typically once at turn end. `context-compaction {state:
  "compacting"|"compacted", beforeTokens?, afterTokens?}` marks compactions. Snapshots don't keep a
  stable history of them (counts differ between subscriptions), so Command shows only the latest.
- **Quiet turns:** Command's own rule, not T3's. A running turn with no new activity or message
  update for 10 minutes, and no pending approval or question, is called out once. An open tool call
  or still-running background tasks are reported as such instead.

### Turn history (Command server)

`server/history-recorder.ts` opens its own `orchestration.subscribeShell` per T3 environment, using
the relay's URL and bearer token, with `clientAppVersion=t3-command-history`. It acks each chunk,
pings every 20 s, and resubscribes with backoff (5 s to 5 min). Local Hermes bridges are observed
in-process (`HermesBridge.observe`). A turn is recorded when a thread's `latestTurn` changes into
`completed`, `error` or `interrupted` while followed. The first snapshot after (re)connecting records
only turns completed after that environment's watermark (the last time it was followed). Records go
to `turn-history.jsonl` (append-only, `0600`); watermarks and coverage spans go to
`turn-history-state.json`. Both are pruned to 90 days.

`GET /api/history?days=1..90&tz=<IANA zone>` (authenticated like the rest of `/api`) returns a
`HistorySummary` (`shared/history.ts`). It includes daily outcome counts and working time, duration
median/p90/longest, top errors, project and model rankings, coverage gaps over 5 minutes, and the 25
most recent turns. Spend history is not recorded: the UI asks each T3 for `server.getUsageSummary`
over the range when the panel opens.

### Scratch work ("No project")

T3 keeps threads that belong to no project in a built-in project titled "No project" at
`<T3 home>/scratch` (`~/.t3/scratch`). `projects.ensureScratch {}` → `{projectId}` creates it
idempotently; a `thread.turn.start` bootstrap into it with `worktreePath: null` gets a dated folder
of its own inside it. t3-command recognises the project by that path (or the title), keeps it out
of project stations and seats its crew in the machine's engineering bay. The host panel's
**Set up scratch bay** calls `projects.ensureScratch`; servers without it get a plain
`project.create` at `~/.t3/scratch` with `createWorkspaceRootIfMissing`.

### Disk usage (Command server)

T3 has no disk-usage RPC, so `server/storage.ts` collects it. Every 5 minutes it checks each machine.
It finds the paths to measure from that machine's projects and thread worktrees, as last seen by the
history recorder. Machines whose URL is loopback (and local Hermes) run `df -Pk <paths>` directly.
Others get a short-lived terminal: `terminal.open {threadId: "t3-command-storage", terminalId:
"storage-<time>", cwd: <a checkout>}`, `terminal.attach`, one `terminal.write` with the command, then
`terminal.close {deleteHistory: true}` in all cases. The connection uses `clientAppVersion=t3-command-storage`
and needs the `terminal:operate` scope, which linked desktop connections have. Output is bracketed by
`__T3C_BEGIN__`/`__T3C_WT__`/`__T3C_END__` marker lines, so prompts, the echoed command and ANSI codes
are ignored. Every third sample also runs `nice -n 19 du -sk ~/.t3/worktrees/*/* ~/.t3/scratch`. Windows paths
(`C:\…`) get the PowerShell equivalent, using `PSDrive` used/free and recursive `Get-ChildItem` sums.
The latest reading and a 7-day trend of the fullest disk are kept in `storage-state.json` (`0600`).

`GET /api/storage` returns a `StorageView[]` (`shared/storage.ts`), one per environment.

## 9. Local Hermes adapter

Hermes is a separate local backend, not a T3 provider or an upstream T3 protocol extension.
`POST /api/envs` with `{ "hermes": { "workspaceRoot": "/absolute/local/path" } }` registers
an existing host directory after probing the configured `hermes acp` executable. Its summary
has `kind: "hermes"`; `url` contains the canonical workspace path. No T3 token is stored.

The existing authenticated `/env/:id/ws` endpoint routes these bases to `server/hermes/bridge.ts`.
It implements `server.getConfig`, shell/thread subscriptions, and dispatch of turn start,
interrupt, approval response, settle, and unsettle. Each subscription starts with a snapshot,
then carries only what changed, coalescing updates while awaiting each Effect RPC `Ack`. The
shell sends `thread-upserted`/`thread-removed`/`project-upserted` for changed entries. Thread
streams send `thread.message-sent` (streamed text as appended deltas) and
`thread.activity-appended` events. Session or turn changes, replaced or trimmed transcripts,
and non-append edits resnapshot. Thread snapshots honour `turnLimit`; untagged Bot Chat history
sends its latest 200 messages. Browser disconnects cancel subscriptions only.
Command IDs are deduplicated in memory for the most recent 500 commands.

The host starts one shell-free ACP stdio process per turn and reloads the thread's session.
`bootstrap.createThread.hermesProfile` chooses the native profile; omitted means `default`.
`ThreadShell.hermesProfile` and `hermesBotChat` identify bot ownership and canonical chats. ACP protocol v1
`initialize`, `session/new` or `session/load`, `session/set_mode`, and `session/prompt` drive it.
`session/update` projects text, thought chunks, tool progress, and context usage into the fleet.
`session/request_permission` preserves the offered choices; responses return their original
ACP option IDs, including Hermes's distinction between `allow_session` and `allow_always`.
Halt sends the `session/cancel` notification and keeps the turn active until its prompt settles.

Only Hermes's `default` (ask before edits) and `accept_edits` (workspace edit approval) modes
are exposed. The configured model is represented by the adapter's `default` selection;
model changes are available through bot management or Hermes configuration. Images, structured questions,
background-task telemetry, and usage-cost scans are unsupported, with no synthetic estimates.

Transcripts and ACP session IDs persist separately from the environment registry in owner-only
files. Concurrent saves coalesce into one write. Each thread keeps its latest 2,000 messages
and 2,000 activities, matching the browser's transcript cap. A host restart marks in-flight turns interrupted and clears pending approvals; the next
order reloads the recorded session without duplicating ACP's history replay in the Command log.

### Hermes management

`POST /api/envs/:id/hermes` accepts `{ action, profile?, body? }`; profile defaults to `default`.
It uses the same identity and cross-origin protections as station mutations and refuses non-Hermes
stations. Actions are allowlisted: `profiles.list/get/create/update/delete`,
`jobs.list/create/update/pause/resume/trigger/delete/runs/output`, and `chat.open`.
Only named configuration fields are exposed, with no raw config/credentials endpoint or client-selected
command, executable, or filesystem path for memory. Scripts and workdirs use Hermes's native validation.
`chat.open` returns `{threadId}` for the profile's canonical `Bot Chat`; reopening refreshes native history.

The management helper discovers the configured launcher's `--print-runtime-command`, preserves its
Python/bootstrap, and replaces its CLI entrypoint with `server/hermes/manage.py`. Arguments use stdin
JSON, never a shell. Writes are serialized; active profile mutations acquire the same global bot guard
as task turns. Native profile deletion may return `{deleted:true, warning}` when Hermes reports pending
routing identity cleanup. Native jobs persist independently of Command. `jobs.trigger` refuses a profile
without a proven running scheduler. History/output reads are bounded and profile scoped.

Canonical Bot Chats use `server/hermes/bot.py`, a SessionManager subclass of the installed
ACP adapter. It admits only exactly titled `Bot Chat` rows, preserves their native source,
and acquires Hermes's native session lease before restoring. Tools, approvals, model execution,
and notifications still use Hermes ACP. Background native transcript refresh runs every
30 seconds while browser clients are connected, skipping active Command turns.
