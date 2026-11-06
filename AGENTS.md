# AxLink working scope

Read `docs/SCOPE.md` before changing code. The owner's current authorization is
**Leg A, Step 1: repository audit, organization and backend foundation only**.

- Leg A ends at verified digital asset receipt by the receiving institution.
- Preserve `frontend/` and `apps/web/`; do not redesign or rewire them in Step 1.
- Keep core/provider boundaries explicit. B2INPAY is optional, not a prerequisite
  for basic USDT settlement.
- Freeze legacy fiat/FX/payout functionality (Leg B); retain it for compatibility.
- Do not implement later modules or begin Step 2 without explicit owner approval.
- Run typechecking, backend tests against an isolated migrated PostgreSQL database,
  the existing stubbed settlement harness and frontend build. Report skipped or
  blocked checks accurately; stubbed tests do not verify live settlement.
- Do not deploy or alter production data as part of this step.
