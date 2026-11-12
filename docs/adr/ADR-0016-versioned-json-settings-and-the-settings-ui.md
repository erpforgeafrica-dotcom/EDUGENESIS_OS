# ADR-0016 — Versioned JSON settings inside the project, edited by a local Settings UI served by `eg serve`

- **Status:** Accepted
- **Owner:** Chief Systems Architect, with the Security Officer accountable for the secret handling rules
- **Date:** 2026-11-12
- **Governed by:** Product law — portability and the Settings surface (GLOBAL.md §9); Document 2 §7.4 (secrets and key rotation); Document 1 v1.2 (zero cost to learners).

## Context

The product law for EduGenesis OS is that this folder must run identically on
any Windows PC it is copied to — a different user name, a different drive
letter, a different Node install — and that a non-technical person must be
able to change the server port, the data folder, the feature toggles and the
provider API keys without editing source.

That requirement rules out most of the usual answers:

- **Settings in the user profile** (`%APPDATA%`, `~/.config`) do not travel
  with the folder. The copy is incomplete, and the settings belong to the
  machine the owner happened to use before, not to the copy they just made.
- **Environment variables** are invisible to a non-technical user, cannot be
  edited by a UI, and leak into logs, crash dumps and process listings.
- **A `.env` file** has no schema, no validation and no UI. It is also the
  single most common way a secret reaches a git commit.
- **A local database for settings** makes the settings unreadable and
  un-diffable without running the application, and a configuration file you
  cannot read with a text editor is not a configuration file.

What is needed is a document that is versioned (so it can evolve), schema-checked
(so a typo is caught rather than silently ignored), stored inside the folder
(so it travels), and editable by a non-technical person (so it has a UI).

## Decision

**Settings are a versioned JSON document stored inside the project and edited
through a local Settings UI.**

- `settings/settings.schema.json` — a **JSON Schema (draft 2020-12)** describing
  every field of `EduGenesisSettings`, with `additionalProperties: false` and
  explicit `required` lists. It is the single source of truth for validation
  *and* for migration.
- `settings/settings.json` — the **committed default**. It matches
  `DEFAULT_SETTINGS` in `packages/contracts`, it contains **no secrets** (the
  `apiKeys` map is empty), and **the CLI never writes to it.** The store
  refuses to write that path.
- `settings/settings.local.json` — the **untracked local override**, gitignored
  by design. It is where `eg settings set` and the Settings UI write. The
  override is layered over the default; the default is never mutated.
- The schema is enforced on every read and every write. An invalid settings
  file is a hard error, not a warning.
- **Migration.** A settings file whose `schemaVersion` is older than the
  current one is migrated on load: missing keys are filled from the default,
  and unknown keys are **preserved under an `extra` key** and reported. Nothing
  is ever dropped silently.
- **`eg serve`** starts a local HTTP server on the configured host and port —
  `127.0.0.1` by default — and serves a **Settings UI** in plain HTML, CSS and
  JavaScript with no build step and no framework. It uses the Aurora design
  tokens shipped at `assets/edugenesis-tokens.css`, and it is keyboard
  operable with a visible focus ring.
- **Secrets are write-only.** The read endpoint returns only whether a key
  exists and how long it is. The write endpoint accepts a new value and never
  returns it. `eg settings` prints `set (••••••••, 12 chars)` — never the key
  itself. The server refuses any client that is not on the loopback interface.
- `eg settings` provides the same capability without the browser:
  `list`, `get <key>`, `set <key> <value>`, and `--settings <path>` for an
  alternate file.

## Consequences

**Positive**

- Everything the owner needs travels with the folder. Copying the folder
  copies the configuration, the data and the toolchain.
- The schema is one artefact, not two: it validates the file, drives the
  migration, and documents the legal values of every field.
- A secret cannot be committed by accident. The CLI refuses to write the
  tracked file, the tracked file must have an empty `apiKeys`, the secrets scan
  fails the build if a non-empty `apiKeys` appears in a tracked settings file,
  and the local override is gitignored.
- The Settings UI makes the product usable by a non-technical owner, which is
  the difference between a repository and a product.
- The UI is plain HTML and CSS with no build step, so it cannot rot through a
  stale bundle and it needs no front-end toolchain.
- Writes are atomic (temp file, then rename), so an interrupted write cannot
  truncate a settings file.

**Negative**

- There are two settings files to reason about: the committed default and the
  local override. `eg settings path` and `eg doctor` report which one is in
  effect.
- The override is a full copy rather than a patch, so a later change to the
  default does not reach a user who already has an override. The override must
  be regenerated or deleted to pick up a new default.
- The schema must be migrated by hand whenever the contract grows a field.
  Adding a field means bumping `schemaVersion`, updating the schema and
  updating the migration in `settings-store.ts`.
- Serving a UI over HTTP adds a local attack surface. It is mitigated by
  binding to loopback by default, refusing non-loopback callers, masking
  secrets on read and never storing them in the repository — but it is a
  surface that a pure CLI would not have.
- A key stored in plain text in the local override is protected only by the
  file system. On a shared machine that is a weaker guarantee than an OS
  credential store, and it is recorded here rather than glossed over.

## Alternatives considered

1. **Environment variables.** Rejected. No UI, no schema, invisible to a
  non-technical owner, and trivially leaked into logs and process listings.
2. **Settings in the user profile.** Rejected. It does not travel with the
   folder, which is the product law in one sentence.
3. **A `.env` file.** Rejected. Unstructured, unvalidated, invisible to a
   non-technical user, and the most common route by which a secret reaches a
   commit.
4. **Settings stored in the local database.** Rejected. The settings must be
   readable and diffable with a text editor, and must be readable before the
   application can start.
5. **YAML or TOML.** Rejected. JSON is already the interchange format of the
   frozen contracts and of the SBOM, and a second serialisation format would
   need a second parser and a second validation story.
6. **A settings UI built with a front-end framework and a bundler.** Rejected.
   It adds a toolchain, a build step and a supply chain to a product whose
   defining constraint is that it must install nothing, and a settings page does
   not need a component library.
7. **No UI — command line only.** Rejected. The product law requires a
   non-technical person to be able to change the port, the data folder, the
   toggles and the keys. A CLI is a developer's interface; the owner is not a
   developer.

## Revisit trigger

Reopen this decision when:

- settings need a per-user or per-device scope that a single in-folder document
  cannot express;
- a second consumer (the learner PWA) needs a different projection of the same
  settings document and the single-file model stops being the simplest answer;
- the OS credential store is judged safe enough to hold provider keys on
  shared machines, which would move secrets out of the settings file;
- the schema needs a construct outside the draft 2020-12 subset the validator
  currently implements.
