# Google Drive Sync: Spec

**Status:** v0.17, implemented in `src/google-drive/` (hoisted by jeeves-scripts-template#97). This is the design record; `src/google-drive/README.md` is the operator reference. `§` references in the code point here.

**Changelog:**

- v0.17: template review. Failed path or drive-name lookups count as enumeration errors, and a run with enumeration errors holds every move as well as every deletion (§4.3, §6.5). Names are sanitized for Windows as well as POSIX (§3.1) and renames retry Windows sharing violations. One run-wide `googleDrive.budget` replaces the per-sync budgets (§6.4, §8). The block is validated by the domain, not the shared config loader, so a mistake in it fails only this job (§8). `.xlsx` is read with `read-excel-file` instead of `exceljs` (unmaintained, with open advisories via `uuid`) (§5).
- v0.16: PR review hardening. Disjoint `targetDir`s and unique accounts (config error); symlinks refused in the owned tree; the content key is read before export; conversion-time skips leave the old copy for the next guarded plan; the planner reconciles the ledger against disk (lost copies re-download, completed moves adopted; moves persisted one by one); unseen records kept while deletions are blocked; no new syncs dispatched once the budget is spent; native text keeps a BOM.
- v0.15: post-build corrections. VCS exclusion deferred (it also de-indexes via `respectGitignore`; jeeves-watcher#253). `targetDir` must be a strict subdirectory of `CONTENT_DIR`. Dot-entries in the owned tree are platform-owned and ignored. Module layout per the implementation (orchestrate/run-sync/report/seed-metas).
- v0.14: jeeves-meta pre-implementation check (seed 409, 30-min stale lock, discovery cache); enumeration performance (batched parent queries).
- v0.13: spike results folded in (the originating instance's spike notes): path resolution confirmed; `My Drive`/`Drive` root-name handling; two-stage revision content key for Google-native files; `/` in names; Google-native `size` ignored; empty exports; Sheets sizing; gog full scopes and `--readonly` as the sole write guard; non-member shared-drive sharing setting.
- v0.12: all findings in the spec review applied (runner timeout/SIGTERM, `JR_RESULT`, exit codes, `--reset-state`, content-key change detection, export limit, gog scopes, temp staging, VCS exclusion, guard min-count, seeding/tree fixes, config gaps); decisions: guard trip fails the run, mirror excluded from VCS, temps staged outside content.
- v0.11: Q7 (every tab), Q8 (13 min), meta edge case and download order confirmed; sync account registered in gog; share acceptance (§4.5).
- v0.10: `-` separator confirmed; rejected naming alternatives recorded (§3.1).
- v0.9: tag = 8 chars of base32(sha256(id)) for every item, shared drives included; replaces last-8-chars.
- v0.8: tags = last 8 ID chars (full ID for shared drives) with collision fallback; extension rules for multi-dot names (§3.2).
- v0.7: every synced segment suffixed with its full Drive ID; lz-string evaluated and rejected; length limits validated against FS/watcher/VCS (§3.1). Q6 dissolved.
- v0.6: external shares (Q3, §4.3).
- v0.5: state location and shape made concrete (§6.1); `targetDir` wholly owned by the sync (§6.5).
- v0.4: budgeted downloads via a derived work queue (§6.4).
- v0.3: Q1 (impersonation approved), Q2 (identity dir = verbatim email), Q4 (tree is canonical: §7 rewritten), Q5 (only items shared to the account, recursed) resolved. Assistant-facing README and onboarding requirements added (§9.1, §11).
- v0.2: explicit un-share handling (§6.2.1).

**Origin:** designed and verified on a live instance's scripts repo, then hoisted unchanged to `jeeves-scripts-template`.

## 1. Purpose

Mirror Google Drive content that has been **shared with the instance's Workspace user** into the content tree as text, so the watcher indexes it and jeeves-meta synthesizes it. Keep the mirror current (new, changed, moved, renamed, deleted, unshared) without re-doing work for unchanged files.

## 2. Scope

### In scope

- Files and folders shared directly with the sync account ("Shared with me"), including everything beneath a shared folder.
- Shared drives the sync account is a member of (the whole drive is the share).
- Shared-drive files/folders shared individually with the sync account (not a member of the drive).
- Text persistence: native text as-is, Google-native files exported to Markdown, convertible binaries converted to Markdown.
- Deletion, **un-share** and change propagation, rename/move handling.
- Meta seeding at each share root and each share point (§7).

### Out of scope (v1)

- Writing back to Drive. The sync is strictly read-only (`gog --readonly` on every call).
- Anything not shared _to_ the account (Q5): files it owns, link-only ("anyone with the link") or domain-wide access.
- Images, audio, video, archives, Drawings, Forms, Sites, Maps, Jamboard: no text path, skipped.
- Comments, suggestions, revision history.
- Push notifications (`changes.watch` webhooks). Polling only.

## 3. Output layout

```
<targetDir>/                                   default: <CONTENT_DIR>/google-drive
  alice@example.com/                           personal (My Drive) share root    ← meta
    a - <idA>/b - <idB>/                       share point (lowest shared level) ← meta
      c - <idC>.txt
  Engineering - <driveId>/                     shared drive share root           ← meta
    x - <idX>/y - <idY>/                       share point                       ← meta
      report - <idR>.docx.md
```

(`<idX>` = 8-character hashed ID tag. See §3.1.)

- **Share root**: the ultimate Drive root of the item: the owner's identity for My Drive items, or the shared drive's name.
- **Path below the root**: the item's real Drive folder path from that root, so a file shared from `a/b/c.txt` in Alice's My Drive lands at `<targetDir>/alice@example.com/a - <id>/b - <id>/c - <id>.txt` (ID suffixes per §3.1; examples elsewhere in this spec omit them for readability).
- **Share point**: the lowest level at which the share took place. For a shared **file**, its containing folder (`a/b`). For a shared **folder**, the folder itself. For a shared drive, the drive root (share point = share root, one meta).

### 3.1 Naming

**Every synced folder and file is suffixed with a Drive ID tag.** Identity roots are the only unsuffixed segments, because an email address is already unique.

**Segment format:** `<stem> - <tag><ext>`

**The tag:** the first 8 characters of `base32(sha256(driveId))`, lowercase RFC 4648 alphabet (`a-z2-7`), for **every** synced item: files, folders and shared drives alike.

- _One rule for every ID format._ Hashing spreads any input evenly, so structured IDs don't matter: shared-drive IDs ending in `Uk9PVA` (base64 `ROOT`), legacy `0B…` IDs (73 characters observed), whatever Google uses next.
- _Why base32 and lowercase:_ safe on case-insensitive filesystems if the content tree is ever cloned to macOS/Windows (via a VCS remote, or exports), and no `-`/`_` that could blur the `-` separator. 8 characters = 40 bits. Tags only need to be unique among **siblings**: even 10,000 items in one folder have a ~0.005% chance of any collision.
- _Collision fallback:_ colliding siblings both lengthen to 12, then 16 characters, until unique. It's derived from the snapshot, so it's deterministic and doesn't flap. When a collision later resolves (one sibling leaves), the survivor's tag shrinks back to 8 characters, which is a rename. That's the instability rejected below for "tag only on collision", accepted here because at ~10⁻⁵ odds per 10,000-item folder it will essentially never happen.
- _Pinned scheme:_ changing the hash, encoding or length later would rename every synced path, so the scheme is a versioned constant (`TAG_SCHEME = 'sha256-b32-8'`), not config.

| Drive item | Local name |
| --- | --- |
| Folder `a` | `a - k3v7q2xm` |
| Shared drive `Engineering` | `Engineering - p5zr2a7d` |
| Native text `notes.md`, `main.py` | `notes - k3v7q2xm.md`, `main - k3v7q2xm.py` |
| Google Doc `Q3 Plan` (Sheet, Slides alike) | `Q3 Plan - k3v7q2xm.md` |
| Converted binary `report.docx`, `spec.pdf` | `report - k3v7q2xm.docx.md`, `spec - k3v7q2xm.pdf.md` |
| Identity root | `alice@example.com` (verbatim, lowercased; Q2) |

**Why tags:** they remove name collisions, since Drive allows same-named siblings. Shared-drive roots can't clash with identity roots (Q6 dissolved). And every local path points straight back to its Drive item.

**Recovering the full ID.** The tag is unambiguous to parse: it's the token after the _last_ `-`, made of `[a-z2-7]` (no spaces, no dots), ending at the first `.` that follows it: `/ - ([a-z2-7]{8,})(\.[^/]*)?$/`. A name containing `-` doesn't break that. The full ID is recovered by hashing candidate IDs and matching: an in-memory `tag → fileId` map is built each run by hashing the ledger's keys (§6.1; nothing extra is stored), and if the ledger is lost the run's remote snapshot serves the same purpose. Tags are unique among siblings, so the match is always exact. The trade-off against a raw ID substring: you can't spot the tag inside a Drive URL by eye. The README documents a one-liner that computes it.

**Why not full IDs, or compressed ones.** Full IDs cost up to 47 bytes per segment and make paths hard to read. Compression doesn't help: Drive IDs are already in the densest filename-safe alphabet (6 bits per character) and they're random. Tested with `lz-string` 1.5.0 on real IDs:

| ID length | `compressToEncodedURIComponent` | `compressToBase64` | `compress` (UTF-16) |
| --- | --- | --- | --- |
| 44 (Docs file) | 81–86 chars | 84–88 | 31 chars but 79–89 **bytes** UTF-8 |
| 33 (folder) | 73 | 76 | 70 bytes |
| 18 (shared drive) | 36 | 36 | 38 bytes |

Compression roughly doubles the length.

**Alternatives considered and rejected (2026-10-05):**

- _Tag only on collision:_ needs an "oldest keeps the bare name" rule, and still renames paths (whole subtrees, for folders) when the bare-name holder disappears. That means watcher re-embeds and broken path-based meta cross-refs, and most paths would stop being self-identifying.
- _Last 8 raw ID characters:_ shared-drive IDs end in a constant (`Uk9PVA`), so those 8 characters are mostly non-random. Superseded by hashing.
- _Full or `lz-string`-compressed IDs:_ too long; compression roughly doubles a random ID.
- _Tag as a dotted extension_ (`a.k3v7q2xm.md`): no structural anchor. Dots are common in Drive names, and an 8-letter word (`thursday`) or an extension (`.markdown`) matches the tag pattern, so parsing would need ledger lookups or a sigil. The `-` separator keeps the parse a pure string rule.

### 3.2 Stems and extensions

Extensions come from the item's **class** (§5), not from string-splitting the Drive name, so names that already carry dots or two extensions are safe:

| Class | Stem | Ext |
| --- | --- | --- |
| Google-native (Doc/Sheet/Slides) | the **whole** Drive name, never split (`Notes v3.5 final` stays intact) | `.md` |
| Native text | name minus its last extension | that last extension. If the name has none, an extension mapped from the MIME type (`text/markdown` → `.md`, `text/plain` → `.txt`, …) so the watcher's extension rules still match |
| Converted binary | name minus its last extension | `.<source ext>.md` |

- A "last extension" counts only if it matches `^\.[A-Za-z0-9]{1,10}$`. Otherwise (`Q3 results.final draft`) the whole name is the stem.
- Only the **last** extension is ever split off. Anything before it stays in the stem, ahead of the tag:
  - `report.final.docx` → `report.final - k3v7q2xm.docx.md`
  - `notes.md.txt` (text) → `notes.md - k3v7q2xm.txt`
  - `x.docx.md` (a Markdown file that happens to be named like that) → `x.docx - k3v7q2xm.md`, distinct from a converted `x.docx`, which is `x - k3v7q2xm.docx.md`
- The tag is the anchor. Dots before it belong to the stem, and everything after it is our own extension. So parsing never has to guess, and no special guard is needed for double extensions.
- Case is preserved. Extension matching for classification is case-insensitive (`.DOCX` = `.docx`).

**Length budget.**

- _Per segment:_ ≤ 255 **bytes** (ext4 `NAME_MAX`, confirmed on this host; NTFS allows 255 UTF-16 units, which a 255-byte UTF-8 name never exceeds). The name part is truncated to fit: `255 − len(" - " + tag + ext)` bytes, cut on a UTF-8 code-point boundary, trailing whitespace and dots trimmed. That leaves ≥ ~200 bytes of real name for any Drive item. Truncation is deterministic, so it doesn't flap.
- _Optional readability cap:_ `naming.maxNameBytes` (default: none, meaning fill to 255) can shorten the name part further.
- _Whole path:_ ≤ 4096 bytes (`PATH_MAX`). On Windows, Node prefixes long paths itself, so `MAX_PATH` (260) doesn't apply to the sync. An item whose absolute path would exceed `naming.maxPathBytes` (default 4000) is skipped and reported, never truncated into a misleading path. In practice that needs a tree more than ~15 levels deep of near-maximal names.

**Sanitization:** names are NFC-normalized. `/` (legal in Drive names; Google Meet auto-folders contain dates like `2026/10/04`), control characters (U+0000–U+001F, U+007F) and the characters Windows forbids in names (`\ : * ? " < > |`) are replaced with `_`. Leading/trailing whitespace and dots are trimmed (Windows also forbids a trailing dot or space). An empty result becomes `untitled`. A Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`, including superscript digits, with or without an extension) gets a `_` suffix. Identity roots are sanitized the same way. Every path is therefore valid on Linux, macOS and Windows, so the template's scripts run on Windows instances and the content tree can be cloned anywhere. _(v0.17: an existing mirror whose names contain one of the newly replaced characters sees those items move once, by the normal move path.)_

**Validated on this instance (2026-10-05)** by writing test files under the content root and checking the platform end to end, then removing them:

| Case | Filesystem | Watcher index | Watcher VCS |
| --- | --- | --- | --- |
| 255-byte ASCII filename (with full ID suffix) | ✓ | ✓ indexed, searchable | ✓ committed |
| 255-byte filename of 2-byte UTF-8 characters | ✓ | ✓ | ✓ committed (see note) |
| 13 levels of 250–255-byte segments, 3,323-byte absolute path | ✓ | ✓ | ✓ committed |

There were no watcher issues (`watcher_issues` empty). The watcher derives Qdrant point IDs by hashing the path (UUIDv5), and the VCS feeds file lists to git through stdin, so neither imposes a limit below the OS. **Note:** `watcher_vcs_history` returns non-ASCII paths in git's octal-escaped form (`\303\251…`; git `core.quotePath`). Drive names with accents or emoji will hit it. Filed as [jeeves-watcher#252](https://github.com/karmaniverous/jeeves-watcher/issues/252); the same root cause probably makes glob reverts skip non-ASCII files. With the mirror excluded from VCS (§11) this no longer affects the sync, but it does affect other content. **Not validated:** jeeves-server rendering of very long paths (the test needed an authenticated session).

## 4. Discovery and path resolution

### 4.1 What the sync account can see (as itself)

For each item visible to the sync account, the Drive API returns `id`, `name`, `mimeType`, `modifiedTime`, `version`, `md5Checksum` (binaries only), `size`, `trashed`, `owners[]` (My Drive items), `sharingUser`, `driveId` (shared-drive items), `shortcutDetails`.

**What it cannot reliably see:** `parents` is only meaningful where the sync account can access the parent folder. For a single file a colleague shares out of `a/b/`, the sync account sees the file, its owner and its sharer, but **not** `a/b`. Likewise `drives.get` (the shared drive's _name_) fails unless the account is a member of the drive.

So the account alone yields the share root identity for personal shares (owner email) but **not** the path, and for shared-drive items it yields only the `driveId`. Status: **confirmed in the spike** (spike notes §1, §6): `parents` is null for every shared item as the sync account, in both `files.list` and `files.get`; `owners` (My Drive) and `sharingUser` are visible, including for external owners; shared-drive items carry `driveId` and no `owners`; the sync account gets a 404 on a shared drive's root unless it's a member.

### 4.2 Resolving the path via domain-wide delegation

The instance's gog service account has domain-wide delegation (confirmed working for a `drive` read as `owner@example.com`). Path resolution therefore impersonates someone who _can_ see the ancestors:

| Item | Impersonate | Walk |
| --- | --- | --- |
| My Drive item, owner in a delegated domain | the owner (`owners[0].emailAddress`) | `parents` chain up to the owner's My Drive root |
| Item in a shared drive the account is a **member** of | nobody: the account reads parents and the drive name itself | `parents` chain up to the drive root; `drives.get` |
| Item shared individually out of a shared drive the account is **not** a member of | the `sharingUser` if in a delegated domain, else `pathResolution.sharedDriveFallbackIdentity` | `parents` chain up to the drive root; `drives.get` for the drive name |
| Owner/sharer outside delegated domains (e.g. a gmail.com user, another org) | nobody: **external share** | see §4.3 |

- **Root names (spike):** the walk ends at the owner's My Drive root, a folder literally named **`My Drive`**, which is dropped (the identity root replaces it). A shared drive's root folder is named **`Drive`** for every drive, so the drive's real name **must** come from `drives.get` (as the impersonated user), never from the root folder's `name`.
- **Confirmed (spike):** impersonating the owner (My Drive) or the sharer (shared drive) recovers the full path, including intermediate folders that weren't shared.
- **A failed lookup is an error, not a placement.** If a walk or drive-name lookup is attempted and throws (DWD denied, 5xx, timeout), the item is placed as unresolved for this run **and** the failure is recorded as an enumeration error. That stops the run deleting or moving anything (§6.5), so a transient failure can't relocate a share or remove its metas. Having nobody to impersonate (owner outside the delegated domains, impersonation off) is a stable condition, not an error.
- Impersonated calls are **metadata-only** (`files.get` with `fields=id,name,parents,driveId`, `drives.get`). Content is always downloaded as the sync account, so we never read anything the sync account wasn't given.
- Folder lookups are cached per run (one call per distinct ancestor), so cost is proportional to distinct folders, not files.
- "Delegated domains" is config (`pathResolution.domains`); impersonation can be switched off entirely.

**Privacy note (Q1, approved):** walking the owner's ancestors discloses the _names_ of folders the owner did not share (e.g. `Personal/HR/…`). Only names, never content or siblings. This is accepted. DWD scopes are granted per service-account client, so they apply to every impersonated user alike; the grant must cover whatever scopes gog requests (§11).

### 4.3 External shares (and other unresolvable paths)

_(Q3, resolved.)_ When the path above the shared item can't be recovered, the shared item goes **directly in its share root**. A shared folder still comes in recursively with its full child structure. Only its own ancestors are dropped.

```
<targetDir>/
  external@example.org/              share root (external owner)        ← meta
    notes - <id>.md                  a shared file: flat in the root
    Project X - <id>/                a shared folder: top level in root ← meta (share point)
      specs - <id>/
        api - <id>.md                children keep their structure
```

**Applies to:** owners or sharers outside `pathResolution.domains` (personal accounts, other organisations), and in-domain items when impersonation is off. An in-domain lookup that is attempted and fails also lands here for that run, but as an enumeration error: nothing is moved or deleted on its account (§4.2, §6.5). The rule is the same in every case; external owners are just the common one.

**Share root identity:** the owner's email (`owners[0].emailAddress`), verbatim and lowercased like any other identity. If the owner isn't visible (e.g. a file in another organisation's shared drive, which has no personal owner), the root is the **sharer's** email (`sharingUser.emailAddress`). If neither is visible, the root is `unknown-owner`, and the run report flags it.

**Placement uses the sync account's own view of the tree.** Each item is placed under its _highest ancestor that the sync account can see_, which is always a shared item:

- A file reachable only through its own share → `<root>/<file>`.
- A folder share → `<root>/<folder>/…`, recursively.
- A file shared on its own **and** inside a shared folder from the same owner → placed under the folder (`<root>/<folder>/…/<file>`). The tree is canonical, so the item appears once, under its fullest visible path.
- Two separately shared folders where one is inside the other → the inner one nests under the outer one. the sync account can see that parent link because it has access to the outer folder.

**Metas:** the share root (`<root>`) and each share point as usual. For a file share the share point is the root itself, so it's seeded once. For a folder share it's `<root>/<folder>`.

**Collisions:** none possible; every segment carries its Drive ID (§3.1).

**Path changes are just moves.** If an external owner later shares a parent folder, the items under it move into that folder (§6.2 move, no re-download). If they un-share it, the items move back to the root or disappear, whichever the snapshot says.

Records carry `pathResolved: false` so the README and run report can tell external placement apart from real paths.

### 4.4 Enumeration

Each run, as the sync account:

**Source rule (Q5, resolved):** only items shared to the account are sources. A shared file is synced. A shared folder or shared drive is synced recursively, with all its descendants. Nothing else the account could technically reach is synced: domain-wide "anyone at example.com" link sharing, items the sync account owns, or other content in a drive when only one file in it was shared. (A shared drive is shared to someone by adding them as a member, so membership is that drive's share.)

1. `files.list q="sharedWithMe and trashed=false"` (all drives), paging. (Shortcuts in the account's own My Drive are ignored: a shortcut target that is shared with the account already appears here.)
2. `drives.list` → each shared drive the account was added to becomes a share (share point = share root = drive root).
3. For every shared folder and shared drive, list descendants recursively with `'<folderId>' in parents and trashed=false`. This is how folder contents are found: descendants of a shared folder do not appear in `sharedWithMe`.
4. Deduplicate by file id. An item reachable through two shares (a folder share plus a separate share of a file inside it) is stored once, under its real path; both share points are seeded.

Field masks are explicit so list calls stay cheap. **Performance (measured):** each gog call costs ~0.6 s wall (process spawn + token), so folder listing is **batched**: one query covers many folders (`'a' in parents or 'b' in parents or …`, chunked to stay under query-length limits; 3 parents measured at ~1.0 s), breadth-first, level by level. Ancestor lookups for path resolution are cached per run. If enumeration ever dominates the budget, the escape hatch is minting one token per run and calling REST directly (gog supports `--access-token`); not needed at current scale. All calls go through `gogWithRetry` (`gog --readonly --account <acct> drive ls --query … --fields … --all`).

### 4.5 Share acceptance

Google Drive needs **no acceptance step** for ordinary shares. Access is granted the moment the share is made, and the item appears in the recipient's "Shared with me" (that's what `sharedWithMe` queries), whether or not the notification email is read. Adding a member to a shared drive is likewise immediate. Ownership transfers _do_ require acceptance, but they're irrelevant here.

**Confirmed (spike):** in-domain, external (gmail.com) and shared-drive shares all arrived with no acceptance step.

**Shared drives and non-members.** A shared drive only lets its items be shared with non-members if the drive's setting **"Allow people who aren't shared drive members to access files"** is on (it's off in some drives; the admin console sets the default). Since only items _shared to_ the account are sources (Q5), that setting must be on for any drive whose items should reach the assistant without making it a member. This goes in the README's onboarding section.

Things that can still stop a share from arriving:

- **Workspace sharing policy.** The admin console can restrict which external domains users may receive files from, or block external receipt entirely. External shares (§4.3) depend on it. (Open on this instance.)
- **Drive spam handling.** Drive can divert shares from unknown external senders to a Spam view. Whether those still appear in a `sharedWithMe` query is unverified.
- **Link-only access** ("anyone with the link") is not a share to the account and never appears in `sharedWithMe` unless opened. Out of scope per Q5 anyway.

## 5. Conversion

Decided per file by MIME type, then extension. All tables are config with the defaults below.

| Class | Detection | Method |
| --- | --- | --- |
| Native text | `text/*`, `application/json`, `application/xml`, `application/x-yaml`, `application/javascript`, … plus an extension allowlist (`.md .txt .ts .py .sql .csv .yaml …`) for `application/octet-stream` uploads | download bytes as-is; not valid UTF-8 → skipped (`invalid-utf8`) |
| Google Doc | `application/vnd.google-apps.document` | Drive export `text/markdown` (`gog drive download --format md`) |
| Google Sheet | `…google-apps.spreadsheet` | Sheets API values per tab → one `##` section + Markdown table per tab (Drive's CSV export only returns the first tab). Size each table from the **returned values**: `gridProperties` reports the default 1000×26 grid, not the data extent. Rows come back ragged (trailing empty cells omitted), so pad to the widest row. Caps: `conversion.sheets.maxRowsPerTab` (default 5,000) and `maxCellChars` (default 2,000); truncation is noted in the output |
| Google Slides | `…google-apps.presentation` | Drive export `text/plain` (`gog drive download --format txt`), written as-is, with no per-slide headings |
| PDF | `application/pdf` | `pdf-parse` (already a dependency; the domain's own `pdfToText` in `lib/convert.ts`) |
| Word | `.docx` | `officeparser` → Markdown (the same path as the other Office formats; `mammoth` is not used here) |
| Excel | `.xlsx` | `read-excel-file` → tables per sheet (dates as ISO 8601, formulas as their cached result) |
| PowerPoint, ODF, RTF | `.pptx .odt .ods .odp .rtf` | `officeparser` → Markdown (OCR off). Legacy `.doc/.xls/.ppt` are skipped |
| Everything else | images, media, archives, Drawings, Forms, … | **skipped**, counted in the report |

- Converted output gets YAML frontmatter: `source: google-drive`, `driveFileId`, `driveUrl`, `mimeType`, `owner`, `sharedBy`, `modifiedTime`, `drivePath`. Native text files are written byte-for-byte with **no** frontmatter (it would corrupt code/config); their provenance lives in the sync state.
- `maxFileBytes` (default 25 MB) skips oversize blobs (`oversize`), checked against Drive's `size` before downloading. Google-native `size` is a placeholder (always 1024 in the spike) and is ignored.
- **Empty exports are normal** (an empty Doc exports as 0 bytes): write an empty `.md` (plus frontmatter); don't treat it as a failure.
- **Drive export limit:** `files.export` (Docs → Markdown, Slides → text) fails for exports over **10 MB**, and Google-native files have no `size` to pre-screen. An export-too-large error is a **permanent skip** (`export-limit`), not a retry. It's re-evaluated only when the file's content key changes (§6.2).
- Other converter or download failures follow the failure policy in §6.4 (backoff, then park). They never delete an existing good copy.
- New npm dependencies are repo-local (`npm install` in the scripts repo), not global.

## 6. Change detection and reconciliation

### 6.1 State

**Where it lives:** the jeeves-runner SQLite database (`JR_DB_PATH`, `/opt/jeeves/state/runner/runner.sqlite` on managed instances), through the runner client's state API (`getRunnerClient()`). This is the same store the email, calendar and Linear scripts use. Nothing goes in the content tree, which the watcher indexes, and there are no sidecar files.

| Runner state | Namespace / key | Item key | Value |
| --- | --- | --- | --- |
| **File ledger** (collection) | `google-drive` / `files:<account>` | Drive file id | JSON record below |
| **Run summary** (scalar) | `google-drive` / `run:<account>` | n/a | last run's counts, queue depth, oldest `pendingSince`, errors |

One ledger record per Drive file _in the snapshot_, both written and pending:

```json
{
  "localPath": "alice@example.com/a - k3v7q2xm/b - p5zr2a7d/c - m2xq7b4n.txt",
  "written": {
    "contentKey": "md5:…",
    "modifiedTime": "…",
    "kind": "text",
    "at": "…"
  },
  "skipped": null,
  "pendingSince": null,
  "attempts": 0,
  "lastError": null,
  "retryAfter": null,
  "parked": null,
  "pathResolved": true,
  "shareIds": ["<shared file or folder id>"]
}
```

- `written` is null until the first successful write. `contentKey` is the change-detection key (§6.2): `md5:<md5Checksum>` for blobs; for Google-native files `rev:<latest revision id>` when revisions are readable, else `mt:<modifiedTime>`. The record also keeps `modifiedTime` as `written.modifiedTime`, the cheap first-stage filter, and the conversion `kind` (`text`, `pdf`, `gdoc`, …) it was written with. The schema is `LedgerRecordSchema` in `lib/ledger.ts`. The derived queue (§6.4) is "snapshot items whose remote content key ≠ `written.contentKey`, and which aren't skipped or parked".
- `parked`: `null`, or `{ "key": "<content key>" }` once an item has failed `budget.maxAttempts` times. A parked item is retried only when its content key changes.
- `skipped`: `null` or one of `non-convertible`, `oversize`, `export-limit`, `invalid-utf8`, `path-too-long`, with the content key it applied to. A skipped item stays in the ledger and is re-evaluated only when its content key changes, so skip decisions aren't re-downloaded every run.
- Each run loads the whole ledger (`listItemKeys` + `getItem`; local SQLite, so thousands of records cost milliseconds), diffs it in memory, and writes back only the records that changed (compared key-order-independently), so an idle run writes nothing. Moves and downloads persist their record immediately, one at a time. Records for items that left the snapshot are deleted (`deleteItem`) once their local file is gone.
- What is **not** stored: the remote tree (rebuilt every run), seeded metas (a `.meta/` on disk is the truth), and the queue itself (derived).

**Losing the state is safe.** With an empty ledger, every snapshot item looks new: the sync re-downloads everything (budgeted), overwriting the same paths, and the owned-tree rule (§6.5) prunes any file or directory outside the tree. Cost: one full re-download. Data: none lost. Forcing a full refresh: `sync.ts --reset-state [--account <acct>]`. A plain `deleteState` **does not work**: `state_items` has a foreign key to `state` with no `ON DELETE CASCADE`, and the runner enforces foreign keys, so deleting the parent row while items exist fails. No runner tool clears a collection either. `--reset-state` therefore `deleteItem`s every key from `listItemKeys`, then `deleteState`s the parent and the run summary. It refuses to run without `--live` (dry run prints the count).

### 6.2 Plan (pure function, unit-tested)

Each run builds the remote snapshot (§4.4, metadata only) and diffs it against state:

| Remote vs state | Action |
| --- | --- |
| New id, convertible | download/convert → write |
| Same id, **content key** changed (`md5Checksum` for blobs; latest revision ID for Google-native, see below) | re-download → overwrite |
| Same id, same content key, different computed path (rename, move, ancestor rename) | **move** the local file, no download |
| Same id, unchanged | nothing |
| Id in state, absent remotely (deleted, trashed, **un-shared**, moved out of a shared folder; see §6.2.1) | delete local file; prune empty directories |
| Item became non-convertible / oversize | delete local copy, record as skipped |

Writes are atomic: temp file in the staging directory, then `rename` into place (§6.5). The plan is computed fully before anything is applied.

**Why not `version`:** Drive's `version` increments on _any_ change, including renames and sharing changes (the spike saw a folder's `version` move with `modifiedTime` unchanged). Content keys change only when content does.

**Google-native content key: two-stage check (spike §8).** A rename bumps a Google file's `modifiedTime` (confirmed), so `modifiedTime` alone would re-export on every rename. But the latest **revision ID** doesn't change on a rename. So:

1. `modifiedTime` unchanged → unchanged. No extra call.
2. Changed → `revisions.list` (paged to the last revision) → latest revision ID equals `written.contentKey` → **metadata-only change**: move/rename locally, no export, and update `written.modifiedTime`.
3. Revision ID changed, or revisions unreadable (`capabilities.canReadRevisions` false, e.g. possibly Viewer-only shares) → re-export.

The revision call is made only for Google files whose `modifiedTime` moved, so a quiet run costs nothing extra.

### 6.2.1 Un-shares

An item that is no longer shared with the sync account is deleted locally, exactly like a Drive deletion. The rule is **access-based**: the local copy exists if and only if the item is in this run's remote snapshot. Each run enumerates the full set of shares (§4.4), so the sync never has to be told what was unshared. Anything it tracks that is missing from the snapshot gets removed.

| Un-share event | Effect |
| --- | --- |
| Single shared file un-shared | that file is deleted locally |
| Shared folder un-shared | every descendant under that share is deleted locally; empty dirs pruned |
| One file inside a shared folder has the account's access removed (folder still shared) | only that file is deleted |
| Sync account removed from a shared drive | every item synced via that drive membership is deleted |
| Item moved out of a shared folder into an unshared location | treated as an un-share: deleted |
| Item un-shared through one path but still reachable through another (direct share + folder share, or group membership) | **kept**. It is still in the snapshot, and the path is recomputed if its share changed |

- Shares made to a Google Group the account belongs to count as shares; losing group membership counts as an un-share.
- `shareIds` in state records which shares make each item reachable, for diagnosing why an item is (or was) mirrored. The run report lists removals by path only; it doesn't attribute them to a share.
- Un-share deletions count toward the mass-deletion guard (§6.5). Un-sharing a large folder that trips the guard gets reported, and the deletions wait until the next run or an explicit `--allow-mass-delete` run.
- If the optional `changes.list` fast path (§6.3) is ever added, lost access shows up as `removed: true` / no `file` on the change and maps to the same delete action. The periodic full reconcile still backstops it.
- Directories and `.meta/`s left without any providing share are removed with their branch (§7).

### 6.3 Cost

A no-change run costs one list call per page of `sharedWithMe`, one per shared folder (per page), plus the cached ancestor lookups for path resolution. **Zero downloads.** Downloads happen only for new or changed files.

A later optimisation, if enumeration gets expensive: Drive `changes.list` with a persisted page token as the fast path, with the full reconcile above kept as a periodic (e.g. daily) safety net. Not in v1 unless you want it.

### 6.4 Work queue and run budget

Enumeration, planning, deletes and moves are cheap, so every run does them in full. Downloads and conversions are expensive, so each run takes a bounded bite and leaves the rest for the next run.

**The queue is derived, not stored.** The pending work is "every file in the snapshot whose remote content key differs from what was last written locally (or that has never been written), excluding skipped and parked items". It's recomputed from scratch each run by the same diff as §6.2. That makes it self-editing:

| Change while an item is pending | Effect on the queue |
| --- | --- |
| File edited again | still pending, now targeting the newer version (the intermediate version is never fetched) |
| File deleted or un-shared | drops out of the queue; any older local copy is deleted |
| File renamed or moved | still pending, under its new path |
| File becomes non-convertible or oversize | drops out, recorded as skipped |

No queue entries are ever edited, deduplicated or invalidated, because none are stored. This is also why the runner's `enqueue`/`dequeue` queues are the wrong tool here: they're FIFOs of frozen payloads that would go stale exactly as described above.

**What is stored per pending item** (in the §6.1 state record): `pendingSince` (first run it was seen pending, for ordering and reporting), `attempts`, `lastError`, `retryAfter`.

**Budget.** One budget for the whole run (`googleDrive.budget`, §8), shared by every sync. Each run processes pending items in order until any limit is reached: `budget.maxSeconds` (default **360**, measured from **process start** so enumeration counts against it; the runner doesn't pass the job's schedule to the script), `budget.maxItems` (downloads attempted), `budget.maxBytes` (bytes written). Item and byte counts accumulate across syncs, so a later sync gets what the earlier ones left. Validation: `maxSeconds ≤ timeout_seconds − 60`. The limit is checked before each item starts, so a run overshoots by at most one item. A file whose download alone exceeds the budget still gets processed once it reaches the head of the queue. `maxFileBytes` (§5) caps how bad that can be. The job's `overlap_policy: skip` is the backstop if a run overruns anyway.

**Multiple syncs.** `syncs[]` entries run sequentially in one process and share the run budget. They run oldest `lastRunAt` first (stored in the run-summary state); once the budget is spent no further sync starts, and the skipped ones keep their older `lastRunAt` and go first next run, so none starves.

**Timeout and SIGTERM.** The manifest sets `timeout_seconds: 720`. On timeout the runner sends `SIGTERM`, then `SIGKILL` 5 s later. The script handles `SIGTERM` by finishing the item in flight, taking no new items or syncs, writing the run summary, and exiting. An item that can't finish inside the 5 s window is lost to `SIGKILL` with its staged temp file, which the next run's staging wipe removes. Ledger records are written per item as each one completes, so even a hard kill loses at most the in-flight item, which is simply re-fetched next run.

**Order** _(confirmed)_. (1) Updates to files that already have a local copy, oldest `pendingSince` first, because a stale copy is worse than a missing one and these are usually few. (2) New files, newest `modifiedTime` first, so a large initial share doesn't hold up what people are working on today. Items in `retryAfter` backoff are skipped.

**Failures.** A failed download or conversion increments `attempts` and sets exponential backoff. After `budget.maxAttempts` (default 5) the item is **parked**: it's reported every run and not retried until its content key changes. That keeps one poison file from eating every run's budget.

**Interaction with the tree (§7).**

- Pending _new_ files count as part of the desired tree, so their directories aren't pruned out from under them while they wait.
- A pending _update_ leaves the previous local copy in place until the new one lands. The copy is stale for a while but never missing.
- A share point is seeded only once it holds at least one written file, so meta's first synthesis has something to read.

**Reporting.** The runner keeps only the last 100 stdout lines and parses `JR_RESULT:{json}` lines for `meta`. So per-item logging stays sparse, and every run **ends with one `JR_RESULT` line** whose `meta` is a compact summary: queue depth (updates / new / parked), processed, bytes, elapsed, oldest `pendingSince`, deletions, guard trips, unresolved roots, held locks. That makes it visible in `runner_runs`. Full detail (parked item list, unresolved items, guard-blocked deletions) goes in the `run:<account>` state entry (`runner_query_state`).

**Exit codes.** A non-zero exit fires the job's `on_failure` Slack notification, so it's reserved for conditions that need a human:

- invalid config; auth or credential failure; enumeration failure;
- **mass-deletion guard tripped** _(decided 2026-10-05)_.

Exit 0, with warnings in `JR_RESULT`: parked items, unresolved paths, held meta locks, skips.

### 6.5 Safety

- **Dry run by default.** The script prints the plan and changes nothing, on disk **or in runner state** (no `setItem`/`deleteItem`/`setState`, no meta seeding), unless invoked with `--live`. The job manifest passes `--live`, so `runner_trigger` always runs live. A dry run is a manual `tsx` invocation with the runner DB path set: `JR_DB_PATH=/opt/jeeves/state/runner/runner.sqlite tsx src/google-drive/sync.ts`.
- **Mass-deletion guard.** Deletions (files and `.meta/` directories) are skipped for the run if enumeration hit any error, or if they would exceed **both** `deletion.maxFraction` (default 20%) of the files currently under `targetDir` **and** `deletion.minCount` (default 25) files. The min-count stops small mirrors tripping on routine un-shares. A trip exits non-zero (alert) and lists the blocked deletions in the run-summary state. When the guard trips only on size, additions, updates and moves still apply.
- **Enumeration errors hold moves too.** An enumeration error (a failed folder listing, or a failed path or drive-name lookup, §4.2) means the snapshot may place items wrongly, not just omit them. So such a run also applies **no moves**: a written copy whose desired path changed stays where it is, its directories stay in the desired tree, and any pending update to it waits (it would otherwise be written at the new path). Held moves are listed (`HOLD` lines, `heldMoves` in the summary) and applied by the next clean run. Additions at paths that don't displace an existing copy still apply.
- **`--allow-mass-delete`:** a manual `--live` run with this flag applies guard-blocked deletions (never deletions caused by an enumeration error). It's for when an operator has confirmed a large un-share is intended.
- **Temp staging.** Downloads and conversions are written to a staging directory **outside the content tree**, `<JEEVES_BASE_DIR>/state/google-drive/tmp/<account>/`, then `rename`d into place. The watcher never sees partial files. `rename` is only atomic within one filesystem, so startup verifies that staging and `targetDir` share a device (`stat().dev`) and fails with a config error otherwise. Startup also clears leftover staging files.
- **Owned-tree guard.** `targetDir` is wholly owned by the sync, and nothing else should write there (the README says so). The sync only deletes or moves paths inside `targetDir`. Any file there that isn't in the desired file set (§7.1) is deleted, whether or not it's in state, so stray or orphaned files can't survive. Directories, including their `.meta/`, are deleted only when they fall out of the canonical tree (§7.2). A `.meta/` inside a directory that's still in the tree is never touched. `targetDir` itself is never deleted.
- **Meta deletions are guarded too.** Removing a `.meta/` loses its synthesis history, so `.meta/` removals count toward the mass-deletion guard. A directory whose `.meta/.lock` exists is skipped, and retried on the next run, if the lock is younger than `meta.lockStaleMinutes` (default 30, matching jeeves-meta's own `STALE_TIMEOUT_MS` in `lock.ts`). An older lock is reported as possibly stale (an operator can clear it with `meta_unlock`) and still skipped. The sync never removes a lock itself. _(Checked in jeeves-meta source, 2026-10-05: discovery (`listMetas`) is cached for 60 s, so a removed `.meta/` drops out within a minute. A synthesis already queued for it fails inside the queue's error handler, so it's logged and doesn't crash the service; this was read in the source, not reproduced. The lock file carries PID + `startedAt` and counts as stale after 30 min.)_

## 7. The canonical tree and its metas

**Principle (Q4, resolved):** the _tree_ is canonical, not any individual share. Shares are just how the tree gets populated. They can overlap, nest, or duplicate each other, and each one may contribute metas in a different part of the tree. Every directory and every `.meta/` lives exactly as long as some current share provides its part of the tree.

### 7.1 Building the tree

Each run computes, from the remote snapshot alone:

- **Desired files** `F`: the local path of every item in the snapshot that has a **written** local copy and isn't skipped (union over all current shares, deduplicated by file id). Pending items aren't in `F`: a pending update keeps its old copy at its current path (in `F` via that path), and a pending new item has no file yet.
- **Desired directories** `D`: every ancestor of a path in `F`, plus every ancestor of each pending new item's target path, so directories aren't pruned from under queued work. A directory exists only while something written or queued lives in its subtree. A shared folder holding nothing convertible therefore has no local directory and no meta.
- **Desired metas** `M`: for every current share, its **share root** (`<targetDir>/<owner-or-drive>`) and its **share point** (§3), **seeded once their subtree holds at least one written file**. Root and share point coincide for shared drives, for external file shares, and for top-of-My-Drive items, so they're seeded once.

`F`, `D` and `M` depend only on what is currently shared. They don't depend on history or on which share arrived first.

### 7.2 Reconciling the tree

| Local state | Action |
| --- | --- |
| File under `targetDir` not in `F`, whether or not it's in state | delete (§6.2, §6.5 owned-tree guard) |
| Directory under `targetDir` not in `D` | delete the **whole directory, including its `.meta/`** |
| Path in `M` without a `.meta/`, whose subtree has a written file | seed it (`POST /seed`) after the files are written, so the first synthesis has content |
| Directory in `D` with a `.meta/` that no current share calls for (seeded by a share that's since gone, but the branch is still provided by another share) | **keep it**. The branch still exists, so its meta stays with it _(confirmed 2026-10-05)_ |

So un-sharing a branch that no other share provides removes the branch and every meta inside it. Un-sharing a branch that another share still covers removes nothing: the tree hasn't changed.

**Worked example.** Alice shares folder `a/b` and, separately, file `a/b/c/d.txt`. The tree has metas at `<alice>`, `<alice>/a/b` (folder share point) and `<alice>/a/b/c` (file share point).

- Alice un-shares the file: `d.txt` is still in the tree via the folder share, so nothing changes. The meta at `a/b/c` stays because `a/b/c` is still in the tree.
- She then un-shares the folder too: no share provides anything under `a` any more, so `<alice>/a` (and with it `a/b`, `a/b/c` and their metas) is removed. If that was Alice's last share, `<alice>/` and its root meta go too.
- If instead he had un-shared only the folder: `a/b/c/d.txt` is still shared, so `a/`, `a/b/`, `a/b/c/` stay in `D`. The other files under `a/b` are deleted, and the metas at `a/b` and `a/b/c` stay because both directories are still in the tree.

### 7.3 Seeding mechanics

- Seeding uses the meta service `POST /seed` (`{ path, steer? }`), the same endpoint the `meta_seed` tool calls. It returns **201** on create and **409** if `.meta/` already exists (jeeves-meta `routes/seed.ts`), so 409 is treated as success. A path that already has a `.meta/` on disk isn't sent at all.
- Steer prompts are config, with generic defaults for roots ("documents shared by <identity>" / "shared drive <name>") and for share points.
- A seeded meta that was later deleted (its branch disappeared) and is shared again is re-seeded fresh. Its old synthesis history is gone, by design.

## 8. Configuration

A new optional `googleDrive` block in `pipeline-config.json`, documented in the template. The shared loader (`src/lib/pipeline-config.ts`) carries it unvalidated; the domain validates it (`src/google-drive/lib/config.ts`) when the job starts. So a mistake in the block fails only this job, never the other jobs that load the config, and `src/lib/` doesn't depend on the domain. Absent block → the job logs `[skip]` and exits 0. Per-instance values (accounts, domains) have **no defaults**, per the template rules.

```json
"googleDrive": {
  "budget": { "maxSeconds": 360, "maxItems": null, "maxBytes": null, "maxAttempts": 5 },
  "syncs": [
    {
      "account": "assistant@example.com",
      "targetDir": "google-drive",
      "pathResolution": {
        "impersonate": true,
        "domains": ["example.com"],
        "sharedDriveFallbackIdentity": null
      },
      "exclude": ["**/node_modules/**", "**/*.lock"],
      "maxFileBytes": 26214400,
      "conversion": {
        "textMimeTypes": [], "textExtensions": [], "skipMimeTypes": [],
        "sheets": { "maxRowsPerTab": 5000, "maxCellChars": 2000 }
      },
      "meta": { "seed": true, "rootSteer": null, "sharePointSteer": null, "lockStaleMinutes": 30 },
      "naming": { "maxNameBytes": null, "maxPathBytes": 4000 },
      "deletion": { "maxFraction": 0.2, "minCount": 25 }
    }
  ]
}
```

- `budget` is top-level: one budget for the run, shared by every sync (§6.4). A `budget` inside a sync entry is a validation error that points at `googleDrive.budget`.
- `syncs` is an array so one instance can mirror more than one account, each to its own `targetDir`.
- `targetDir`: relative paths resolve against `CONTENT_DIR`; default `google-drive`. Either way it must resolve to a **strict subdirectory** of `CONTENT_DIR`: outside it nothing indexes the files, and `CONTENT_DIR` itself would hand the whole content tree to the owned-tree deletion rule. Validation fails otherwise.
- `conversion.*` arrays **extend** the built-in tables rather than replace them.
- `exclude` globs match the item's **Drive path** (`<root>/<folder>/…/<name>`): untagged and untruncated, so stable under tag and truncation rules, but **sanitized** (§3.1: a `/` or `:` inside a Drive name becomes `_`), so path segments are unambiguous. Matching uses POSIX glob semantics on every platform. An excluded item is treated as absent: not synced, and deleted if previously synced.
- There is no `sources` block. Q5 defines the source rule (items shared to the account, recursed), so there's nothing to toggle.
- `budget.maxSeconds` must be ≤ the job's `timeout_seconds` − 60. The script can't read the manifest, so the README states the pairing and the default (360 / 720) satisfies it.

Example: `account: "assistant@example.com"`, `domains: ["example.com"]`.

## 9. Code layout

```
src/google-drive/
  README.md              domain doc (behaviour lives here, not in a skill)
  sync.ts                entry point: runScript, prerequisite guard, --live/--dry-run
  lib/
    config.ts            googleDrive block → validated config (the domain validates it, not
                         src/lib/pipeline-config.ts); run budget schema
    drive-client.ts      thin gog wrappers: list, get, export, download, drives, revisions.
                         `--readonly` is hard-coded in the single spawn helper and asserted by a
                         unit test: it is the ONLY write guard (gog tokens carry full scopes, and
                         sharers routinely grant the account Editor)
    enumerate.ts         remote snapshot (§4.4)
    resolve-path.ts      ancestor walk + impersonation + per-run cache (§4.2-4.3)
    naming.ts            sanitization, ID suffixes, byte-budget truncation, ID parsing (§3.1)
    classify.ts          MIME/extension → conversion class (§5)
    convert.ts           per-class converters (reuses src/convert/lib)
    plan.ts              snapshot × state → actions (pure; §6.2); moves held on enumeration errors
    execute.ts           run budget shared across syncs; budgeted download queue (§6.4)
    apply.ts             atomic writes (Windows rename retry), moves, deletes, empty-dir prune, guards
    meta-seed.ts         POST /seed, idempotent
