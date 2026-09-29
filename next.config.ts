import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The CVs, job descriptions and calibration profiles are read through `fs` at
  // request time. Next's tracer cannot see those reads, so without this they
  // are simply absent from the serverless bundle and every run fails in
  // production with "No job description found" while working fine locally.
  //
  // data/runs and data/decisions.json are deliberately NOT listed: those are
  // written at runtime and live in Supabase once it is configured.
  outputFileTracingIncludes: {
    "/api/run": ["./data/applications/**/*", "./data/jds/**/*", "./data/hires/**/*"],
    "/api/ingest": ["./data/applications/**/*"],
    "/api/decide": ["./data/applications/**/*"],
  },
};

export default nextConfig;
