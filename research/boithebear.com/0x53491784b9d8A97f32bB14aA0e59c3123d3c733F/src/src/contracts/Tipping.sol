// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IAdmin} from "./interfaces/IAdmin.sol";
import {IReferralManager} from "./interfaces/IReferralManager.sol";
import {ITipping} from "./interfaces/ITipping.sol";
import {Common} from "./libraries/Common.sol";

contract Tipping is Initializable, OwnableUpgradeable, ITipping {
    using SafeERC20 for IERC20;

    IAdmin public admin;
    IReferralManager public referralManager;

    uint256 constant WAD = Common.WAD;
    uint256 constant GAS_FORWARD_AMOUNT = 30_000;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert Common.ZeroAddress();
        __Ownable_init(_msgSender());
        admin = IAdmin(_admin);
    }

    modifier whenNotPaused() {
        if (admin.paused()) revert Common.ContractPaused();
        _;
    }

    modifier notSanctioned(address account) {
        if (admin.isSanctioned(account)) revert Common.AddressSanctioned(account);
        _;
    }

    function setAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert Common.ZeroAddress();
        admin = IAdmin(_admin);
        emit AdminSet(_admin);
    }

    function setReferralManager(address _referralManager) external onlyOwner {
        if (_referralManager == address(0)) revert Common.ZeroAddress();
        referralManager = IReferralManager(_referralManager);
        emit ReferralManagerSet(_referralManager);
    }

    /// @notice Send a single ETH tip with referrer
    function tipWithReferrer(address payable receiver, address referrer) external payable whenNotPaused notSanctioned(_msgSender()) notSanctioned(receiver) {
        if (referrer != address(0) && address(referralManager) != address(0)) {
            referralManager.setReferrer(_msgSender(), referrer);
        }
        _tipETH(receiver);
    }

    /// @notice Send a single ETH tip
    /// @param receiver The address to receive the tip
    function tip(address payable receiver) external payable whenNotPaused notSanctioned(_msgSender()) notSanctioned(receiver) {
        _tipETH(receiver);
    }

    function _tipETH(address payable receiver) internal {
        if (receiver == address(0)) revert Common.ZeroAddress();
        if (receiver == _msgSender()) revert SelfTransferNotAllowed(_msgSender());
        if (msg.value == 0) revert Common.ZeroAmount();

        uint256 feePercent = admin.tippingFeePercent();
        uint256 protocolFee = (msg.value * feePercent) / (Common.FEE_PERCENT);
        uint256 referralFee = _calculateReferralFee(msg.value);
        uint256 tipAmount = msg.value - protocolFee - referralFee;

        (bool success, ) = receiver.call{value: tipAmount}("");
        if (!success) revert Common.TransferFailed(receiver);

        if (referralFee > 0 && address(referralManager) != address(0)) {
            protocolFee += _sendToReferrers(_msgSender(), receiver, referralFee);
        } else {
            protocolFee += referralFee;
        }

        if (protocolFee > 0) {
            (bool feeSuccess, ) = admin.protocolFeeDestination().call{value: protocolFee}("");
            if (!feeSuccess) revert FeeTransferFailed();
        }

        emit Tip(_msgSender(), receiver, tipAmount, protocolFee, referralFee);
    }

    /// @notice Send a single ERC20 tip with referrer
    function tipTokenWithReferrer(address token, address receiver, uint256 amount, address referrer) external whenNotPaused notSanctioned(_msgSender()) notSanctioned(receiver) {
        if (referrer != address(0) && address(referralManager) != address(0)) {
            referralManager.setReferrer(_msgSender(), referrer);
        }
        _tipToken(token, receiver, amount);
    }

    /// @notice Send a single ERC20 tip
    /// @param token The token address
    /// @param receiver The address to receive the tip
    /// @param amount The tip amount (fee will be deducted)
    function tipToken(address token, address receiver, uint256 amount) external whenNotPaused notSanctioned(_msgSender()) notSanctioned(receiver) {
        _tipToken(token, receiver, amount);
    }

    function _tipToken(address token, address receiver, uint256 amount) internal {
        if (receiver == address(0)) revert Common.ZeroAddress();
        if (receiver == _msgSender()) revert SelfTransferNotAllowed(_msgSender());
        if (amount == 0) revert Common.ZeroAmount();

        IERC20 tokenContract = IERC20(token);
        uint256 feePercent = admin.tippingFeePercent();
        uint256 protocolFee = (amount * feePercent) / Common.FEE_PERCENT;
        uint256 referralFee = _calculateReferralFee(amount);

        uint256 userBalance = tokenContract.balanceOf(_msgSender());
        if (amount > userBalance) revert InsufficientTokenBalance(amount, userBalance);

        uint256 userAllowance = tokenContract.allowance(_msgSender(), address(this));
        if (amount > userAllowance) revert InsufficientTokenAllowance(amount, userAllowance);

        uint256 tipAmount = amount - protocolFee - referralFee;
        tokenContract.safeTransferFrom(_msgSender(), receiver, tipAmount);

        if (referralFee > 0 && address(referralManager) != address(0)) {
            uint256 referralFeeHalf = referralFee / 2;
            uint256 referralFeeOtherHalf = referralFee - referralFeeHalf;
            address senderReferrer = referralManager.getReferrer(_msgSender());
            address receiverReferrer = referralManager.getReferrer(receiver);

            if (senderReferrer != address(0) && senderReferrer != _msgSender()) {
                tokenContract.safeTransferFrom(_msgSender(), senderReferrer, referralFeeOtherHalf);
            } else {
                protocolFee += referralFeeOtherHalf;
            }

            if (receiverReferrer != address(0) && receiverReferrer != _msgSender()) {
                tokenContract.safeTransferFrom(_msgSender(), receiverReferrer, referralFeeHalf);
            } else {
                protocolFee += referralFeeHalf;
            }
        } else {
            protocolFee += referralFee;
        }

        if (protocolFee > 0) tokenContract.safeTransferFrom(_msgSender(), admin.protocolFeeDestination(), protocolFee);

        emit TipToken(token, _msgSender(), receiver, amount, protocolFee, referralFee);
    }

    /// @notice Send ETH tips to multiple addresses
    /// @param receivers Array of addresses to receive tips
    /// @param amounts Array of gross tip amounts for each receiver (fee deducted from each)
    /// @param totalAmount Sum of all amounts - must match msg.value
    function batchTip(
        address payable[] calldata receivers,
        uint256[] calldata amounts,
        uint256 totalAmount
    ) external payable whenNotPaused notSanctioned(_msgSender()) {
        if (receivers.length != amounts.length) revert Common.ArrayLengthMismatch(receivers.length, amounts.length);
        if (receivers.length == 0) revert Common.ZeroAmount();
        if (msg.value != totalAmount) revert Common.InsufficientPayment(totalAmount, msg.value);

        uint256 feePercent = admin.tippingFeePercent();
        uint256 _referralFeePercent = address(referralManager) != address(0) ? admin.referralFeePercent() : 0;
        uint256 totalProtocolFee = 0;
        uint256 totalReferralFee = 0;
        uint256 sumAmounts = 0;

        for (uint256 i = 0; i < receivers.length; i++) {
            if (receivers[i] == address(0)) revert Common.ZeroAddress();
            if (receivers[i] == _msgSender()) revert SelfTransferNotAllowed(_msgSender());
            if (admin.isSanctioned(receivers[i])) revert Common.AddressSanctioned(receivers[i]);
            if (amounts[i] == 0) revert Common.ZeroAmount();
            
            uint256 fee = (amounts[i] * feePercent) / Common.FEE_PERCENT;
            uint256 refFee = (amounts[i] * _referralFeePercent) / WAD;
            uint256 netAmount = amounts[i] - fee - refFee;
            totalProtocolFee += fee;
            totalReferralFee += refFee;
            sumAmounts += amounts[i];

            (bool success, ) = receivers[i].call{value: netAmount}("");
            if (!success) revert Common.TransferFailed(receivers[i]);
        }

        if (sumAmounts != totalAmount) revert TotalAmountMismatch(totalAmount, sumAmounts);

        if (totalReferralFee > 0 && address(referralManager) != address(0)) {
            totalProtocolFee += _sendToReferrersBatch(_msgSender(), totalReferralFee);
        } else {
            totalProtocolFee += totalReferralFee;
        }

        if (totalProtocolFee > 0) {
            (bool feeSuccess, ) = admin.protocolFeeDestination().call{value: totalProtocolFee}("");
            if (!feeSuccess) revert FeeTransferFailed();
        }

        emit BatchTip(_msgSender(), totalAmount, totalProtocolFee, totalReferralFee);
    }

    /// @notice Send ERC20 tips to multiple addresses
    /// @param token The token address
    /// @param receivers Array of addresses to receive tips
    /// @param amounts Array of gross tip amounts for each receiver (fee deducted from each)
    /// @param totalAmount Sum of all amounts
    function batchTipToken(
        address token,
        address[] calldata receivers,
        uint256[] calldata amounts,
        uint256 totalAmount
    ) external whenNotPaused notSanctioned(_msgSender()) {
        if (receivers.length != amounts.length) revert Common.ArrayLengthMismatch(receivers.length, amounts.length);
        if (receivers.length == 0) revert Common.ZeroAmount();

        IERC20 tokenContract = IERC20(token);
        
        uint256 userBalance = tokenContract.balanceOf(_msgSender());
        if (totalAmount > userBalance) revert InsufficientTokenBalance(totalAmount, userBalance);

        uint256 userAllowance = tokenContract.allowance(_msgSender(), address(this));
        if (totalAmount > userAllowance) revert InsufficientTokenAllowance(totalAmount, userAllowance);

        uint256 feePercent = admin.tippingFeePercent();
        uint256 _referralFeePercent = address(referralManager) != address(0) ? admin.referralFeePercent() : 0;
        uint256 totalProtocolFee = 0;
        uint256 totalReferralFee = 0;
        uint256 sumAmounts = 0;

        for (uint256 i = 0; i < receivers.length; i++) {
            if (receivers[i] == address(0)) revert Common.ZeroAddress();
            if (receivers[i] == _msgSender()) revert SelfTransferNotAllowed(_msgSender());
            if (admin.isSanctioned(receivers[i])) revert Common.AddressSanctioned(receivers[i]);
            if (amounts[i] == 0) revert Common.ZeroAmount();
            
            uint256 fee = (amounts[i] * feePercent) / Common.FEE_PERCENT;
            uint256 refFee = (amounts[i] * _referralFeePercent) / WAD;
            uint256 netAmount = amounts[i] - fee - refFee;
            totalProtocolFee += fee;
            totalReferralFee += refFee;
            sumAmounts += amounts[i];

            tokenContract.safeTransferFrom(_msgSender(), receivers[i], netAmount);
        }

        if (sumAmounts != totalAmount) revert TotalAmountMismatch(totalAmount, sumAmounts);

        if (totalReferralFee > 0 && address(referralManager) != address(0)) {
            address senderReferrer = referralManager.getReferrer(_msgSender());
            uint256 referralFeeHalf = totalReferralFee / 2;
            uint256 referralFeeOtherHalf = totalReferralFee - referralFeeHalf;

            if (senderReferrer != address(0) && senderReferrer != _msgSender()) {
                tokenContract.safeTransferFrom(_msgSender(), senderReferrer, referralFeeOtherHalf);
            } else {
                totalProtocolFee += referralFeeOtherHalf;
            }
            // For batch, only sender's referrer gets the full referral (no per-receiver referrer split)
            totalProtocolFee += referralFeeHalf;
        } else {
            totalProtocolFee += totalReferralFee;
        }

        if (totalProtocolFee > 0) tokenContract.safeTransferFrom(_msgSender(), admin.protocolFeeDestination(), totalProtocolFee);

        emit BatchTipToken(token, _msgSender(), totalAmount, totalProtocolFee, totalReferralFee);
    }

    ///////////////////////////////////////////////////////////
    ///////            INTERNAL FUNCTIONS            //////////
    ///////////////////////////////////////////////////////////

    function _calculateReferralFee(uint256 amount) internal view returns (uint256) {
        if (address(referralManager) == address(0)) return 0;
        uint256 _referralFeePercent = admin.referralFeePercent();
        return (amount * _referralFeePercent) / WAD;
    }

    /// @notice Send referral fees for single tip (ETH). Returns unclaimed amount.
    function _sendToReferrers(address sender, address receiver, uint256 referralFee) internal returns (uint256 referrerExcess) {
        uint256 referralFeeHalf = referralFee / 2;
        uint256 referralFeeOtherHalf = referralFee - referralFeeHalf;
        address senderReferrer = referralManager.getReferrer(sender);
        address receiverReferrer = referralManager.getReferrer(receiver);
        referrerExcess = 0;

        if (senderReferrer != address(0) && senderReferrer != sender) {
            (bool success,) = senderReferrer.call{value: referralFeeOtherHalf, gas: GAS_FORWARD_AMOUNT}("");
            if (!success) {
                referrerExcess += referralFeeOtherHalf;
            }
        } else {
            referrerExcess += referralFeeOtherHalf;
        }

        if (receiverReferrer != address(0) && receiverReferrer != sender) {
            (bool success,) = receiverReferrer.call{value: referralFeeHalf, gas: GAS_FORWARD_AMOUNT}("");
            if (!success) {
                referrerExcess += referralFeeHalf;
            }
        } else {
            referrerExcess += referralFeeHalf;
        }

        return referrerExcess;
    }

    /// @notice Send referral fees for batch tip (ETH) - only sender's referrer. Returns unclaimed amount.
    function _sendToReferrersBatch(address sender, uint256 referralFee) internal returns (uint256 referrerExcess) {
        uint256 referralFeeHalf = referralFee / 2;
        uint256 referralFeeOtherHalf = referralFee - referralFeeHalf;
        address senderReferrer = referralManager.getReferrer(sender);
        referrerExcess = referralFeeHalf; // receiver half always goes to protocol in batch

        if (senderReferrer != address(0) && senderReferrer != sender) {
            (bool success,) = senderReferrer.call{value: referralFeeOtherHalf, gas: GAS_FORWARD_AMOUNT}("");
            if (!success) {
                referrerExcess += referralFeeOtherHalf;
            }
        } else {
            referrerExcess += referralFeeOtherHalf;
        }

        return referrerExcess;
    }
}
