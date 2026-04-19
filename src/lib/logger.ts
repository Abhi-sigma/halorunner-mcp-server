import pino from "pino";
import { env } from "./env.js";

const isDev = env().NODE_ENV === "development";

export const logger = pino({
  level: env().LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.access_token", "*.refresh_token", "*.id_token"],
    censor: "[REDACTED]"
  },
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } } }
    : {})
});
