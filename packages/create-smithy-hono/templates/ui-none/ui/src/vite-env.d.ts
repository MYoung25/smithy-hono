/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base path. Empty in dev (Vite proxy); set to `/api` by the prod build. */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
