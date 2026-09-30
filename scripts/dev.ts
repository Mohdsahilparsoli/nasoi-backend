// Local server: `npm run dev` (reads .env via Node's --env-file when present).
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const { createApp } = await import("../src/create-app.js");

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => console.log(`NASOI API listening on http://localhost:${port}`));
