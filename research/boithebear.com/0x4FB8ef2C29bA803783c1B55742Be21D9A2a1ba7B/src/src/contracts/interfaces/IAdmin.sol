// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IAdmin {
    // State variables
    function protocolFeeDestination() external view returns (address);
    function protocolFeePercent() external view returns (uint256);
    function tippingFeePercent() external view returns (uint256);
    function subjectFeePercent() external view returns (uint256);
    function referralFeePercent() external view returns (uint256);
    function paused() external view returns (bool);
    function sanctionsList() external view returns (address);
    
    // Functions
    function owner() external view returns (address);
    function isSanctioned(address account) external view returns (bool);
}
