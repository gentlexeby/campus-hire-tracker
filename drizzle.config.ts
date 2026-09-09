import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.CAMPUS_HIRE_TRACKER_DB_URL ?? "file:./.test-data/drizzle.db",
  },
});
