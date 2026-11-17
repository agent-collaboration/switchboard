# Central authorization revision producer fixtures

Consumer copies from codex-router `c74b7792dc70f96d981e73c4018c5c2781bd1524`, `crates/collaboration-central-core/contracts/AuthorizationRevision*`. Switchboard formatting; their parsed JSON equals the producer objects. Do not rewrite the producer cases or schemas here.

`POST /internal/organization-authorization-revisions`, on the private link only, carries one closed, tagged body: `{kind: "organization", organizationId, revision, state, permissionPolicyDigest}` or `{kind: "person", organizationId, personId, subjectId, revision, state}`. Only HTTP 200 with exactly `{acknowledgedRevision}` (central's retained floor after commit) is an acknowledgement. 403 (wrong organization), 409 (conflict) and 412 (no organization floor yet) are refusals; 503, including an unstamped or untrusted Fleet, means retry. Error bodies are empty.

These fixtures define parsing only; a recording peer that matches them earns no credit for central's floor apply, conflict detection or ACK-after-commit.
