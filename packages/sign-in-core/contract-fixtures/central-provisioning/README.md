# Central provisioning producer fixtures

Consumer fixture copies from codex-router `13e69413bab1cf61378ece1a137cb9b2644be9b6`, `crates/collaboration-central-core/contracts/ProvisionOrganization*`. Producer source: `identity_contract/organization_provisioning.rs`. These copies use Switchboard formatting; their parsed JSON equals the producer objects. Do not rewrite the producer cases or schemas here.

POST `/internal/organization-provisioning` carries exactly `{organizationId, organizationStatement}`, where the statement is the natively signed compact JWS. Only HTTP 200 with exactly `{result:"provisioned"}` confirms setup or a renewal. 403 (organization mismatch), 409 (stale predecessor) and 422 (invalid statement) are refusals; every other status, a lost reply or a malformed 200 stays unknown. Error bodies are empty and never read. A renewal is the same call with a statement whose signed `replaces` names the stored stamp's digest.

POST `/internal/organization-statement-digest` carries exactly `{organizationId}` and answers 200 with exactly `{digest, expiresAt, signingKeyId}`: the lowercase hex SHA-256 of the stored statement, its `exp` in integer seconds and its header `kid`, all from the statement central has verified. 404 means unprovisioned; 503 means the stored statement failed its check. Central publishes no fixture file for this reply; the consumer's closed parser and its unit cases encode it.

These fixtures define parsing only. A recording peer that matches them earns no credit for central's stamp verification, replacement CAS or records; those are proven on central's side.
