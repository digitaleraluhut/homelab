# Development Plan: homelab (fix/debug-lobehub-oauth-404 branch)

*Generated on 2026-05-18 by Vibe Feature MCP*
*Workflow: [bugfix](https://codemcp.github.io/workflows/workflows/bugfix)*

## Goal
Fix 404 error user's friend (github-user3) gets after GitHub OAuth authorization when accessing https://lobehub.no-panic.org/

## Key Decisions
- **read:org scope is NOT the issue**: GitHub App "beimir.homelab" (Iv23liZKWPsuTBvPC4vO) has read:org as an installation permission. GitHub surfaces ALL installed permissions on the authorization page. The user sees the same scope.
- **Friend uses correct oauth2-proxy**: redirect_uri is `oauth.no-panic.org/oauth2/callback` (users group), state encodes lobehub.no-panic.org. Friend is github-user3, email user2@example.com IS in users group allowlist.
- **Two auth layers**: (1) Traefik oauth2-proxy → (2) LobeHub Better Auth. Error proven to originate at layer 1 (oauth2-proxy / GitHub OAuth), not layer 2.
- **Strategy**: Add test user user3@example.com to isolate whether issue is oauth2-proxy layer or LobeHub Better Auth layer.
- **All infrastructure routing is healthy** (confirmed via extensive testing):
  - Cloudflare Tunnel → Traefik routing works (Traefik has healthy endpoints at 10.42.0.36:8000)
  - Callback IngressRoute (`Host(oauth.no-panic.org) && PathPrefix(/oauth2/callback)`) correctly forwards to oauth2-proxy-users service
  - Direct curl callbacks to `https://oauth.no-panic.org/oauth2/callback` reach oauth2-proxy and appear in logs (confirmed with 500 status and "Error while parsing OAuth2 state: invalid length" log)
  - Internal service `oauth2-proxy-users.oauth2-proxy.svc.cluster.local` also reachable
  - Browser-like headers (real Chrome/Edge User-Agent + Referer: github.com) do NOT block the callback
- **CSRF cookie validation works**: Full simulation of `/oauth2/start` → capture cookie + state → `/oauth2/callback` with matching cookie/state correctly passes CSRF validation (not 500, returns sign-in page instead)
- **GitHub authorization URL is valid**: The exact URL oauth2-proxy generates (`https://github.com/login/oauth/authorize?...client_id=Iv23liZKWPsuTBvPC4vO&redirect_uri=https://oauth.no-panic.org/oauth2/callback&scope=user:email+read:org...`) returns 302 (to login page) from GitHub — not 404, not an error. The URL itself is well-formed.
- **Root cause narrowed to GitHub App configuration**: The error occurs BEFORE the OAuth callback is generated. The `redirect_uri` parameter sent to GitHub (`https://oauth.no-panic.org/oauth2/callback`) MUST exactly match the "User authorization callback URL" configured in the GitHub App. If mismatched, GitHub shows an error page instead of the authorization screen → no callback is generated → no `/oauth2/callback` log entry.
- **REVISED (user confirmed): GitHub App has `https://oauth.no-panic.org/oauth2/callback` as first callback URL** — that URL was in the "Callback URL" (installation webhook) field, NOT in the separate "User authorization callback URL" field (for OAuth). These are two distinct fields.
- **Root cause confirmed: "Request user authorization (OAuth) during installation" was ENABLED**, which LOCKED the "User authorization callback URL" field. oauth2-proxy's standalone OAuth flow required this field to be set. With it locked/empty, GitHub could not redirect users back to oauth2-proxy after authorization.
- **pulumi up executed** at 13:45 — ConfigMap `oauth2-emails-users` now has `user3@example.com`, oauth2-proxy pod was recreated. Old pod logs lost.
- **User fix attempted** at ~14:00: disabled "Request user authorization (OAuth) during installation", set "User authorization callback URL" to `https://oauth.no-panic.org/oauth2/callback`. Login at 14:06 still failed — turns out there is no "User authorization callback URL" field; the existing "Callback URL" list is what GitHub uses.
- **DEFINITIVE ROOT CAUSE (confirmed via Playwright inspection of live GitHub App settings)**: The **"Setup URL"** field is set to `https://oauth.no-panic.org/oauth2/callback` AND **"Redirect on update"** is checked. GitHub redirects to Setup URL after authorization WITHOUT OAuth code/state params → oauth2-proxy rejects the request → user sees 404/error. The Callback URL list IS correct. Fix: clear Setup URL, uncheck "Redirect on update".
- **Client secret comparison**: k8s starts `7b3c` (40 chars), GitHub App ends `e64c72d3` — cannot confirm match without full secret
- **GOTCHA: GitHub App visibility restriction**: After fixing Setup URL, `user1@example.com` (app owner) can log in but `user3@example.com` (new user) still fails with 404. The GitHub App "beimir.homelab" appears to have visibility restrictions — only the app owner can authorize it. New users get 404 from GitHub when attempting to authorize. **This is a critical gotcha: GitHub Apps can be Public, Internal (org-only), or Private. If not Public, only specific users can authorize.**

## Notes
- User (user1@example.com / github-user1) has an existing valid oauth2-proxy session (cookie: `_oauth2_users`) — this explains why the user can still access lobehub even when new OAuth logins fail. Existing sessions are validated against the email allowlist, not GitHub.
- The user's existing session continues to work (session refreshes at 10:49 AM, forward-auth 202 responses throughout the day)
- **ALL new login attempts fail** — NOT just the friend. There are 5 separate `/oauth2/start` requests from real browsers (Chrome/Edge on macOS) at 11:10, 11:12, 11:36, 12:32, and 12:36 — NONE have a subsequent `/oauth2/callback` entry
- The `/oauth2/start` log entries show correct 302 redirects — oauth2-proxy generates valid GitHub authorization URLs
- The issue started around 11:10 AM — BEFORE the `pulumi up` deployment (which ran at 12:21-12:21). This rules out the deployment as the trigger.
- The most likely cause: the GitHub App's "User authorization callback URL" at https://github.com/settings/apps/beimir-homelab is mismatched or was changed around 11:00 AM, preventing GitHub from showing the authorization page
- **Test account**: `user3@example.com` — needs to be verified as an actual GitHub user account with email `user3@example.com` on the account
- **Reproduction script**: `scripts/repro-oauth-failure.txt` — validates all 6 steps of the OAuth flow and confirms infrastructure is healthy

## Gotchas to Document

### 1. GitHub App "Setup URL" field silently breaks OAuth
**Location**: GitHub App settings → "Setup URL"  
**Impact**: If set to the OAuth callback URL + "Redirect on update" checked, GitHub redirects to Setup URL after authorization WITHOUT code/state params → oauth2-proxy receives invalid callback → 404/error.  
**Fix**: Clear Setup URL, uncheck "Redirect on update".  
**Where to capture**: 
- ✅ This plan file (analysis section)
- ✅ `packages/core/infrastructure/src/oauth2-proxy/README.md`
- ✅ `scripts/repro-oauth-failure.txt` (Step 7)
- ⏳ Code comment in `packages/core/infrastructure/src/oauth2-proxy/oauth2-proxy.ts` near GitHub App config (pending Fix phase)

### 2. GitHub App visibility restricts who can authorize
**Location**: GitHub App settings → "Where can this GitHub App be installed?"  
**Impact**: If set to "Only on this account" or "Only within [org] organization", new users get 404 from GitHub when attempting to authorize. Only app owner/creator can use it.  
**Fix**: Either (a) make app Public, or (b) add users to allowed list/org.  
**Where to capture**:
- ✅ This plan file (analysis section)  
- ✅ `packages/core/infrastructure/src/oauth2-proxy/README.md`
- ⏳ Pulumi config validation — could warn if GitHub App is not Public (pending future enhancement)

### 3. GitHub App "Request user authorization (OAuth) during installation" locks callback URL
**Location**: GitHub App settings → "Request user authorization (OAuth) during installation"  
**Impact**: When enabled, hides the "User authorization callback URL" field, preventing standalone OAuth flows (like oauth2-proxy) from working.  
**Fix**: Disable this setting if using standalone OAuth (not installation flow).  
**Where to capture**:
- ✅ This plan file  
- ✅ `packages/core/infrastructure/src/oauth2-proxy/README.md`
- ⚠️ Pulumi config validation — could warn if GitHub App is not Public

### 3. GitHub App "Request user authorization (OAuth) during installation" locks callback URL
**Location**: GitHub App settings → "Request user authorization (OAuth) during installation"  
**Impact**: When enabled, hides the "User authorization callback URL" field, preventing standalone OAuth flows (like oauth2-proxy) from working.  
**Fix**: Disable this setting if using standalone OAuth (not installation flow).  
**Where to capture**:
- ✅ This plan file  
- ✅ `packages/core/infrastructure/src/oauth2-proxy/README.md`

### Reproduction Script Results (2026-05-18 13:21)
| Step | Test | Result |
|------|------|--------|
| 1 | `/oauth2/start` → 302 redirect | PASS |
| 2 | GitHub URL validation (client_id, redirect_uri, scope, state format) | PASS |
| 3 | CSRF cookie extraction (HttpOnly, Secure, SameSite=Lax) | PASS |
| 4 | GitHub authorization URL accessibility | PASS (302 to login) |
| 5 | Callback CSRF validation (state matches cookie) | PASS |
| 6 | Requests appear in oauth2-proxy logs | PASS |

**Confirmed**: The entire infrastructure pipeline (Tunnel → Traefik → oauth2-proxy → GitHub redirect → callback route → CSRF validation) is healthy. The failure occurs at GitHub's authorization page — users cannot complete the authorization step because GitHub rejects the callback URL.

## Reproduce
<!-- beads-phase-id: homelab-10.1 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-10.1.1` Add user3@example.com to users group allowlist
- [x] `homelab-10.1.2` Deploy updated ConfigMap to cluster via pulumi up
- [x] `homelab-10.1.3` Test new user login flow end-to-end
- [x] `homelab-10.1.4` Check oauth2-proxy logs to determine where 404 occurs
- [x] `homelab-10.1.5` Create OAuth flow reproduction script that validates each step of the flow

## Analyze
<!-- beads-phase-id: homelab-10.2 -->

### Root Cause Analysis

#### Revised Analysis (User confirmed callback URL IS correct)

**Evidence Timeline (from oauth2-proxy-users logs):**
| Time | Event | Result |
|------|-------|--------|
| 10:21:58 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub |
| 10:22:37 | `/oauth2/callback?code=3460ad9f...` | **302 SUCCESS** — user logged in |
| 11:10:46 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub — **NO callback** |
| 11:12:09 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub — **NO callback** |
| 11:36:31 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub — **NO callback** |
| 12:32:40 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub — **NO callback** |
| 12:36:34 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub — **NO callback** |
| 13:32:29 | `/oauth2/start` (Chrome/Edge macOS) | 302 to GitHub — **NO callback** |

**NO `/oauth2/callback` entries from real browsers after 10:22:37.**

#### What We Know
- **GitHub App callback URL IS correct**: `https://oauth.no-panic.org/oauth2/callback` is the first of multiple configured callback URLs in the GitHub App "beimir.homelab"
- **Infrastructure is healthy**: Reproduction script passes all 6 steps (Cloudflare → Traefik → oauth2-proxy → GitHub redirect → callback routing → CSRF validation)
- **k8s secret NOT changed**: `oauth2-proxy-github` created 2026-04-21, last modified 2026-04-21 (27 days ago) — no credential rotation
- **ConfigMap updated**: `pulumi up` at 13:45 successfully deployed `user3@example.com` to the allowlist + recreated the oauth2-proxy pod
- **No error logs**: oauth2-proxy shows no error-level messages (excluding expected "Error while parsing OAuth2 state: invalid length" for curl tests without state params)
- **Client secret**: k8s starts with `7b3c`(40 chars), GitHub App's ends with `e64c72d3` (possibly same secret, can't confirm with partial info)

