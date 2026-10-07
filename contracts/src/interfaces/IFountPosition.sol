// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Holds one Fount's concentrated-liquidity range in a Uniswap v4 Equity Token / USDG pool.
/// Every mutating call is restricted to the bound Fount, and all tokens it releases go to the Fount.
/// Removing liquidity in v4 also pays out accrued fees, so the Fount must call `collectFees` first
/// in the same transaction; otherwise fees are paid out as if they were principal.
interface IFountPosition {
    /// @notice Principal in the range, computed at the oracle-implied price rather than the pool's
    /// spot price, so a same-block swap cannot move the Fount's share price.
    function balances() external view returns (uint256 equityAmount, uint256 usdgAmount);

    /// @notice USDG value of `equityAmount` at the pool's current spot price.
    function spotUsdgValue(uint256 equityAmount) external view returns (uint256);

    /// @notice Opens or tops up the range with tokens already transferred in; leftovers return to the Fount.
    function enter(int24 tickLower, int24 tickUpper) external returns (uint128 liquidity);

    /// @notice Removes all liquidity.
    function exitAll() external returns (uint256 equityAmount, uint256 usdgAmount);

    /// @notice Removes `numerator / denominator` of the range's liquidity.
    function withdrawPortion(uint256 numerator, uint256 denominator)
        external
        returns (uint256 equityAmount, uint256 usdgAmount);

    /// @notice Collects accrued swap fees without changing liquidity.
    function collectFees() external returns (uint256 equityFees, uint256 usdgFees);
}
