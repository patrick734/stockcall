// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAdmin} from "./IAdmin.sol";
import {IReferralManager} from "./IReferralManager.sol";

interface ITipping {
    // ============ Events ============
    
    event Tip(address indexed from, address indexed to, uint256 amount, uint256 fee, uint256 referralFee);
    event TipToken(address indexed token, address indexed from, address indexed to, uint256 amount, uint256 fee, uint256 referralFee);
    event BatchTip(address indexed from, uint256 totalAmount, uint256 fee, uint256 referralFee);
    event BatchTipToken(address indexed token, address indexed from, uint256 totalAmount, uint256 fee, uint256 referralFee);
    event AdminSet(address indexed newAdmin);
    event ReferralManagerSet(address indexed newReferralManager);

    // ============ Errors ============
    
    error SelfTransferNotAllowed(address sender);
    error FeeTransferFailed();
    error InsufficientTokenBalance(uint256 required, uint256 available);
    error InsufficientTokenAllowance(uint256 required, uint256 available);
    error TotalAmountMismatch(uint256 provided, uint256 actual);

    // ============ View Functions ============
    
    function admin() external view returns (IAdmin);
    function referralManager() external view returns (IReferralManager);

    // ============ External Functions ============
    
    /// @notice Send a single ETH tip
    /// @param receiver The address to receive the tip
    function tip(address payable receiver) external payable;

    /// @notice Send a single ETH tip with referrer
    function tipWithReferrer(address payable receiver, address referrer) external payable;

    /// @notice Send a single ERC20 tip
    /// @param token The token address
    /// @param receiver The address to receive the tip
    /// @param amount The tip amount (fee will be deducted)
    function tipToken(address token, address receiver, uint256 amount) external;

    /// @notice Send a single ERC20 tip with referrer
    function tipTokenWithReferrer(address token, address receiver, uint256 amount, address referrer) external;

    /// @notice Send ETH tips to multiple addresses
    /// @param receivers Array of addresses to receive tips
    /// @param amounts Array of gross tip amounts for each receiver (fee deducted from each)
    /// @param totalAmount Sum of all amounts - must match msg.value
    function batchTip(address payable[] calldata receivers, uint256[] calldata amounts, uint256 totalAmount) external payable;

    /// @notice Send ERC20 tips to multiple addresses
    /// @param token The token address
    /// @param receivers Array of addresses to receive tips
    /// @param amounts Array of gross tip amounts for each receiver (fee deducted from each)
    /// @param totalAmount Sum of all amounts
    function batchTipToken(address token, address[] calldata receivers, uint256[] calldata amounts, uint256 totalAmount) external;

    /// @notice Update the Admin contract reference
    /// @param _admin New admin address
    function setAdmin(address _admin) external;

    /// @notice Update the ReferralManager contract reference
    /// @param _referralManager New referral manager address
    function setReferralManager(address _referralManager) external;
}