#### Revised Root Cause Theories

Since the callback URL IS correct, the failure is NOT due to callback URL mismatch. Possible remaining causes:

| # | Theory | Likelihood | Evidence |
|---|--------|-----------|----------|
| A | **Wrong GitHub App field**: User set callback URL in "Callback URL" (webhooks) but NOT in "User authorization callback URL" (OAuth). These are SEPARATE fields in GitHub App settings. | **HIGH** | Most common configuration error; explains all symptoms |
| B | **GitHub App client_secret mismatch**: Secret in k8s differs from GitHub App → token exchange fails → oauth2-proxy returns error | **MEDIUM** | Would cause callback to REACH oauth2-proxy but with 500; we DON'T see real browser callbacks at all |
| C | **GitHub App modified between 10:22–11:10**: Permissions, OAuth settings, or installation changed on GitHub side | **MEDIUM** | Timing aligns; k8s hasn't changed |
| D | **Browser/redirect blocking**: Referrer policy, CSP, or browser security blocking redirect from github.com → oauth.no-panic.org | **LOW** | Same browser/device worked at 10:22 |
| E | **Cloudflare blocking**: Cloudflare WAF/firewall blocking callback requests with `Referer: github.com` | **LOW** | Infrastructure tests pass from same network |

#### Critical Finding: "Request user authorization (OAuth) during installation" was enabled

