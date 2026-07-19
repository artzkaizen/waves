import { defineConfig } from "drizzle-kit";

// Paths are relative to the repo root — that is where drizzle-kit is invoked from.
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/schema.ts",
  out: "./server/drizzle",
  dbCredentials: {
    url: `${process.env.WAVES_DATA_DIR ?? "./server/data"}/waves.db`,
  },
});
