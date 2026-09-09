/**
 * The demo: the coordinator, plus a page that drives it.
 *
 * Run: npm run demo   then open http://localhost:4021/ui
 *
 * 🔴 **This is not the process to deploy.** It mounts `/demo`, which signs with the buyers'
 * private keys out of `.accounts.json`, so anything that can reach it can spend those accounts -
 * and, because a pool takes one seat per address, can consume the demonstration itself. The
 * coordinator meant for a host is `npm run server`, which mounts none of this. The separation is
 * two entry points rather than a runtime flag, so there is no switch to leave in the wrong
 * position.
 *
 * What it serves, in the order Express matches:
 *
 *   /ui      the page - plain static files, no build step
 *   /demo    the control plane above
 *   /        the real coordinator, `createApp`, unchanged and mounted last
 *
 * So `GET /benchmark/:slug` is answered by exactly the code a judge reads, and the buyer's
 * payment is a real HTTP round trip into it rather than a function call dressed up as one.
 *
 * Which coordinator the pools name is `PUBLIC_BASE_URL`'s business, not this file's. Left unset,
 * everything runs here. Pointed at a hosted coordinator, the seller opens pools naming it and the
 * buyers pay it over the network - and the mount below is simply never reached, because no pool
 * names localhost.
 */
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp, describeCoordinator, wireCoordinator } from "../../src/server/index.js";
import { demoApi } from "./api.js";
import { ProtocolLog } from "./log.js";
import { SeatMemory, Wallets } from "./wallets.js";

const PAGE = fileURLToPath(new URL("../../public", import.meta.url));

async function main(): Promise<void> {
  const coordinator = await wireCoordinator();
  const { cfg, deps } = coordinator;

  const wallets = new Wallets(cfg.network);
  const app = express();
  app.disable("x-powered-by");
  app.use("/ui", express.static(PAGE));
  app.use("/demo", demoApi({ coordinator, wallets, memory: new SeatMemory(), log: new ProtocolLog() }));
  // Last, and at the root, so every route the coordinator defines keeps the path it has.
  app.use(createApp(deps));

  app.listen(cfg.port, () => {
    console.log(`\nquorum402 demo on ${deps.network}\n`);
    for (const line of describeCoordinator(coordinator)) console.log(line);
    console.log(`  wallets      ${wallets.all().map((w) => w.label).join(", ")}`);
    console.log(`\n  open         http://localhost:${cfg.port}/ui\n`);
    if (!cfg.subgraphUrl) {
      // Worth saying loudly here rather than only in the banner above: without an index the page
      // can show a seat but never let anyone redeem one, and that looks like a bug in the demo.
      console.log("  note: SUBGRAPH_URL is unset, so no seat can be redeemed and none will list.\n");
    }
  });
}

await main();
