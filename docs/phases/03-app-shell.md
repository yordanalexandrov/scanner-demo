# Phase 03 — App shell: dev build, navigation, Home

**Status:** in review · **Depends on:** 01, 02 · **Source:** spec milestone 3

Built on 2026-07-29 against Expo SDK 57 (React Native 0.86) with a **local** build path — the Android
SDK is already installed on the development machine, so `expo prebuild` + `expo run:android` needs no
Expo account and no cloud queue. There is no `eas.json`. The one surprise is recorded in
[ADR-19](../decisions.md#adr-19--vision-camera-is-pinned-to-v4-and-the-android-project-is-generated):
vision-camera 5 removed `useCodeScanner` and has no Android code scanning at all, so the library is
pinned to 4.7.3.

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

[ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication) ·
[ADR-19](../decisions.md#adr-19--vision-camera-is-pinned-to-v4-and-the-android-project-is-generated)

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
6. No provider credential exists anywhere under `app/`:

   ```bash
   grep -rniE '(AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9]{16,}|(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']+)' app/src app/app.json
   ```

   **Amended 2026-07-29.** The original form of this criterion was
   `grep -rniE '(api[_-]?key|secret|sk-|AIza)' app/src app/app.json`, which matches the *word* "secret"
   and therefore fires on any comment explaining that the app holds none — including the one in
   `app/src/config.ts` that cites the specification's own constraint by name. A check that cannot pass
   while the code is correct gets ignored, so it now matches credential shapes and quoted assignments
   rather than English prose. `EXPO_PUBLIC_API_TOKEN` still passes because the app only ever *reads* it
   from the environment; a literal token pasted into a source file would not.
7. `git check-ignore app/.env` confirms the real env file is ignored.

## Risks / unknowns

- ~~**Open question for the owner:** which build path?~~ Resolved 2026-07-29: **local**. The Android SDK
  is present on the development machine (platform 35, build-tools 34/35, cmdline-tools, JDK 21), so
  `expo prebuild --platform android` followed by `expo run:android` needs neither an Expo account nor a
  cloud queue. No `eas.json` is committed; nothing in the setup prevents adding one later.
- ~~Expo SDK version pins the compatible `react-native-vision-camera` major.~~ Fixed at Expo SDK 57 with
  vision-camera **4.7.3, pinned exactly** — see
  [ADR-19](../decisions.md#adr-19--vision-camera-is-pinned-to-v4-and-the-android-project-is-generated).
  This pairing is one major behind on the camera library and is therefore verified by a Gradle build
  here rather than assumed. Phase 04 begins with no native upgrade outstanding.
- pnpm + Metro resolution is the most likely thing to go wrong. If `watchFolders` proves insufficient,
  the fallback is `node-linker=hoisted` for the app package — recorded here so it is not rediscovered.
  Note that `disableHierarchicalLookup`, which Expo's monorepo guide sets, must stay **off** under pnpm:
  every transitive dependency resolves through a nested `node_modules/.pnpm` path.
- Verified on device 2026-07-29 — Samsung SM-S928B, Android 16. **All acceptance criteria pass.**

  The red/green transition was demonstrated against a **locally run server**, not the deployed one.
  The deployed box carries production traffic, and the criterion tests the app's indicator rather than
  any particular server, so stopping a local instance exercises the identical code path at no risk.
  The phone reached it over `adb reverse tcp:3002`, which keeps the server on loopback instead of
  exposing it to the LAN. Recorded here because the same trick is the cheapest way to re-run this
  check in any later phase.

  What makes the observation conclusive is the uptime: it went `1m 2s` → unreachable → `15s`. A cached
  response could not have reset it. The app kept the same pid throughout — no restart.
- `app/tsconfig.json` is rewritten by Expo's CLI whenever its `include` disagrees, and its writer drops
  every comment in the file. The comments there were restored once already. If they disappear again,
  that is the cause, not a careless edit.

## Review checkpoint

Show: the dev build running on the device, the health indicator reacting live to the server being stopped
and started, navigation through every placeholder screen, and the permission-denied state recovering.
