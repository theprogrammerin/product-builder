# Frontend Architecture

One React Native codebase (via Expo) targets web, iOS, and Android from the
build spec's screens. These choices are locked — the Codegen Agent does not
pick alternatives per project.

## Navigation: React Navigation

- Stack navigator per top-level flow described in the build spec's
  `workflows`, tab navigator for the app's main sections if the spec
  implies more than one persistent top-level area (e.g. "browse" +
  "my bookings" + "profile").
- Route params are typed (TypeScript) — no untyped `route.params` access.

## State management: Zustand

- One store per bounded domain area (e.g. `useAuthStore`, `useListingsStore`),
  not one global store for the whole app.
- Server data (API responses) lives in a thin data-fetching layer, not
  duplicated into Zustand state, unless it needs to be shared across
  screens outside of normal fetch/refetch (e.g. the current user).
- No Redux, Context-based global state, or MobX — Zustand is the only
  state layer.

## Component library: React Native Paper

- All UI screens are built from React Native Paper components (Material
  Design) plus layout primitives (`View`, `SafeAreaView`, custom
  `StyleSheet`s) — no second component library, no raw platform-specific
  UI kits.
- Theming: a single `theme.ts` defining the app's Paper theme (colors,
  fonts) derived from the build spec's product identity if provided,
  otherwise a sensible default — every screen consumes the theme, no
  inline hardcoded colors.

## Screens

- One screen per entry in the build spec's `screens` list, under
  `src/screens/`, named `<Name>Screen.tsx`.
- Screens call the API through a single generated API client
  (`src/api/client.ts`) — no ad hoc `fetch`/`axios` calls inside screen
  components.

## Testing: Jest + React Native Testing Library

- Every screen gets at least one render test; every Zustand store gets a
  unit test for its actions/selectors.
