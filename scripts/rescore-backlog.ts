import { config } from "dotenv";

config({ path: ".env.local" });

import { recomputeCompanyScores } from "../src/lib/recompute-company-scores";

/** Re-rank all status=new companies after bulk industry/headcount updates. */
async function main() {
  const { scored, icpMatch } = await recomputeCompanyScores();
  console.log(JSON.stringify({ scored, icpMatch }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
