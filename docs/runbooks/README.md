# Operations Runbook Index

Use these runbooks in order for a release:

1. [External integrations](external-integrations.md) provisions development
   credentials and sandbox resources.
2. [Deployment and rollback](deployment.md) provisions and deploys the control
   plane.
3. [Acceptance](acceptance.md) runs the release scenarios twice.
4. [Disaster recovery](disaster-recovery.md) configures backup and proves a
   clean restore.
5. [Controlled pilot](pilot.md) governs the initial task sample.

During operations use [operator recovery](operator-recovery.md). For suspected
compromise or outage use [incident response](incident-response.md). Every
command that changes durable state requires a named actor, a reason, and a
linked incident or task. Never paste credentials into a command, ticket, log,
or evidence record.

PXR-070 through PXR-073 are not complete merely because these instructions
exist. Their timestamped records, two sandbox acceptance passes, restore drill,
VPS reboot check, and owner signoff must be attached separately.
