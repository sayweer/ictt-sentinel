# ADR 0007 — Evidence verification and CLI exit codes

Status: accepted for the Milestone 11 offline CLI surface.

Evidence integrity and protocol health are separate. A correctly reproduced CRITICAL proof
is valid evidence of a breach; verification must not turn it into exit 0.

| Exit | Meaning |
| --- | --- |
| 0 | Overall OK; or successful informational `init`, `--help`, `--version` |
| 2 | CRITICAL: deterministic breach |
| 3 | UNKNOWN: incomplete evidence, failed verification, incomplete replay or readiness |
| 4 | WARN: policy/liveness deviation |
| 5 | Invalid arguments, configuration, JSON or checkpoint |
| 6 | Internal error or handled cancellation |

The shell's generic exit 1 is reserved. Informational commands do not assert deployment
health. `check`, `replay`, `evidence export` and `evidence verify` preserve the protocol verdict;
only an OK evaluation can return zero. Failed verification returns UNKNOWN even when the
untrusted document claims OK or CRITICAL.

Machine output is versioned `ictt-sentinel/cli-output/v1` JSON on stdout. Human diagnostics use
stderr. Error messages do not echo arbitrary exception contents. Telemetry is disabled.

Evidence core uses NFC-normalised, sorted object keys and decimal bigint strings, with
`ictt-sentinel/evidence/v1` plus NUL as the SHA-256 domain prefix. Presentation metadata is
outside the digest. The complete ERC20 input, both gate results, rule projection and every
verdict field are replayed and compared. Missing references cannot verify successfully.

The CLI identifies its actual workspace runtime modules by artifact checksum. The
`artifact-addressed` buildCommit marker deliberately makes no Git commit claim. The source
lock document has a separate digest. Fictional fixtures declare their assurance mode and
fixed observation time. Offline verification reproduces that historical evaluation, not
current chain health. RPC honesty, operator attestations and external supply assumptions
are outside the offline verifier's trust boundary.

Files use a private directory, exclusive temporary creation, complete writes, file fsync,
rename and directory fsync. Cleanup applies only to the temporary file created by that call.
JSON and HTML publication are independently atomic; interruption can leave a complete JSON
without the matching HTML. Re-export rebuilds the projection. SIGKILL/power loss can leave a
private temporary file; the tool never sweeps unrelated temporary files.

Production collector integration remains blocked as recorded in `docs/milestones/11.md`.
This decision does not claim that live discovery, readiness or replay is implemented.
