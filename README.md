# Yatri Proctor

Desktop app (macOS and Windows) for AI-proctored Yatri Pass mock exams, modelled on Pearson OnVUE.

## Flow
1. **Begin** on yatricloud.com → exam dashboard → *Take mock exam in Yatri Proctor*. The site creates a proctored session and a one-time launch code (10 min) and opens `yatriproctor://launch?code=…`. Learners can also type the code.
2. **Sign-in**: the main process sends the code to `https://www.yatricloud.com/api/pass/proctor.redeem`, which returns a one-time magic-link token; the app calls `supabase.auth.verifyOtp`. No password in the app.
3. **Consent** (itemised, India DPDP Act style).
4. **System test**: camera, microphone (must hear you), connection, exactly one display, no virtual machine / remote desktop, blocked apps closed (with consent, "Close these apps"), macOS permissions.
5. **Check-in**: headshot (exactly one face), ID front/back (optional for mock exams), 4 room photos → private `proctor-media` bucket.
6. **Locked exam**: kiosk full screen, always on top, content protection, display sleep blocked, shortcuts swallowed and logged, clipboard cleared, close guarded, blocked-app re-scan every 20 s. Timer starts on *Start*. Navigator, mark for review, whiteboard, autosave, resume after a crash.
7. **AI monitoring (on device)**: MediaPipe Face Landmarker (face missing, multiple faces, head pose looking away), mic voice level, focus loss, full-screen exit, display added, blocked apps, network drop, webcam lost. Grace periods avoid blink/cough flags; severity ≥2 flags save one snapshot (≤ 1 per 20 s).
8. **Results**: score vs pass mark, domains; risk score from events (≥15 → admin review queue). AI never fails anyone; a reviewer marks valid/invalid in Admin → Yatri Pass → Proctoring.

Cannot be blocked (logged instead): Ctrl+Alt+Del, Win+L, Cmd+Tab/Cmd+Opt+Esc. On macOS 15 ScreenCaptureKit can still capture a protected window.

## Develop
```bash
npm install
npm run assets        # MediaPipe wasm + face model into public/, icons
npm start             # build renderer + run Electron
npm run smoke         # boots, loads the AI model, prints system checks
YP_E2E=1 npm start    # dev-only test mode: fake camera, no app closing, no kiosk
```

## Release
Tag `vX.Y.Z` and push: `.github/workflows/release.yml` builds `Yatri-Proctor-mac-arm64.dmg`, `Yatri-Proctor-mac-x64.dmg`, `Yatri-Proctor-windows-setup.exe` and attaches them to the GitHub release. yatricloud.com/pass/proctor links to `releases/latest/download/<file>`.
Builds are unsigned until these repo secrets exist: macOS `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; Windows `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

## Backend
Shared Supabase project (yatricloud.com). Migrations live in the yatricloud.com repo: `20261109001400_yatri_proctor.sql`, `20261109001500_proctor_begin.sql`.
