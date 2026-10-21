// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Contract-specific errors for ReferralManager (common errors in Common.sol)
interface IReferralErrors {
    error SelfReferralNotAllowed();
    error ReferrerAlreadySet(address currentReferrer);
}
