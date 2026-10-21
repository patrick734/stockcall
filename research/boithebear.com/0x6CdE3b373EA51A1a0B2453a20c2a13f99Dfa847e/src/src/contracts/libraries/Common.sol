// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Common
/// @notice Shared constants, errors, and events used across contracts
library Common {
    /// @notice 1e18 - standard fixed-point precision for math operations
    uint256 internal constant WAD = 1e18;
    /// @notice 1e4 - standard fixed-point precision for fee calculations
    uint256 internal constant FEE_PERCENT = 1e4;

    // ============ Common Errors ============

    error ZeroAddress();
    error ZeroAmount();
    error ContractPaused();
    error Unauthorized();
    error ArrayLengthMismatch(uint256 length1, uint256 length2);
    error InsufficientPayment(uint256 required, uint256 provided);
    error TransferFailed(address recipient);
    error AddressSanctioned(address account);
}
