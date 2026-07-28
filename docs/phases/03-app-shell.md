# Phase 03 — App shell: dev build, navigation, Home

**Status:** not started · **Depends on:** 01, 02 · **Source:** spec milestone 3

## Goal

An Expo development build that installs on an Android device, navigates between the app's screens, and
tells me at a glance whether the backend is reachable — the container every camera screen slots into.

## Scope

1. React Native via Expo with a **development build** (`expo prebuild` + EAS or a local run). Expo Go is
   not usable and is not attempted. — *spec § Stack — App*
2. **Android only.** No iOS project configuration, no iOS-specific code paths, no Swift. Equally, nothing
   is hardcoded in a way that makes adding iOS later painful: platform-specific bits stay behind ordinary
   `Platform` checks. — *spec § Stack — App*
3. React Navigation with the five destinations: Home, Barcode, Capture, Library, History. Screens that
   arrive in later phases are registered as placeholders so the navigation graph is complete and
   reviewable now.
4. Home screen: the configured server URL, a health-check indicator polling `GET /api/v1/health`, and
   navigation to the scan screens plus History and Library. — *spec § Screens — Home*
5. Typed API client wrapping the endpoints, using the zod schemas from `packages/shared` to validate
   responses — a shape mismatch surfaces as an error, not as `undefined` two screens later.
6. Bearer token and server URL read from `app/.env` via `EXPO_PUBLIC_*` variables; `.env` is gitignored,
   `.env.example` is committed. The app holds **zero** provider credentials.
   — *spec § Hard constraint: no secrets in the app*

   Stated plainly, because it is easy to misread: `EXPO_PUBLIC_*` values are inlined into the JS bundle at
   build time, so the bearer token **is recoverable from the APK with `strings`**. That is acceptable and
   intended — it is a coarse gate on a personal benchmark server, not a secret. What matters is that it is
   the *only* credential in the app, that it is rotatable, and that it is never reused anywhere else. The
   provider keys, which genuinely are secrets, live only on the server.
7. Metro configured for the pnpm monorepo (`watchFolders` at the workspace root, `nodeModulesPaths`) so
   `@scanner-demo/shared` resolves. — [ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication)
8. TypeScript strict mode. — *spec § Stack — App*
9. Camera permission handled explicitly with a **recoverable denied state**: a denied permission shows an
   explanation and a button that opens system settings, never a dead screen.
   — *spec § Gotchas*

## Out of scope

- Any camera code. Phases 04 and 05. `react-native-vision-camera` is installed and prebuilt here so the
  native module is present, but no camera session is opened.
- Any OCR, upload or attempt recording. Phases 05 onwards.
- iOS. Permanently, per the specification.

## Deliverables

```
app/
├── package.json
├── app.json / app.config.ts       # Android config, permissions, dev build settings
├── eas.json                       # if EAS is chosen — see the open question below
├── metro.config.js                # monorepo resolution
├── .env.example
└── src/
    ├── App.tsx
    ├── navigation/
    │   └── RootNavigator.tsx
    ├── screens/
    │   ├── HomeScreen.tsx
    │   ├── BarcodeScreen.tsx      # placeholder
    │   ├── CaptureScreen.tsx      # placeholder
    │   ├── LibraryScreen.tsx      # placeholder
    │   └── HistoryScreen.tsx      # placeholder
    ├── api/
    │   ├── client.ts              # fetch + bearer + zod validation
    │   └── health.ts
    ├── hooks/
    │   └── useCameraPermission.ts
    └── config.ts                  # env access, one place
```

## Key decisions

[ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication)

## Interfaces

```ts
// api/client.ts — every call goes through here so auth and validation are not per-screen concerns
export async function apiGet<T>(path: string, schema: ZodSchema<T>): Promise<T>;
export async function apiPost<T>(path: string, body: unknown, schema: ZodSchema<T>): Promise<T>;
export async function apiUpload<T>(path: string, form: FormData, schema: ZodSchema<T>): Promise<T>;
```

Environment (`app/.env.example`): `EXPO_PUBLIC_SERVER_URL`, `EXPO_PUBLIC_API_TOKEN`.

## Acceptance criteria

1. A development build installs and launches on a physical Android device.
2. Home shows the configured server URL and a green indicator against the deployed server; stopping the
   server turns it red within one poll interval, and restarting it turns it green again without an app
   restart.
3. Every navigation destination is reachable and returns to Home.
4. `import { ocrResponseSchema } from "@scanner-demo/shared"` resolves and typechecks inside the app.
5. Denying the camera permission shows the recoverable state with a working "open settings" button;
   granting it in settings and returning to the app clears the state without a restart.
6. `grep -rniE '(api[_-]?key|secret|sk-|AIza)' app/src app/app.json` finds nothing. No provider
   credential exists anywhere under `app/`.
7. `git check-ignore app/.env` confirms the real env file is ignored.

## Risks / unknowns

- **Open question for the owner:** no Android device is currently attached and there is no global
  `expo`/`eas` CLI. Which build path — local `expo run:android` (needs the Android SDK installed on this
  machine) or EAS cloud builds (needs an Expo account)? This blocks the phase, not the plan.
- Expo SDK version pins the compatible `react-native-vision-camera` major. Fix the SDK version here and
  install vision-camera against it now, so phase 04 does not begin with a native upgrade.
- pnpm + Metro resolution is the most likely thing to go wrong. If `watchFolders` proves insufficient,
  the fallback is `node-linker=hoisted` for the app package — recorded here so it is not rediscovered.

## Review checkpoint

Show: the dev build running on the device, the health indicator reacting live to the server being stopped
and started, navigation through every placeholder screen, and the permission-denied state recovering.
