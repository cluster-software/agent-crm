---
"@agent-crm/cli": minor
---

Rename `acrm merge <object>` → `acrm records dedupe <object>`.

Two reasons for the rename:

- **Avoid collision with lix's "merge" terminology.** lix's `mergeVersion` / `mergeVersionPreview` already mean "merge two branches / versions of the workspace" — a different operation from collapsing two duplicate rows. Having both verbs alive on the same surface was going to confuse docs and chat ("merge the records on this branch and then merge the branch").
- **Open a namespace for record-level operations.** Putting `records` at the front leaves room for the obvious siblings (`acrm records archive`, `acrm records restore`, `acrm records show <id>`, `acrm records list <object>`) without re-litigating the top-level command surface each time. Mirrors how `acrm import <source>` and `acrm auth <provider>` already group by capability.

Old:

```sh
acrm merge people --keep <id> --discard <id>
acrm merge people --keep <id> --discard <id> --dry-run --prefer discard
```

New:

```sh
acrm records dedupe people --keep <id> --discard <id>
acrm records dedupe people --keep <id> --discard <id> --dry-run --prefer discard
acrm records dedupe companies --keep <id> --discard <id>
```

Behavior is unchanged — all flags (`--keep`, `--discard`, `--prefer`, `--dry-run`) and the JSON result shape are identical. The implementation file moved to `src/commands/records.ts`; the programmatic export renamed `mergeRecords` → `dedupeRecords` (relevant only if you import it from outside the CLI).

`skills/acrm-query.md` updated to use the new command and to call out the verb choice explicitly so agents don't try to use `acrm merge` and then guess at SQL surgery.

**This is a breaking change for the CLI surface** — there is no shim under the old name. The merge command shipped in the previous release; anything wired against it (skills, scripts, CI) needs to switch to `acrm records dedupe`.
