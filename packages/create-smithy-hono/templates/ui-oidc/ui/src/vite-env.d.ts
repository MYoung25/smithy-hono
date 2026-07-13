/// <reference types="vite/client" />

/**
 * App-specific Vite env vars. `VITE_API_BASE` is set by the build to the API
 * path prefix (`/api` for the same-origin full-stack deploy; empty in dev, where
 * the Vite proxy forwards root paths). See src/App.tsx.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
