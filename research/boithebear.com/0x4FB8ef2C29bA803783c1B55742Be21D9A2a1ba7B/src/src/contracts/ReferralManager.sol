// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IReferralErrors} from "./interfaces/errors/IReferralErrors.sol";
import {IAdmin} from "./interfaces/IAdmin.sol";
import {Common} from "./libraries/Common.sol";

contract ReferralManager is Initializable, OwnableUpgradeable, IReferralErrors {
    IAdmin public admin;
    mapping(address => address) public userToReferrer;
    mapping(address => bool) public authorizedCallers;

    event ReferralSet(address indexed user, address indexed referrer);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event AdminSet(address indexed newAdmin);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin) external initializer {
        __Ownable_init(msg.sender);
        admin = IAdmin(_admin);
    }
    
    modifier whenNotPaused() {
        if (admin.paused()) revert Common.ContractPaused();
        _;
    }
    
    function setAdmin(address _admin) external onlyOwner {
        admin = IAdmin(_admin);
        emit AdminSet(_admin);
    }

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerSet(caller, authorized);
    }

    /// @notice Admin can always set/update referrers
    function updateReferrer(address user, address referrer) external onlyOwner {
        userToReferrer[user] = referrer;
        emit ReferralSet(user, referrer);
    }

    /// @notice Admin can always set/update referrers in batch
    function updateReferrers(address[] calldata users, address[] calldata referrers) external onlyOwner {
        if (users.length != referrers.length) revert Common.ArrayLengthMismatch(users.length, referrers.length);
        for (uint256 i = 0; i < users.length; i++) {
            userToReferrer[users[i]] = referrers[i];
            emit ReferralSet(users[i], referrers[i]);
        }
    }

    /// @notice User can set their own referrer only if not already set
    /// @notice Authorized callers (like Tickets contract) can set on behalf of user
    function setReferrer(address user, address referrer) external whenNotPaused {
        if (user == referrer) revert SelfReferralNotAllowed();
        
        address currentReferrer = userToReferrer[user];
        
        if (currentReferrer == referrer) return; // No-op if already set to same referrer
        
        if (currentReferrer != address(0)) {
            revert ReferrerAlreadySet(currentReferrer);
        }
        
        // No referrer set - user themselves or authorized caller can set
        if (msg.sender != user && !authorizedCallers[msg.sender]) {
            revert Common.Unauthorized();
        }
        
        userToReferrer[user] = referrer;
        emit ReferralSet(user, referrer);
    }

    function getReferrer(address user) external view returns (address) {
        return userToReferrer[user];
    }
}
