// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {GovernanceChecks} from "./governance/GovernanceChecks.sol";

/// @title BuyBurn
/// @notice Receives StockCall fees in ETH (Arena fees and forfeits), buys $CALL with them in its Pons pool
///         (native ETH / $CALL) and burns every $CALL it holds.
/// @dev There is no withdrawal path: ETH leaves only as a swap into $CALL, and $CALL only as a burn. $CALL is given
///      to the constructor if it already exists, otherwise set once by the admin (the 48h timelock) after the Pons
///      launch. Keeper runs are capped and rate-limited, which
///      bounds what a bad price can cost; the keeper's own minimum output is checked too.
contract BuyBurn is AccessControl, ReentrancyGuard, IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice Release of the StockCall contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    IPoolManager public immutable poolManager;
    address public immutable ponsHook;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    ERC20Burnable public token;
    uint256 public maxEthPerRun;
    uint32 public minInterval;
    uint64 public lastBurn;
    bool public halted;
    uint256 public totalBurned;
    uint256 public totalEthSpent;

    bool private _unlocking;

    event Burned(uint256 ethIn, uint256 tokensBurned, uint256 totalBurned);
    event TokenSet(address indexed token);
    event LimitsSet(uint256 maxEthPerRun, uint32 minInterval);
    event HaltSet(bool halted);

    error InvalidConfig();
    error TokenAlreadySet();
    error TokenUnset();
    error IsHalted();
    error OverLimit();
    error TooSoon();
    error Shortfall(uint256 received, uint256 minimum);
    error Unauthorized();

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
    ) {
        if (address(poolManager_) == address(0) || ponsHook_ == address(0) || tickSpacing_ <= 0) revert InvalidConfig();
        if (address(token_) != address(0)) {
            if (address(token_).code.length == 0) revert InvalidConfig();
            token = token_;
            emit TokenSet(address(token_));
        }
        GovernanceChecks.requireRoles(admin, guardian, keeper, msg.sender);
        poolManager = poolManager_;
        ponsHook = ponsHook_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        _setLimits(maxEthPerRun_, minInterval_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
    }

    receive() external payable {}

    /// @notice The $CALL / ETH Pons pool this contract buys from.
    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(ponsHook)
        });
    }

    /// @notice Buys $CALL with `ethIn` of the fees and burns everything held. Keeper only, capped, rate-limited.
    ///         Simulate it (eth_call) with minOut = 0 to quote.
    function burn(uint256 ethIn, uint256 minOut) external onlyRole(KEEPER_ROLE) nonReentrant returns (uint256 burned) {
        if (address(token) == address(0)) revert TokenUnset();
        if (halted) revert IsHalted();
        if (ethIn == 0 || ethIn > maxEthPerRun || ethIn > address(this).balance) revert OverLimit();
        if (block.timestamp < uint256(lastBurn) + minInterval) revert TooSoon();
        lastBurn = uint64(block.timestamp);

        uint256 before = token.balanceOf(address(this));
        _unlocking = true;
        poolManager.unlock(abi.encode(ethIn));
        _unlocking = false;
        uint256 bought = token.balanceOf(address(this)) - before;
        if (bought < minOut) revert Shortfall(bought, minOut);

        totalEthSpent += ethIn;
        burned = _burnHeld();
        emit Burned(ethIn, burned, totalBurned);
    }

    /// @notice Burns any $CALL sent here directly. Anyone may call it.
    function burnHeld() external nonReentrant returns (uint256) {
        if (address(token) == address(0)) revert TokenUnset();
        return _burnHeld();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_unlocking) revert Unauthorized();
        uint256 ethIn = abi.decode(data, (uint256));
        BalanceDelta delta = poolManager.swap(
            poolKey(),
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            bytes("")
        );
        int128 paid = delta.amount0();
        int128 received = delta.amount1();
        if (paid >= 0 || received <= 0) revert Shortfall(0, 1);
        poolManager.settle{value: uint256(uint128(-paid))}();
        poolManager.take(Currency.wrap(address(token)), address(this), uint256(uint128(received)));
        return "";
    }

    function _burnHeld() private returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        token.burn(amount);
        totalBurned += amount;
    }

    // ---------------------------------------------------------------- governance

    /// @notice Sets $CALL after its Pons launch. Admin (timelock) only, and only once.
    function setToken(ERC20Burnable token_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (address(token_).code.length == 0) revert InvalidConfig();
        token = token_;
        emit TokenSet(address(token_));
    }

    function setLimits(uint256 maxEthPerRun_, uint32 minInterval_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setLimits(maxEthPerRun_, minInterval_);
    }

    function halt() external onlyRole(GUARDIAN_ROLE) {
        halted = true;
        emit HaltSet(true);
    }

    function resume() external onlyRole(DEFAULT_ADMIN_ROLE) {
        halted = false;
        emit HaltSet(false);
    }

    function _setLimits(uint256 maxEthPerRun_, uint32 minInterval_) private {
        if (maxEthPerRun_ == 0 || maxEthPerRun_ > 10 ether || minInterval_ < 5 minutes) revert InvalidConfig();
        maxEthPerRun = maxEthPerRun_;
        minInterval = minInterval_;
        emit LimitsSet(maxEthPerRun_, minInterval_);
    }
}
