# 100X Changelog — V8

- Consolidated the previous builds into one consistently named V8 package.
- Fixed Event Edit/Update URL truncation: Zoom and media URLs now allow up to 2048 characters.
- Updated campaign/template/AI-draft media URL handling to avoid the old 500-character limit.
- Updated package version to 8.0.0.
- Updated health endpoint and service-worker cache namespace to V8.
- Updated README, Render setup and security documentation.
- Added V8 relational migration targets for Zoom/media and AI calling persistence.
- Preserved API/private-resource service-worker cache protection.

## V8.0.1 — PWA install UX
- Added a visible Install / Download App button on the opening screen.
- Added native beforeinstallprompt handling for supported browsers.
- Added iPhone/iPad Add to Home Screen guidance when native prompt is unavailable.
