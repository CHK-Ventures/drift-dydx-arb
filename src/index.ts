import { BN, AnchorProvider } from "@project-serum/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  User,
  initialize,
  PositionDirection,
  convertToNumber,
  Wallet,
  BASE_PRECISION,
  getMarketOrderParams,
} from "@drift-labs/sdk";
import assert from "assert";
import { OrderSide, OrderType, Market, TimeInForce, ApiKeyCredentials } from "@dydxprotocol/v3-client";
import { setInterval } from "timers/promises";
import { DydxClient } from "@dydxprotocol/v3-client";
import Web3 from "web3";

const DRIFT_MARKET_INDEX = 0; // Solana
const TRADING_AMOUNT = 1; // Max quantity of base asset to trade
const MINIMUM_ENTRY_THRESHOLD = 0.05; // USD amount diff we want between dydx and drift to enter
const MAXIMUM_EXIT_THRESHOLD = 0.03; // amount diff between prices when we decide to exit position
const RISK_THRESHOLD = 1.01; // max amount of coin we hold per exchange
const MAXIMUM_SLIPPAGE = 0.03;

/** SECRETS **/
const SOLANA_PRIVATE_KEY: Uint8Array = "REPLACEME" as any;
const DYDX_ETH_KEY: string = "REPLACEME";
const DYDX_STARK_KEY: string = "REPLACEME";
const DYDX_API_CREDENTIALS: ApiKeyCredentials = {
  key: "REPLACEME",
  secret: "REPLACEME",
  passphrase: "REPLACEME",
};

interface State {
  mark_price: number;
  position: number;
}

class DriftExchange {
  client: Promise<DriftClient> = this.build_client();
  user: Promise<User> = this.build_user();

  async build_client(): Promise<DriftClient> {
    console.log("Building drift client");
    const sdkConfig = initialize({ env: "mainnet-beta" });
    const keypair = Keypair.fromSecretKey(Uint8Array.from(SOLANA_PRIVATE_KEY));
    const wallet = new Wallet(keypair);
    const rpcAddress = String("https://api.mainnet-beta.solana.com");
    const connection = new Connection(rpcAddress);
    const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
    let driftClient = new DriftClient({
      connection,
      wallet: provider.wallet,
      programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
      opts: { commitment: "confirmed" },
      perpMarketIndexes: [DRIFT_MARKET_INDEX],
      spotMarketIndexes: [DRIFT_MARKET_INDEX],
      subAccountIds: [0],
      accountSubscription: { type: "websocket" },
      env: "mainnet-beta",
    });
    console.log("Drift client built");
    return driftClient;
  }

  async build_user(): Promise<User> {
    console.log("Building drift user");
    const client = await this.client;
    await client.subscribe();
    const user = client.createUser(0, { type: "websocket" });
    assert(await user.exists(), "User account does not exist");
    await user.subscribe();
    console.log("Drift user built");
    return user;
  }

  async state(): Promise<State> {
    const [client, user] = await Promise.all([this.client, this.user]);
    return {
      mark_price: convertToNumber(client.getPerpMarketAccount(DRIFT_MARKET_INDEX)?.amm.lastMarkPriceTwap!),
      position: convertToNumber(user.getPerpPosition(DRIFT_MARKET_INDEX)?.baseAssetAmount!) / 1000,
    };
  }

  async place_order(direction: PositionDirection, size: number): Promise<void> {
    console.log(`Placing order on drift ${direction} size ${size}`);

    const baseAssetAmount = BASE_PRECISION.mul(new BN(size));
    const params = getMarketOrderParams({
      marketIndex: DRIFT_MARKET_INDEX,
      direction,
      baseAssetAmount,
    });
    await this.client.then((c) => c.placeAndTakePerpOrder(params));
  }
}

class DydxExchange {
  client: DydxClient;
  eth_address: string;
  api_credentials: Promise<ApiKeyCredentials>;
  market: Market;
  dydx_position_id: string;

  constructor() {
    var web3 = new Web3();
    web3.eth.accounts.wallet.add(DYDX_ETH_KEY);

    this.client = new DydxClient("https://api.dydx.exchange", {
      apiTimeout: 3000,
      web3: web3,
      apiKeyCredentials: DYDX_API_CREDENTIALS,
      starkPrivateKey: DYDX_STARK_KEY,
    });

    // // This was used to determine the api key credentials for dydx_client
    this.eth_address = this.client.web3!.eth.accounts.wallet[0].address;
    this.api_credentials = this.client.onboarding.recoverDefaultApiCredentials(this.eth_address);
    this.market = Market.SOL_USD;
    this.dydx_position_id = "";
  }

  async state(): Promise<State> {
    var dydx_account = await this.client.private.getPositions({
      market: this.market,
    })!;
    const position = dydx_account.positions.reduce((balance, position) => balance + parseFloat(position.size), 0);

    const order_book = await this.client.public.getOrderBook(this.market);
    const best_ask = parseFloat(order_book.asks[0].price);
    const best_bid = parseFloat(order_book.bids[0].price);
    const mark_price = (best_ask + best_bid) / 2;

    var accountInfo = await this.client.private.getAccount(this.eth_address)!;
    this.dydx_position_id = accountInfo.account.positionId.toString();

    return { mark_price, position };
  }

