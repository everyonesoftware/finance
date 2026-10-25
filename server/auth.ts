import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import { database } from "./database.js";
import * as schema from "./schema.js";

const authSecret: string | undefined = process.env["BETTER_AUTH_SECRET"];
const authUrl: string | undefined = process.env["BETTER_AUTH_URL"];

if (!authSecret || authSecret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must be set to at least 32 characters.");
}

if (!authUrl) {
  throw new Error("BETTER_AUTH_URL must be set to the app's public URL.");
}

const trustedOrigins: string[] = [
  authUrl,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export const auth = betterAuth({
  appName: "Finance",
  baseURL: authUrl,
  basePath: "/api/auth",
  secret: authSecret,
  trustedOrigins,
  database: drizzleAdapter(database, {
    provider: "sqlite",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
    }),
  ],
  advanced: {
    useSecureCookies: new URL(authUrl).protocol === "https:",
  },
});
