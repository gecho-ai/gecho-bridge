# Desktop authorization deployment status

Updated: 2026-10-18. Cloud observations below were last verified on 2026-10-11; production was not rechecked on October 18.

## Completed

- Created `ods.desktop_auth_records` using the additive migration; existing tables were not modified.
- Added a trusted-proxy secret check to the backend authorization entry points.
- Built the latest macOS ARM64 desktop DMG, version 1.1.38, with the production authorization URL in packaged metadata.
- Desktop regression suite: 118 tests passed, including local Electron/backend authorization interoperability. These are not production end-to-end results.

## Service deployed; desktop authorization still pending

- Initial revisions failed startup. After Python 3.8 dependency-loading fixes in service-layer commit `824c468`, revision 309 deployed successfully with 100% traffic. Health returned HTTP 200 and a legacy unauthenticated endpoint returned HTTP 401. Service-layer commit `90f26dd` records those checks.
- The original environment was restored during the failed attempts, and desktop authorization configuration was not re-enabled during the successful retry. `/service_layer/desktop-auth/me` returned HTTP 503 (`temporarily_unavailable`). This is not a successful end-to-end authorization test.
- The earlier `insight.workflow` warning was not the fatal startup cause. Deployment success does not establish that every platform `sitecustomize` warning disappeared.
- The CDN rejected conditional origin configuration with `OperationDenied.AccessControlDenied.ConditionalOrigin`. Existing website routing was not changed; the website root still returns HTTP 200.
- A same-origin, uncached `/service_layer/desktop-auth/*` proxy on `www.gecho.ai` is required. It must overwrite the trusted client-IP and proxy-secret headers; secrets must not be placed in client code.

## Next release gates

1. Recheck actual website cookie scope and the current production configuration before changing it.
2. Enable conditional-origin permission or provision an equivalent same-origin reverse proxy.
3. Enable desktop authorization configuration after the trusted route is available; verify database connectivity and existing login regression checks.
4. Run the packaged desktop with a real logged-in website account: consent, callback, token refresh and logout/revocation.

Real production authorization has not passed. The DMG is a test artifact, not a verified public release.
