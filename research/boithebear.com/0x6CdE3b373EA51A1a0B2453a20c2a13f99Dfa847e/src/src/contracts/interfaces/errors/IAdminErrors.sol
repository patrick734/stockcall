// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Contract-specific errors for Admin (common errors in Common.sol)
interface IAdminErrors {
    error InvalidFeePercent(uint256 provided, uint256 max);
}