jobs/google-drive.json   job "google-drive-sync", every 13 min, overlap skip, timeout_seconds 720,
                         args ["--live"], prerequisite: "googleDrive block in pipeline-config.json;
                         sync account registered in gog; DWD grant covers gog's Drive + Sheets
                         scopes (VCS exclusion deferred: jeeves-watcher#253)"
```

Tests co-located for `naming`, `classify`, `plan` (including the §7 tree cases and the worked example), `resolve-path` (with a fake drive client), `config`. All files < 300 LOC, quality gates clean, instance-agnostic guard passing in the template PR.

### 9.1 `src/google-drive/README.md` (assistant-facing)

Same standard as the other domain READMEs (e.g. `email/`, `meetings/`). It is the authoritative behaviour doc, and the repo root README's domain table links to it. Required sections:

1. **Overview:** what it syncs, from where, to where, and what it never does (read-only, no write-back).
2. **Onboarding:** the per-instance setup steps in §11, in order, with exact commands, plus a verification for each step (e.g. `gog auth service-account status <account>`, then a read-only `sharedWithMe` list as the account).
3. **Configuration:** the full `googleDrive` block, field by field, with defaults and validation rules.
4. **Data flow:** a mermaid diagram covering enumerate → resolve paths → plan → apply → seed.
5. **Output layout and naming:** §3 rules, ID tags and the tag one-liner, extension rules, frontmatter fields.
6. **Conversion matrix:** §5, including what is skipped and why.
7. **Tree, shares and metas:** the §7 principle and worked example, so a future assistant doesn't "helpfully" keep orphaned metas or delete live ones.
8. **State:** the runner collection and scalar keys, their shape, and how to reset them (`--reset-state`, never a bare `deleteState`; a reset just causes one full re-download).
9. **Running:** dry run (with `JR_DB_PATH`) vs `--live`, `--allow-mass-delete`, `--reset-state`, the `JR_RESULT` summary, exit codes and what alerts, `timeout_seconds` vs `budget.maxSeconds`.
10. **Jobs:** the manifest entry and its prerequisite.
11. **Troubleshooting:** common failures (no mailbox registered, DWD scope missing → `unauthorized_client`, unresolvable paths, converter failures, mass-delete guard tripped, held `.meta/.lock`) with the exact diagnosis command for each.
12. **Key files:** a module table.

## 10. Rollout

1. Prerequisites (§11).
2. **Spike: done 2026-10-05**, see the originating instance's spike notes. Untested and optional: group shares, spam-diverted external shares, Viewer-only revision readability. Original checklist:
   - what `parents`, `owners`, `sharingUser`, `driveId` return for a nested-file share, a folder share, a shared-drive item and an external share; and that owner impersonation resolves the path;
   - the shared-drive ID `Uk9PVA` ending;
   - whether a rename bumps `modifiedTime` on Google-native files (§6.2);
   - which OAuth scopes gog requests for Drive and Sheets via the service account (§11);
   - whether group shares and spam-diverted external shares appear in `sharedWithMe` (§4.5, §6.2.1);
   - Docs Markdown export and per-tab Sheets reads on real files. Pre-implementation source check: jeeves-meta's behaviour when a meta directory disappears (§6.5).
3. Implement on a branch in the instance repo; dry runs against real shares; review plan output.
4. PR → review → merge; (VCS exclusion deferred, §11); register the job with `runner_create_job` (absolute script path; deploy skips manifests with a prerequisite); first live run.
5. Hoist to `jeeves-scripts-template` (template PR first, then mirror), per the template's hoisting rules.

## 11. Onboarding (per instance) and current prerequisites

These steps go into the README's Onboarding section (§9.1), written generically. The first is the key one: without it the sync account has no identity in gog and can't see what is shared to it.

1. **Register the assistant's own Workspace account with gog** using the instance's existing DWD key (deploy writes it to `<GOG_CONFIG_DIR>/service-account.json`): `gog auth service-account set <assistant@example.com> --key <GOG_CONFIG_DIR>/service-account.json` Verify: `gog auth service-account status <assistant@example.com>`, and `gog auth list` shows it.
2. **Confirm the DWD grant** on the service account's Client ID covers the scopes **gog requests** (pinned in the spike via `gog auth services`): `https://www.googleapis.com/auth/drive` and `https://www.googleapis.com/auth/spreadsheets`, **full scopes**, since gog has no read-only variants. DWD grants are per client and apply to every impersonated user. Read-only behaviour is guaranteed only by `gog --readonly` (§9). **Why only these two:** Docs and Slides are _exported through the Drive API_ (`gog drive download --format …`, which runs under gog's `drive` service: confirmed with `-v` → `serviceLabel=drive`), so they need no `documents` or `presentations` scope. Sheets is the only non-Drive API the sync calls (per-tab values, `serviceLabel=sheets`), hence `spreadsheets`. Forms, Drawings and Sites are skipped, so they need nothing. If a future version used the Docs/Slides APIs directly (e.g. for richer structure), it would add `documents` / `presentations`. For shared drives whose items should reach the assistant, make sure the drive's "Allow people who aren't shared drive members to access files" setting is on (§4.5).
3. **Add the `googleDrive` block** to `pipeline-config.json`.
4. **Exclude `targetDir` from watcher version tracking** (`watcher_vcs_exclude`) _(decided 2026-10-05; **deferred**)_: Drive is the system of record, and versioning the mirror would duplicate its revision history and grow the content repo. **But** `vcs/exclude` writes a `.gitignore`, which the watcher's `respectGitignore` also applies to indexing, so the exclusion de-indexes the mirror (found in the first live run). Deferred until [jeeves-watcher#253](https://github.com/karmaniverous/jeeves-watcher/issues/253) adds a VCS-only exclusion.
5. **Dry run**, review the plan, then **register the job** (`runner_create_job`).
6. **Ask people to share** files, folders and shared drives with the assistant's address. Sharing is the whole interface.

Follow-up outside this repo: the jeeves onboarding checklist (Phase 4, Google Workspace) should gain step 1 for every instance, and its §3.4 scope list should include the Drive scopes. I'll raise that against jeeves-tools once the design settles.

**Verified on the originating instance:** sync account registered in gog; the DWD grant covers full `drive` + `spreadsheets`; external receipt open in the Admin console; non-member access on for a test shared drive.

## 12. Open questions

- ~~Q1. Path resolution by impersonation~~: **yes** (§4.2).
- ~~Q2. Identity directory name~~: **verbatim email** (§3.1).
- ~~Q3. Unresolvable paths~~: **external shares go in the share root**, and shared folders keep their child structure (§4.3).
- ~~Q4. Share removed~~: **the tree is canonical.** A branch no other share provides disappears with its metas (§7).
- ~~Q5. Shared drives~~: **only items shared to the sync account**, with folders and shared drives recursed (§4.4).
- ~~Q6. Shared-drive root naming~~: **dissolved** by ID suffixes (§3.1).
- ~~Q7. Google Sheets~~: **every tab**, via the Sheets API (`spreadsheets.readonly`).
- ~~Q8. Cadence~~: **every 13 minutes** (prime, per house convention).
