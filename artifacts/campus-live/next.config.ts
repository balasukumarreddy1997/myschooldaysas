import type { NextConfig } from "next";

const configuredBasePath = process.env.BASE_PATH;
const basePath = configuredBasePath && configuredBasePath !== "/" ? configuredBasePath : undefined;

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  allowedDevOrigins: ["127.0.0.1", "localhost", ...(process.env.REPLIT_DEV_DOMAIN ? [process.env.REPLIT_DEV_DOMAIN] : [])],
  poweredByHeader: false,
};

export default nextConfig;
