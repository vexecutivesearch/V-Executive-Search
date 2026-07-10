import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { fetchApolloApiUsage } from "../src/lib/apollo-usage";

async function main() {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY not set");
  }

  const report = await fetchApolloApiUsage(apiKey);
  console.log(JSON.stringify(report, null, 2));
  console.log("\n" + report.creditWarning);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
