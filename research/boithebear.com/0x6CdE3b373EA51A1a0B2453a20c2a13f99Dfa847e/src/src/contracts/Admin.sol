// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IAdminErrors} from "./interfaces/errors/IAdminErrors.sol";
import {ISanctionsList} from "./interfaces/ISanctionsList.sol";
import {Common} from "./libraries/Common.sol";

contract Admin is Initializable, OwnableUpgradeable, IAdminErrors {
    uint256 constant WAD = Common.WAD;
    uint256 constant FEE_DENOMINATOR = Common.FEE_PERCENT;

    uint256 constant MAX_REFERRAL_FEE = 200 * WAD / FEE_DENOMINATOR;   // 2%
    uint256 constant MAX_PROTOCOL_FEE = 400 * WAD / FEE_DENOMINATOR;  // 4%
    uint256 constant MAX_TIPPING_FEE = 1000;                          // 10% (basis points)
    uint256 constant MAX_SUBJECT_FEE = 800 * WAD / FEE_DENOMINATOR;   // 8%

    address public protocolFeeDestination;
    uint256 public protocolFeePercent;
    uint256 public tippingFeePercent;
    uint256 public subjectFeePercent;
    uint256 public referralFeePercent;
    bool public paused;
    address public sanctionsList;

    event FeeDestinationUpdated(address indexed newFeeDestination, address indexed previousFeeDestination);
    event ProtocolFeePercentUpdated(uint256 newProtocolFeePercent);
    event TippingFeePercentUpdated(uint256 newTippingFeePercent);
    event ReferralFeePercentUpdated(uint256 newReferralFeePercent);
    event SubjectFeePercentUpdated(uint256 newSubjectFeePercent);
    event PausedUpdated(bool paused);
    event SanctionsListUpdated(address indexed newSanctionsList, address indexed previousSanctionsList);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _protocolFeeDestination,
        uint256 _protocolFeePercent,
        uint256 _tippingFeePercent,
        uint256 _subjectFeePercent,
        uint256 _referralFeePercent
    ) external initializer {
        if (_protocolFeeDestination == address(0)) revert Common.ZeroAddress();

        __Ownable_init(msg.sender);

        protocolFeeDestination = _protocolFeeDestination;
        protocolFeePercent = _protocolFeePercent;
        tippingFeePercent = _tippingFeePercent;
        subjectFeePercent = _subjectFeePercent;
        referralFeePercent = _referralFeePercent;
        paused = true;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedUpdated(_paused);
    }

    function setReferralFeePercent(uint256 _feePercent) external onlyOwner {
        if (_feePercent > MAX_REFERRAL_FEE) revert InvalidFeePercent(_feePercent, MAX_REFERRAL_FEE);
        referralFeePercent = _feePercent;
        emit ReferralFeePercentUpdated(_feePercent);
    }

    function setProtocolFeePercent(uint256 _feePercent) external onlyOwner {
        if (_feePercent > MAX_PROTOCOL_FEE) revert InvalidFeePercent(_feePercent, MAX_PROTOCOL_FEE);
        protocolFeePercent = _feePercent;
        emit ProtocolFeePercentUpdated(_feePercent);
    }

    function setTippingFeePercent(uint256 _feePercent) external onlyOwner {
        if (_feePercent > MAX_TIPPING_FEE) revert InvalidFeePercent(_feePercent, MAX_TIPPING_FEE);
        tippingFeePercent = _feePercent;
        emit TippingFeePercentUpdated(_feePercent);
    }

    function setSubjectFeePercent(uint256 _feePercent) external onlyOwner {
        if (_feePercent > MAX_SUBJECT_FEE) revert InvalidFeePercent(_feePercent, MAX_SUBJECT_FEE);
        subjectFeePercent = _feePercent;
        emit SubjectFeePercentUpdated(_feePercent);
    }

    function setFeeDestination(address _feeDestination) external {
        if (_msgSender() != protocolFeeDestination) revert Common.Unauthorized();
        if (_feeDestination == address(0)) revert Common.ZeroAddress();
        address oldDestination = protocolFeeDestination;
        protocolFeeDestination = _feeDestination;
        emit FeeDestinationUpdated(_feeDestination, oldDestination);
    }

    function setSanctionsList(address _sanctionsList) external onlyOwner {
        address oldSanctionsList = sanctionsList;
        sanctionsList = _sanctionsList;
        emit SanctionsListUpdated(_sanctionsList, oldSanctionsList);
    }

    function isSanctioned(address account) public view returns (bool) {
        if (sanctionsList == address(0)) return false;
        try ISanctionsList(sanctionsList).isSanctioned(account) returns (bool result) {
            return result;
        } catch {
            return false;
        }
    }
}
