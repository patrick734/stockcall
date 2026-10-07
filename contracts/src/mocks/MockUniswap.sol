// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

// Test doubles only. Never deploy to a live network.
// Pools trade at a fixed rate (WAD: out = in * rate / 1e18) and can be told to fill only part of an input,
// as a real pool does when it reaches its price limit.

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function register(address pool, address a, address b, uint24 fee) external {
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

/// @dev Minimal PoolManager: unlock, swap, sync, settle, take, with per-currency delta accounting that must net to
///      zero by the end of every unlock.
contract MockPoolManager {
    mapping(bytes32 => uint256) public rate01;
    mapping(bytes32 => uint256) public rate10;
    mapping(bytes32 => uint256) public fillBps;
    mapping(address => int256) public delta;
    address[] private _touched;
    bool public unlocked;
    address private _synced;
    uint256 private _syncedBalance;

    function poolId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function setPool(PoolKey memory key, uint256 r01, uint256 r10) external {
        bytes32 id = poolId(key);
        rate01[id] = r01;
        rate10[id] = r10;
    }

    function setFillBps(PoolKey memory key, uint256 bps) external {
        fillBps[poolId(key)] = bps;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i; i < _touched.length; ++i) {
            require(delta[_touched[i]] == 0, "CurrencyNotSettled");
        }
        delete _touched;
        unlocked = false;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (BalanceDelta) {
        require(unlocked, "ManagerLocked");
        bytes32 id = poolId(key);
        uint256 r = params.zeroForOne ? rate01[id] : rate10[id];
        require(r != 0, "PoolNotInitialized");
        require(params.amountSpecified < 0, "exact in only");
        uint256 amountIn = uint256(-params.amountSpecified);
        if (fillBps[id] != 0) amountIn = (amountIn * fillBps[id]) / 10_000;
        uint256 out = Math.mulDiv(amountIn, r, 1e18);
        (address cin, address cout) = params.zeroForOne
            ? (Currency.unwrap(key.currency0), Currency.unwrap(key.currency1))
            : (Currency.unwrap(key.currency1), Currency.unwrap(key.currency0));
        _account(cin, -int256(amountIn));
        _account(cout, int256(out));
        return params.zeroForOne
            ? toBalanceDelta(-int128(int256(amountIn)), int128(int256(out)))
            : toBalanceDelta(int128(int256(out)), -int128(int256(amountIn)));
    }

    function sync(Currency currency) external {
        _synced = Currency.unwrap(currency);
        _syncedBalance = IERC20(_synced).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (_synced == address(0)) {
            paid = msg.value; // native ETH
            _account(address(0), int256(paid));
            return paid;
        }
        paid = IERC20(_synced).balanceOf(address(this)) - _syncedBalance;
        _account(_synced, int256(paid));
        _synced = address(0);
    }

    function take(Currency currency, address to, uint256 amount) external {
        _account(Currency.unwrap(currency), -int256(amount));
        IERC20(Currency.unwrap(currency)).transfer(to, amount);
    }

    function _account(address currency, int256 d) private {
        delta[currency] += d;
        _touched.push(currency);
    }
}

/// @dev Uniswap v3 pool stand-in for TWAP reads: a piecewise-constant tick history, set ahead of time, from which
///      observe() returns exact tick cumulatives. Can be told to revert like a pool whose buffer no longer reaches.
contract MockOraclePool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint16 public cardinality = 10_000;
    bool public failObserve;

    uint32[] private _times;
    int56[] private _cums;
    int24[] private _ticks;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setCardinality(uint16 c) external {
        cardinality = c;
    }

    function setFailObserve(bool f) external {
        failObserve = f;
    }

    /// @dev From time `at` on, the pool sits at `tick`. Calls must come in time order.
    function setTickAt(uint32 at, int24 tick) external {
        int56 cum;
        uint256 n = _times.length;
        if (n != 0) {
            require(at >= _times[n - 1], "order");
            cum = _cums[n - 1] + int56(_ticks[n - 1]) * int56(uint56(at - _times[n - 1]));
        }
        _times.push(at);
        _cums.push(cum);
        _ticks.push(tick);
    }

    function cumulativeAt(uint256 t) public view returns (int56) {
        uint256 n = _times.length;
        require(n != 0 && t >= _times[0], "OLD");
        uint256 i = n - 1;
        while (_times[i] > t) i--;
        return _cums[i] + int56(_ticks[i]) * int56(uint56(t - _times[i]));
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory c, uint160[] memory s) {
        require(!failObserve, "OLD");
        c = new int56[](secondsAgos.length);
        s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            c[i] = cumulativeAt(block.timestamp - secondsAgos[i]);
        }
    }
}
