# Postmortem: EHR read-only outage, 29 Sep 2026

**St Brennan's General Hospital — Clinical Systems**
Severity: SEV-1 · Duration: 2h 47m (02:13–05:00) · Blameless review

## Impact
Clinicians on all wards could view but not update patient records. Medication administration was recorded on paper downtime forms; 1,140 entries had to be back-entered. No patient harm has been identified.

## Timeline
- 02:13 Storage array for the primary DB hits 100% capacity; DB switches to read-only.
- 02:21 First calls to service desk from A&E.
- 02:40 On-call DBA paged (alert went to an old rota, delaying response ~15 min).
- 03:55 Archived audit logs moved to secondary storage; space freed.
- 05:00 Write access restored after integrity checks.

## Root cause
Audit log retention was changed from 90 to 400 days in July to meet a records-retention request, but nobody re-forecast storage growth. Capacity alerts were set at 95%, which gave only ~40 minutes of warning at night-time write volumes.

## What went well
- Downtime procedures worked; wards switched to paper within 10 minutes.
- Integrity checks found no corruption.

## What went wrong
- Paging rota out of date.
- Capacity alert threshold too late to act on.

## Action items
| Action                                         | Owner        | Due     |
|------------------------------------------------|--------------|---------|
| Lower capacity alerts to 75% / 85%             | Infra        | 6 Oct   |
| Automate on-call rota sync from staff roster   | Service desk | 20 Oct  |
| Storage forecast for any retention change      | Data gov.    | ongoing |
