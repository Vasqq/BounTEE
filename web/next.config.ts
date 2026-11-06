import type { NextConfig } from "next";

const config: NextConfig = {
  // @bountee/formats ships TypeScript source; Next compiles it with the app.
  transpilePackages: ["@bountee/formats"],
};

export default config;