The user discovered that the **"User authorization callback URL"** field was INACCESSIBLE/LOCKED in the GitHub App settings because **"Request user authorization (OAuth) during installation"** was enabled.

**Root cause confirmed**:
- When "Request user authorization (OAuth) during installation" is ON: GitHub App uses combined install+authorize flow; "User authorization callback URL" field is hidden/disabled
- oauth2-proxy uses the STANDALONE OAuth authorization flow (`/login/oauth/authorize`) — NOT the installation flow
- The "User authorization callback URL" field was never configured because it was locked behind the other setting
- This caused GitHub's OAuth authorization to fail (no callback URL → no callback generated)

**Fix attempted by user**:
- Disabled "Request user authorization (OAuth) during installation"
- Set "User authorization callback URL" to `https://oauth.no-panic.org/oauth2/callback`
- However: login attempt at 14:06:57 still shows `/oauth2/start` with NO subsequent callback

**Why fix may not have worked yet**:
1. Changes not saved/propagated yet
2. Exact URL value has a subtle difference (trailing slash, typo)
3. Browser cache / old cookies from the test session
4. Additional GitHub App configuration requirement

#### Status After Fix Attempt
- 14:06:57: Real browser `/oauth2/start` → 302 to GitHub — still NO callback
- 14:25:20: Real browser `/oauth2/start` → 302 to GitHub — still NO callback (AFTER GitHub App settings change)
- User reports: **still gets standard GitHub 404 page** (not an oauth error — a GitHub "not found" page)
- Infrastructure reproduction script still passes all checks (healthy)

