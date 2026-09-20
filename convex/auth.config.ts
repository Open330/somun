import type { AuthConfig } from "convex/server";

/** jiun-api가 발급하는 RS256 JWT(aud "somun")를 신뢰한다. daily와 같은 구조. */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://api.jiun.dev",
      jwks: "https://api.jiun.dev/.well-known/jwks.json",
      algorithm: "RS256",
      applicationID: "somun",
    },
  ],
} satisfies AuthConfig;
