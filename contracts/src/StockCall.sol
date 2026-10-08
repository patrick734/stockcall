// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Arena} from "./Arena.sol";
import {BuyBurn} from "./BuyBurn.sol";
import {DrawdownRetire} from "./DrawdownRetire.sol";
import {FeeRouter} from "./FeeRouter.sol";
import {Fount} from "./Fount.sol";
import {FountOracle} from "./FountOracle.sol";
import {FountRegistry} from "./FountRegistry.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IFountOracle} from "./interfaces/IFountOracle.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {FountPositionV4} from "./v4/FountPositionV4.sol";
import {IAllowanceTransfer, IPositionManagerMinimal} from "./v4/IV4Periphery.sol";
import {V4SwapAdapter} from "./v4/V4SwapAdapter.sol";

// The contracts StockCall deploys, under the StockCall name so they read as StockCall on the block explorer.
// Each one adds nothing to the contract it names: same code, same checks, same constructor arguments.

/// @notice The StockCall 48-hour timelock: OpenZeppelin's TimelockController, unchanged.
contract StockCallTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}

/// @notice StockCall forecast rounds. See Arena.
contract StockCallArena is Arena {
    constructor(Config memory c) Arena(c) {}
}

/// @notice Buys $CALL with Arena fees and forfeits and burns it. See BuyBurn.
contract StockCallBuyBurn is BuyBurn {
    constructor(
        IPoolManager poolManager_,
        address ponsHook_,
        uint24 poolFee_,
        int24 tickSpacing_,
        address admin,
        address guardian,
        address keeper,
        uint256 maxEthPerRun_,
        uint32 minInterval_,
        ERC20Burnable token_
    ) BuyBurn(poolManager_, ponsHook_, poolFee_, tickSpacing_, admin, guardian, keeper, maxEthPerRun_, minInterval_, token_) {}
}

/// @notice A StockCall liquidity Fount for one stock token. See Fount.
contract StockCallFount is Fount {
    constructor(Config memory c, string memory name_, string memory symbol_) Fount(c, name_, symbol_) {}
}

/// @notice StockCall's Chainlink oracle with bounds and a circuit breaker. See FountOracle.
contract StockCallOracle is FountOracle {
    constructor(
        address owner_,
        AggregatorV3Interface sequencerFeed_,
        UsdgInit memory usdg,
        uint16 maxJumpBps_,
        uint32 jumpCooldown_,
        FeedInit[] memory initialFeeds
    ) FountOracle(owner_, sequencerFeed_, usdg, maxJumpBps_, jumpCooldown_, initialFeeds) {}
}

/// @notice Routes the Founts' protocol fee share to the $CALL burn. See FeeRouter.
contract StockCallFeeRouter is FeeRouter {
    constructor(address owner_, address drawdownRetire_) FeeRouter(owner_, drawdownRetire_) {}
}

/// @notice Buys $CALL with the Founts' fees and burns it. See DrawdownRetire.
contract StockCallBurn is DrawdownRetire {
    constructor(
        ERC20Burnable burnToken_,
        ISwapAdapter swapAdapter_,
        address admin,
        address guardian,
        address keeper,
        uint32 minInterval_,
        address[] memory inputTokens,
        uint256[] memory maxPerRun
    ) DrawdownRetire(burnToken_, swapAdapter_, admin, guardian, keeper, minInterval_, inputTokens, maxPerRun) {}
}

/// @notice The list of StockCall Founts. See FountRegistry.
contract StockCallRegistry is FountRegistry {
    constructor(address owner_, Listing[] memory initial) FountRegistry(owner_, initial) {}
}

/// @notice A StockCall Fount's Uniswap v4 position. See FountPositionV4.
contract StockCallPosition is FountPositionV4 {
    constructor(
        IPoolManager poolManager_,
        IPositionManagerMinimal positionManager_,
        IAllowanceTransfer permit2,
        IFountOracle oracle_,
        PoolKey memory key,
        IERC20 equityToken_,
        IERC20 usdg_
    ) FountPositionV4(poolManager_, positionManager_, permit2, oracle_, key, equityToken_, usdg_) {}
}

/// @notice StockCall's Uniswap v4 swap router for rebalances and the burn. See V4SwapAdapter.
contract StockCallSwapAdapter is V4SwapAdapter {
    constructor(address owner_, IPoolManager poolManager_, address hub_, address[] memory hooks, PoolKey[] memory pools)
        V4SwapAdapter(owner_, poolManager_, hub_, hooks, pools)
    {}
}