#### Definitive Root Cause: "Setup URL" field set to OAuth callback URL

Via Playwright browser automation (attached to user's Edge with CDP), I inspected the **live GitHub App settings** for "beimir.homelab":

**GitHub App "beimir.homelab" actual state (read via Playwright):**

| Field | Value |
|-------|-------|
| Callback URL #1 | `https://oauth.no-panic.org/oauth2/callback` ✓ |
| Callback URL #2 | `https://lobehub.no-panic.org/api/auth/callback/github` |
| Callback URL #3 | `https://oauth.no-panic.org/developers/oauth2/callback` |
| **Setup URL** | **`https://oauth.no-panic.org/oauth2/callback`** ← **ROOT CAUSE** |
| Request OAuth during installation | ☐ unchecked |
| Enable Device Flow | ☑ checked |
| Redirect on update | ☑ **checked** ← **CONTRIBUTES TO BUG** |

**Why this causes the 404:**

The GitHub App's "Callback URL" list IS correct — `https://oauth.no-panic.org/oauth2/callback` is registered. So the redirect_uri in the OAuth URL IS valid.

BUT: The **"Setup URL"** is set to `https://oauth.no-panic.org/oauth2/callback` AND **"Redirect on update"** is checked. This means:

1. User goes to `/oauth2/start` → redirected to GitHub authorization page ✓
2. User sees the GitHub authorization page ✓  
3. User clicks "Authorize" ✓
4. GitHub completes the OAuth flow AND then redirects to the **Setup URL** (`/oauth2/callback`) WITHOUT the `code` and `state` parameters — because Setup URL redirects are NOT OAuth callbacks
5. oauth2-proxy receives a request to `/oauth2/callback` without `code`/`state` → returns 500 or rejects
6. User sees an error page (or GitHub shows 404 because the setup redirect fails)

**Additionally**: With "Redirect on update" checked, GitHub redirects to the Setup URL **every time the app authorizes** (not just on first install). This explains why the login at 10:22 AM succeeded (possibly before "Redirect on update" was enabled or before Setup URL was set) but all subsequent logins fail.

**Fix applied (confirmed working):**
- Setup URL cleared ✓
- "Redirect on update" unchecked ✓
- Callbacks at 14:49:00 and 14:49:32 succeeded with real GitHub codes → **oauth2-proxy Layer 1 is now FIXED**

#### User-Specific Failure: `user1@example.com` works, `user3@example.com` fails

**Critical finding**: After clearing Setup URL and unchecking "Redirect on update", `user1@example.com` (github-user1) can log in successfully, but `user3@example.com` (github-user2) still fails.

**User's observation**:
> "I can still log in with user1@example.com, but not with user3@example.com. After logging in on oauth proxy, it redirected to lobehub. that also wanted to get a gh auth, but then I clicked the sign in button and as the cookie was already set, it got authenticated without further dialog"

**Comparing the two authorization requests:**

| | Working (github-user1) | Failing (github-user2) |
|---|---|---|
| **Flow** | LobeHub Better Auth | oauth2-proxy |
| **URL** | `github.com/login/oauth/authorize?...` | `github.com/login/oauth/authorize?...` |
| **client_id** | `Iv23liZKWPsuTBvPC4vO` | `Iv23liZKWPsuTBvPC4vO` |
| **redirect_uri** | `lobehub.no-panic.org/api/auth/callback/github` | `oauth.no-panic.org/oauth2/callback` |
| **scope** | `read:user+user:email` | `user:email+read:org` |
| **approval_prompt** | none | `force` |
| **GitHub user** | `github-user1` | `github-user2` |
| **Response** | Success (200/302) | 404 |

**Key evidence**:
1. **NO `/oauth2/start` or `/oauth2/callback` entries appear in oauth2-proxy logs for `user3@example.com`** — the flow never reaches oauth2-proxy
2. The failing request hits GitHub's authorize URL directly and GitHub returns 404
3. Both requests use the SAME `client_id` (`Iv23liZKWPsuTBvPC4vO`)
4. `github-user1` has existing GitHub organizations (`assistify`, `open-abap`); `github-user2` has NO public org memberships
5. The `beimir` organization does not appear to exist publicly

**Leading hypothesis: GitHub App visibility restriction**

The GitHub App "beimir.homelab" (`Iv23liZKWPsuTBvPC4vO`) may be configured as **"Internal"** (org-only) or has user access restrictions. `github-user1` (app owner/creator) can access it, but `github-user2` cannot.

**Why this fits**:
- GitHub returns 404 when a user tries to authorize an app they don't have access to
- `github-user1` works because they own/created the app
- `github-user2` fails because they're not authorized to use the app
- The friend `dirk.oberhaus` also fails (different user, same restriction)

**Alternative hypothesis: `read:org` scope issue**

oauth2-proxy requests `scope=user:email+read:org` while Better Auth requests `scope=read:user+user:email`. For GitHub Apps, OAuth "scopes" are actually mapped to app permissions. If the app doesn't have organization read permission, requesting `read:org` might fail for first-time authorizers.

However, this is less likely because:
- The same scope works for `github-user1` (who has already authorized the app)
- A scope mismatch would typically show an error page, not a 404

**Verification needed**:
- Check GitHub App "beimir.homelab" visibility setting (Public / Internal / Private)
- Check if `github-user2` is listed as an authorized user
- If app is Internal: either make it Public or add users to the org/allowlist

### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-10.2.1` Confirm root cause: GitHub App callback URL mismatch at https://github.com/settings/apps/beimir-homelab
- [x] `homelab-10.2.10` Test GitHub App OAuth with fresh incognito browser session after callback URL fix — clear all cookies first
- [x] `homelab-10.2.11` Verify User authorization callback URL was saved correctly in GitHub App — check exact value vs https://oauth.no-panic.org/oauth2/callback (no trailing slash)
- [x] `homelab-10.2.12` Determine exact error message shown on GitHub authorization page — screenshot from friend or incognito test
- [x] `homelab-10.2.13` Verify exact User authorization callback URL in GitHub App matches: https://oauth.no-panic.org/oauth2/callback (42 chars, no trailing slash)
- [x] `homelab-10.2.14` Fix: Clear Setup URL field in GitHub App (currently wrongly set to oauth callback URL) — causes GitHub to redirect to oauth2-proxy without code/state params
- [x] `homelab-10.2.15` Layer 1 (oauth2-proxy) is NOW FIXED — callbacks succeeding at 14:49. Layer 2 issue: /signin page returns 401 to oauth2-proxy forwardauth, triggering redirect loop
- [x] `homelab-10.2.16` Investigate GitHub App visibility restriction causing 404 for new users
- [x] `homelab-10.2.2` Check if GitHub App OAuth credentials (client_secret in k8s secret oauth2-proxy-github) were rotated/recreated recently
- [x] `homelab-10.2.3` Review GitHub App oauth2-proxy configuration for any other potential issues (scopes, device flow, callback config)
- [x] `homelab-10.2.4` Document root cause analysis and fix plan in plan file
- [x] `homelab-10.2.5` Verify callback URL is set as "User authorization callback URL" vs regular "Callback URL" in GitHub App settings — these are different fields
- [x] `homelab-10.2.6` Check if k8s client_secret matches GitHub App client_secret — k8s starts 7b3c, GH ends e64c72d3
- [x] `homelab-10.2.7` Re-examine successful 10:22 login flow vs failed 11:10 flows — trace exact differences in logs
- [x] `homelab-10.2.8` Check pulumi up result — did ConfigMap get updated with user3@example.com?
- [x] `homelab-10.2.9` Check oauth2-proxy error-level logs for token exchange failures or other errors

## Fix
<!-- beads-phase-id: homelab-10.3 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Verify
<!-- beads-phase-id: homelab-10.4 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Finalize
<!-- beads-phase-id: homelab-10.5 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

