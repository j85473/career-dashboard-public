import type { NextConfig } from "next";
import { randomUUID } from 'node:crypto';

const nextConfig: NextConfig = {
  // Compile the same token into the browser and the version endpoint. A fresh
  // build gets a fresh token, including rebuilds of the same Git revision.
  env: { NEXT_PUBLIC_DASHBOARD_BUILD_VERSION: randomUUID() },
  allowedDevOrigins: ['100.81.109.117'],
  serverExternalPackages: ['puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth']
};

export default nextConfig;
