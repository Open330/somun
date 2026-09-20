/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_AUTH_URL?: string;
  readonly VITE_AUTH_AUDIENCE?: string;
}
