<div align="center">
  <img height="120x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:20px;">Arbitrage Bot for Drift Protocol v2</h1>
  <h3> Out-of-the-box arbitrage bot between Drift v2 and dYdX v3 </h3>

  <p>
    <a href="https://docs.drift.trade/"><img alt="Docs" src="https://img.shields.io/badge/docs-bots-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/MIT><img alt="License" src="https://img.shields.io/badge/license-MIT-blueviolet" /></a>
    <a href="https://twitter.com/DriftProtocol">
    <img alt="Follow Drift on Twitter" src="https://img.shields.io/twitter/follow/driftprotocol.svg?label=follow+drift&style=flat-square"></a>
  </p>
</div>


# Setting up

## Setup Environment
Update values in `src/index.ts` with the relevant API secrets.

## Depositing Collateral

Some bots (i.e. trading, liquidator and JIT makers) require collateral in order to keep positions open. Ensure that you've deposited sufficient collateral into both dydx and drift.

# Running the bot

> Various risk limits can be configured at the top of `src/index.ts`. Some sensible defaults are provided already.

To run the bot (⚠ requires collateral)

```shell
npm start
```

## Example output
Example output can be found at `example-output.txt`