  // quantity is always positive
  // places dydx market order @ quantity
  async place_order(direction: PositionDirection, quantity: number, purchase_price: number): Promise<void> {
    console.log("Placing dydx market order", direction, "at quantity", quantity.toString());

    const order_dir = direction == PositionDirection.LONG ? OrderSide.BUY : OrderSide.SELL;
    const actual_price = Math.round(purchase_price * 1000) / 1000;
    const expiration: string = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await this.client.private.createOrder(
      {
        market: this.market,
        side: order_dir,
        type: OrderType.MARKET,
        size: quantity.toString(),
        limitFee: "0.02", // max allowed fees is 2%
        price: actual_price.toString(),
        timeInForce: TimeInForce.IOC,
        postOnly: false,
        expiration,
      },
      this.dydx_position_id // position id required for creating order.
    );
  }
}

async function determine_trade(drift: DriftExchange, dydx: DydxExchange): Promise<void> {
  const [drift_state, dydx_state] = await Promise.all([drift.state(), dydx.state()]);

  // determines difference in mark prices and rounds to 3 decimal places
  const price_diff: number = Math.abs(Math.round((drift_state.mark_price - dydx_state.mark_price) * 1000) / 1000); // 3 decimal places

  console.log(
    `drift_mark_price=${drift_state.mark_price}, dydx_mark=${dydx_state.mark_price}, price_diff=${price_diff}`
  );
  console.log(`drift_position=${drift_state.position}, dydx_position=${dydx_state.position}`);

  console.log("Attempting to open arb position");
  await attempt_open_mark_based_arb(drift, dydx);

  console.log("Attempting to close position");
  await attempt_close_arb(drift, dydx);
}

async function attempt_open_mark_based_arb(drift: DriftExchange, dydx: DydxExchange): Promise<void> {
  const [drift_state, dydx_state] = await Promise.all([drift.state(), dydx.state()]);
  const mark_differences = Math.abs(dydx_state.mark_price - drift_state.mark_price);

  // below threshold to enter
  if (mark_differences < MINIMUM_ENTRY_THRESHOLD) {
    console.log("Mark differences too small to enter");
    return;
  }

  // sell on dydx and buy on drift
  if (dydx_state.mark_price > drift_state.mark_price) {
    if (Math.abs(drift_state.position + TRADING_AMOUNT) > RISK_THRESHOLD) {
      console.log("Could not buy on drift due to risk limits\n");
    } else {
      // market sell TRADING_AMOUNT sol on dydx and buy TRADING_AMOUNT on drift
      await place_arb_order(PositionDirection.LONG, drift, dydx);
    }
  } else {
    // buy on dydx and sell on drift
    if (Math.abs(drift_state.position - TRADING_AMOUNT) > RISK_THRESHOLD) {
      console.log("Could not sell on drift due to risk limits\n");
    } else {
      await place_arb_order(PositionDirection.SHORT, drift, dydx);
    }
  }
}

// compares the mark prices of the two, when they are close, initiate a buy-back
async function attempt_close_arb(drift: DriftExchange, dydx: DydxExchange): Promise<void> {
  const [drift_state, dydx_state] = await Promise.all([drift.state(), dydx.state()]);
  const mark_difference = Math.abs(dydx_state.mark_price - drift_state.mark_price);

  if (drift_state.position == 0 || mark_difference >= MAXIMUM_EXIT_THRESHOLD) {
    console.log("Mark difference too large to close position or no open position");
    return;
  }

  const drift_direction = drift_state.position > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
  await place_arb_order(drift_direction, drift, dydx);
}

async function place_arb_order(drift_direction: PositionDirection, drift: DriftExchange, dydx: DydxExchange) {
  const [drift_state, dydx_state] = await Promise.all([drift.state(), dydx.state()]);
  const dydx_price =
    drift_direction == PositionDirection.LONG
      ? dydx_state.mark_price - 2 * MAXIMUM_SLIPPAGE
      : dydx_state.mark_price + 2 * MAXIMUM_SLIPPAGE;

  try {
    await drift.place_order(drift_direction, TRADING_AMOUNT);

    const dydx_direction = drift_direction == PositionDirection.LONG ? PositionDirection.SHORT : PositionDirection.LONG;
    await dydx.place_order(dydx_direction, TRADING_AMOUNT, dydx_price);
    console.log(`Current delta: ${Math.abs(drift_state.position + dydx_state.position)}`);
  } catch (e) {
    console.log("Attempted to place order but failed");
    console.log(e);
  }
}

async function main() {
  var drift = new DriftExchange();
  var dydx = new DydxExchange();

  for await (const _ of setInterval(20000)) {
    console.log(`Current time: ${new Date().toLocaleTimeString()}`);
    console.log("--------------------");
    await determine_trade(drift, dydx);
    console.log("--------------------");
  }
}

main();
