import invariant from 'tiny-invariant'
import { abi } from '@pollum-io/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json'
import { Interface } from '@ethersproject/abi'
import { BigNumber, BigNumberish } from 'ethers'
import { MethodParameters } from '@pollum-io/v3-sdk'
import { Trade as RouterTrade } from '@pollum-io/router-sdk'
import { Currency, TradeType } from '@pollum-io/sdk-core'
import { Command, RouterTradeType } from './entities/Command'
import { NFTTrade, SupportedProtocolsData } from './entities/NFTTrade'
import { PegasysTrade, SwapOptions } from './entities/protocols/pegasys'
import { UnwrapWETH } from './entities/protocols/unwrapWETH'
import { CommandType, RoutePlanner } from './utils/routerCommands'
import { encodePermit } from './utils/inputTokens'
import { ROUTER_AS_RECIPIENT, SENDER_AS_RECIPIENT, ETH_ADDRESS } from './utils/constants'

export type SwapRouterConfig = {
  sender?: string // address
  deadline?: BigNumberish
}

type SupportedNFTTrade = NFTTrade<SupportedProtocolsData>

export abstract class SwapRouter {
  public static INTERFACE: Interface = new Interface(abi)

  public static swapCallParameters(trades: Command[] | Command, config: SwapRouterConfig = {}): MethodParameters {
    if (!Array.isArray(trades)) trades = [trades]

    const nftTrades = trades.filter((trade, _, []) => trade.hasOwnProperty('market')) as SupportedNFTTrade[]
    const allowRevert = nftTrades.length == 1 && nftTrades[0].orders.length == 1 ? false : true
    const planner = new RoutePlanner()

    // track value flow to require the right amount of native value
    let currentNativeValueInRouter = BigNumber.from(0)
    let transactionValue = BigNumber.from(0)

    for (const trade of trades) {
      /**
       * is NFTTrade
       */
      if (trade.tradeType == RouterTradeType.NFTTrade) {
        const nftTrade = trade as SupportedNFTTrade
        nftTrade.encode(planner, { allowRevert })
        const tradePrice = nftTrade.getTotalPrice()

        // send enough native value to contract for NFT purchase
        if (currentNativeValueInRouter.lt(tradePrice)) {
          transactionValue = transactionValue.add(tradePrice.sub(currentNativeValueInRouter))
          currentNativeValueInRouter = BigNumber.from(0)
        } else {
          currentNativeValueInRouter = currentNativeValueInRouter.sub(tradePrice)
        }
        /**
         * is PegasysTrade
         */
      } else if (trade.tradeType == RouterTradeType.PegasysTrade) {
        const pegasysTrade = trade as PegasysTrade
        const inputIsNative = pegasysTrade.trade.inputAmount.currency.isNative
        const outputIsNative = pegasysTrade.trade.outputAmount.currency.isNative
        const swapOptions = pegasysTrade.options

        invariant(!(inputIsNative && !!swapOptions.inputTokenPermit), 'NATIVE_INPUT_PERMIT')

        if (!!swapOptions.inputTokenPermit) {
          encodePermit(planner, swapOptions.inputTokenPermit)
        }

        if (inputIsNative) {
          transactionValue = transactionValue.add(
            BigNumber.from(pegasysTrade.trade.maximumAmountIn(swapOptions.slippageTolerance).quotient.toString())
          )
        }
        // track amount of native currency in the router
        if (outputIsNative && swapOptions.recipient == ROUTER_AS_RECIPIENT) {
          currentNativeValueInRouter = currentNativeValueInRouter.add(
            BigNumber.from(pegasysTrade.trade.minimumAmountOut(swapOptions.slippageTolerance).quotient.toString())
          )
        }
        pegasysTrade.encode(planner, { allowRevert: false })
        /**
         * is UnwrapWETH
         */
      } else if (trade.tradeType == RouterTradeType.UnwrapWETH) {
        const UnwrapWETH = trade as UnwrapWETH
        trade.encode(planner, { allowRevert: false })
        currentNativeValueInRouter = currentNativeValueInRouter.add(UnwrapWETH.amount)
        /**
         * else
         */
      } else {
        throw 'trade must be of instance: PegasysTrade or NFTTrade'
      }
    }

    // TODO: matches current logic for now, but should eventually only sweep for multiple NFT trades
    // or NFT trades with potential slippage (i.e. sudo).
    // Note: NFTXV2 sends excess ETH to the caller (router), not the specified recipient
    if (nftTrades.length > 0) planner.addCommand(CommandType.SWEEP, [ETH_ADDRESS, SENDER_AS_RECIPIENT, 0])
    return SwapRouter.encodePlan(planner, transactionValue, config)
  }

