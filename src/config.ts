import { config as loadEnvConfig } from "dotenv";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

export function loadEnv(): string {
  const result = loadEnvConfig({ path: envPath, quiet: true });
  if (result.error && result.error.code !== "ENOENT") {
    throw result.error;
  }
  return process.env.PROVIDER ?? result.parsed?.PROVIDER ?? "";
}

loadEnv();
