import type { NextConfig } from "next"

/*
 * apps/web — delivery spec §8: "Next.js 15 (App Router) + React 19" (the
 * spec pins the 15 major; 16 is not adopted silently) with SDS tokens via
 * packages/ui (A12: primitives are vendored, owned code).
 *
 * transpilePackages ships @sentinel/ui's raw .tsx source through the build
 * (owned code — there is no compiled UI artifact to depend on).
 * serverExternalPackages keeps pg a real Node dependency of the route
 * runtime (the plan route holds a pooled client, not a bundled copy).
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@sentinel/ui"],
  serverExternalPackages: ["pg"],
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig
