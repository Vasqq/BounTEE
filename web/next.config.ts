import type { NextConfig } from "next";

const config: NextConfig = {
  // @bountee/formats and @bountee/cli ship TypeScript source; Next compiles them with the
  // app. The server runs the command-line tool's own verify checks (lib/verify.ts).
  transpilePackages: ["@bountee/formats", "@bountee/cli"],
};

export default config;
