// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Contract-specific errors for Tickets (common errors in Common.sol)
interface ITicketsErrors {
    error InvalidInput();
    error InvalidFeeSetting(uint256 provided, uint256 max);
    error UseFractionalShares();
    error InsufficientShares(uint256 required, uint256 available);
    error SupplyExceeded(uint256 amount, uint256 supply);
    error InvalidSigner(address expected, address actual);
    error SignerCannotBeSame();
    error SignerCannotBeUser();
    error IndividualFeeExceedsMax(uint256 provided, uint256 max);
    error SelfTransferNotAllowed();
    error SendToSubjectFailed(bytes returnData);
    error SendToProtocolFailed(bytes returnData);
    error AdjustedSupplyMustBePositive();
}
