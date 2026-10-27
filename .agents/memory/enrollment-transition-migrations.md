---
name: Enrollment transition migrations
description: Compatibility rules for retaining ended enrollments while enforcing active-only uniqueness.
---

Enrollment transfer and promotion preserve ended rows, so uniqueness for student/year and admission/year applies only to active rows. Any seed upsert targeting those indexes must include the matching `WHERE status = 'active'` predicate; PostgreSQL cannot infer the partial index from the old full-constraint target.

**Why:** Replacing the full unique constraints is necessary to transfer a student within the same year without deleting or overwriting the former enrollment. The development seed and migration bookkeeping must evolve with that constraint change.

**How to apply:** For enrollment lifecycle changes, add a new numbered migration and its entry to the explicit migration manifest; keep the runner's post-application version registration. Check seed upserts for matching partial-index predicates before restarting the API workflow.
