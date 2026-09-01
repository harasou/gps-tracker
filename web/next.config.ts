import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API route から firebase-admin (Node.js SDK) を使うため
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
