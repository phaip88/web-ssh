import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ssh2 ships optional native bindings; keep it out of the webpack bundle.
  serverExternalPackages: ["ssh2", "pg"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
