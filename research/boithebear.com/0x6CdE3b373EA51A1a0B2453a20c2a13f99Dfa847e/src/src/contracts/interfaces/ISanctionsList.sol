// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ISanctionsList
/// @notice Interface for Chainalysis sanctions oracle
/// @dev See https://go.chainalysis.com/chainalysis-oracle-docs.html
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}
