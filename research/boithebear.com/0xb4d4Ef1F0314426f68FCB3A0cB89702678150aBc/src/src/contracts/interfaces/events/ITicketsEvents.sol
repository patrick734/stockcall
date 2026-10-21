// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITicketsEvents {
    /// @notice buyPrice in the following events is denominated in Wei.
    event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 amount, uint256 protocolAmount, uint256 subjectAmount, uint256 referralAmount, uint256 supply, uint256 buyPrice, uint256 myShares);
    event ReferralSet(address user, address referrer);
    event SignerSet(address user, address signer, address previousSigner);
    event IndividualSubjectFeeSet(address user, uint256 individualFeePercent);
    event TransferShares(address sharesSubject, address from, address to, uint256 amount);
    event FeeDestination(address newFeeDestination, address previousFeeDestination);
    event FeeDestination2(address newFeeDestination2, address previousFeeDestination2);
    event ProtocolFeePercent(uint256 newProtocolFeePercent);
    event ReferralFeePercent(uint256 newReferralFeePercent);
    event SubjectFeePercent(uint256 newSubjectFeePercent);
    event AdminSet(address newAdmin);
    event ReferralManagerSet(address newReferralManager);
}
