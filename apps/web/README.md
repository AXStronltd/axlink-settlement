# AxLink web — the AxLink front end

`index.html` is the complete AxLink front end exactly as deployed at https://axlink.netlify.app
(recovered 2026-11-06, 287 KB, single self-contained file: marketing site, institution onboarding,
client institution portal and operator console, in-page router with 17 routes, no external scripts).

**Preserved as-is.** Step 1 adds it to the repository and checks it in CI (`scripts/check-web.js`:
parses the inline JavaScript, asserts the title and route table). It is not yet connected to the API:
its data is illustrative and marked as such in the page. Wiring the portal and console to
`/api/institutions/*` and the settlement endpoints is a later milestone.

Deploy: the file is static. Any static host serves it (`apps/web/` as the site root). The existing
`frontend/` React app is the internal ops dashboard and is unrelated to this page.
