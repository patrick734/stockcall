// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IInfluenceStaking
/// @notice The part of InfluenceStaking that InfluenceKeys and InfluenceSocial depend on.
interface IInfluenceStaking {
    /// @notice Staking tier of `account`. 0 means no tier.
    function tierOf(address account) external view returns (uint256);

    /// @notice Distribute `msg.value` to current stakers.
    function notifyEthReward() external payable;

    /// @notice Pull `amount` tokens from the caller and distribute them to current stakers.
    function notifyTokenReward(uint256 amount) external;
}
