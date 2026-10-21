// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IReferralManager {
    function admin() external view returns (address);
    function userToReferrer(address user) external view returns (address);
    function authorizedCallers(address caller) external view returns (bool);
    function setReferrer(address user, address referrer) external;
    function getReferrer(address user) external view returns (address);
}