  /**
   * @deprecated in favor of swapCallParameters. Update before next major version 2.0.0
   * Produces the on-chain method name to call and the hex encoded parameters to pass as arguments for a given swap.
   * @param trades to produce call parameters for
   */
  public static swapNFTCallParameters(trades: SupportedNFTTrade[], config: SwapRouterConfig = {}): MethodParameters {
    let planner = new RoutePlanner()
    let totalPrice = BigNumber.from(0)

    const allowRevert = trades.length == 1 && trades[0].orders.length == 1 ? false : true

    for (const trade of trades) {
      trade.encode(planner, { allowRevert })
      totalPrice = totalPrice.add(trade.getTotalPrice())
    }

    planner.addCommand(CommandType.SWEEP, [ETH_ADDRESS, SENDER_AS_RECIPIENT, 0])
    return SwapRouter.encodePlan(planner, totalPrice, config)
  }

  /**
   * @deprecated in favor of swapCallParameters. Update before next major version 2.0.0
   * Produces the on-chain method name to call and the hex encoded parameters to pass as arguments for a given trade.
   * @param trades to produce call parameters for
   * @param options options for the call parameters
   */
  public static swapERC20CallParameters(
    trades: RouterTrade<Currency, Currency, TradeType>,
    options: SwapOptions
  ): MethodParameters {
    // TODO: use permit if signature included in swapOptions
    const planner = new RoutePlanner()

    const trade: PegasysTrade = new PegasysTrade(trades, options)

    const inputCurrency = trade.trade.inputAmount.currency
    invariant(!(inputCurrency.isNative && !!options.inputTokenPermit), 'NATIVE_INPUT_PERMIT')

    if (options.inputTokenPermit) {
      encodePermit(planner, options.inputTokenPermit)
    }

    const nativeCurrencyValue = inputCurrency.isNative
      ? BigNumber.from(trade.trade.maximumAmountIn(options.slippageTolerance).quotient.toString())
      : BigNumber.from(0)

    trade.encode(planner, { allowRevert: false })
    return SwapRouter.encodePlan(planner, nativeCurrencyValue, {
      deadline: options.deadlineOrPreviousBlockhash ? BigNumber.from(options.deadlineOrPreviousBlockhash) : undefined,
    })
  }

  /**
   * Encodes a planned route into a method name and parameters for the Router contract.
   * @param planner the planned route
   * @param nativeCurrencyValue the native currency value of the planned route
   * @param config the router config
   */
  private static encodePlan(
    planner: RoutePlanner,
    nativeCurrencyValue: BigNumber,
    config: SwapRouterConfig = {}
  ): MethodParameters {
    const { commands, inputs } = planner
    const functionSignature = !!config.deadline ? 'execute(bytes,bytes[],uint256)' : 'execute(bytes,bytes[])'
    const parameters = !!config.deadline ? [commands, inputs, config.deadline] : [commands, inputs]
    const calldata = SwapRouter.INTERFACE.encodeFunctionData(functionSignature, parameters)
    return { calldata, value: nativeCurrencyValue.toHexString() }
  }
}
