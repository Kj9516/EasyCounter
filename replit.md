# EasyCounter

Нативное локальное приложение для iOS и Android, в котором пользователь создает собственные проекты и настраиваемые экраны.

## Run & Operate

- `pnpm --filter @workspace/easycounter run dev` — run the Expo mobile app through its managed workflow
- `pnpm --filter @workspace/easycounter run typecheck` — check the mobile app's TypeScript
- `pnpm run typecheck` — full typecheck across the workspace

## Stack

- React Native + Expo Router + TypeScript
- Local on-device SQLite through `expo-sqlite`
- App interface and first-build documentation are in Russian

## Where things live

- `artifacts/easycounter/app/` — native routes and screens
- `artifacts/easycounter/storage/database.ts` — local database schema and project/screen persistence
- `artifacts/easycounter/types/project.ts` — project and screen types
- `artifacts/easycounter/components/ProjectProvider.tsx` — shared project state
- `artifacts/easycounter/DECISIONS.md` — technical decisions and MVP assumptions

## Architecture decisions

- Project and screen writes use SQLite transactions; projects and screens remain isolated on device.
- The app remains local-only; no login, server sync, or required network access.
- User-defined counters, parameter types, rules, widgets, and timers are not implemented as built-in domain concepts; they belong to later engine/editor stages.

## Product

Implementation is staged according to the attached EasyCounter v1.0 specification. Stage A provides project and screen navigation with local persistence. Stages B–D add the general-purpose engine, editors, time features, import/export, and acceptance checks.

## User preferences

Keep the app native to iOS and Android. Do not replace it with a website or add hard-coded game, score, money, player, or health scenarios. Deliver and report each implementation stage separately.

## Gotchas

Use `Preview on your phone` in Replit to open the Expo Go QR flow. TypeScript checks do not substitute for checking persistence and navigation on physical iOS and Android devices.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
