// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./libs/ABDKMath64x64.sol";
import "./interfaces/events/ITicketsEvents.sol";
import "./interfaces/errors/ITicketsErrors.sol";
import "./interfaces/IAdmin.sol";
import "./interfaces/IReferralManager.sol";
import "./libraries/Common.sol";

contract Tickets is OwnableUpgradeable, ReentrancyGuardUpgradeable, ITicketsEvents, ITicketsErrors {

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    int128 immutable DEFAULT_WEIGHT_C_ABDK;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    int128 immutable ABDK_INTEGER_6;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    int128 immutable ABDK_INTEGER_3;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    int128 immutable ABDK_INTEGER_2;

    IAdmin public admin;
    IReferralManager public referralManager;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
        DEFAULT_WEIGHT_C_ABDK = ABDKMath64x64.fromUInt(DEFAULT_WEIGHT_C);
        ABDK_INTEGER_6 = ABDKMath64x64.fromUInt(6);
        ABDK_INTEGER_3 = ABDKMath64x64.fromUInt(3);
        ABDK_INTEGER_2 = ABDKMath64x64.fromUInt(2);
    }

    function initialize(
        address _admin,
        address _referralManager,
        uint256 _initialPrice
    ) public initializer {
        if (_admin == address(0)) revert Common.ZeroAddress();
        if (_referralManager == address(0)) revert Common.ZeroAddress();
        
        admin = IAdmin(_admin);
        referralManager = IReferralManager(_referralManager);
        initialPrice = _initialPrice;
        
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();
    }

    /// @notice Modifier to check if admin has paused the system
    modifier whenNotPaused() {
        if (admin.paused()) revert Common.ContractPaused();
        _;
    }

    modifier notSanctioned(address account) {
        if (admin.isSanctioned(account)) revert Common.AddressSanctioned(account);
        _;
    }

    uint256 constant public TICKET_DECIMALS = 100; // 1 full ticket = 100 fractions
    uint256 constant GAS_FORWARD_AMOUNT = 30_000;
    uint256 constant BUY_PRICE_EXTRA_AMOUNT = 10; // to prevent possible insolvency issues caused by rounding

    uint256 public initialPrice;

    uint256 constant WAD = Common.WAD;
    /// @notice The following constants are bonding curve parmeters and are not intended for change.
    uint256 constant DEFAULT_WEIGHT_A = (80 * WAD) / 100;
    uint256 constant DEFAULT_WEIGHT_B = (50 * WAD) / 100;
    uint256 constant DEFAULT_WEIGHT_C = 2;

    // SharesSubject => (Holder => Balance)
    mapping(address => mapping(address => uint256)) public sharesBalance;

    // SharesSubject => Supply
    mapping(address => uint256) public sharesSupply;

    mapping(address => uint256) tvl;

    mapping(address => address) public userToSigner;
    /// @notice subjectToFeePercent is percentage * WAD, e.g. 7 percent would be 7 * WAD
    mapping (address => uint256) public subjectToFeePercent;

    receive() external payable {
        /// We dont intend to do anything with received native currency.
    }

    ///////////////////////////////////////////////////////////
    ///////         ADMIN ONLY FUNCTIONS             //////////
    ///////////////////////////////////////////////////////////

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

    ///////////////////////////////////////////////////////////
    ///////              WRITE FUNCTIONS             //////////
    ///////////////////////////////////////////////////////////

    function buySharesWithReferrerForUser(address sharesSubject, address user, uint256 amount, address referrer) public payable notSanctioned(user) notSanctioned(sharesSubject) {
        if (referrer != address(0)) {
            referralManager.setReferrer(user, referrer);
        }
        buyShares(sharesSubject, user, amount);
    }

    function sellSharesWithReferrerForUser(address sharesSubject, address user, uint256 amount, address referrer) public payable notSanctioned(user) {
        if (referrer != address(0)) {
            referralManager.setReferrer(user, referrer);
        }
        sellShares(sharesSubject, user, amount);
    }

    function buyShares(address sharesSubject, address user, uint256 amount) public payable nonReentrant whenNotPaused notSanctioned(user) notSanctioned(sharesSubject) {
        _verifySigner(user);
        if (amount == 0) revert Common.ZeroAmount();

        uint256 initialSupply = sharesSupply[sharesSubject];
        uint256 price = getPrice(initialSupply, amount) + BUY_PRICE_EXTRA_AMOUNT; // to prevent a possibly curve illiquidity due to precision errors
        
        // Cache admin calls for gas optimization
        uint256 _protocolFeePercent = admin.protocolFeePercent();
        uint256 _referralFeePercent = admin.referralFeePercent();
        
        uint256 protocolFee = price * _protocolFeePercent / WAD;
        uint256 subjectFee = price * getSubjectFeePercent(sharesSubject) / WAD;
        uint256 referralFee = price * _referralFeePercent / WAD;
        uint256 totalPrice = price + protocolFee + subjectFee + referralFee;
        if (msg.value < totalPrice) revert Common.InsufficientPayment(totalPrice, msg.value);

        // Update state
        tvl[sharesSubject] += price;
        sharesBalance[sharesSubject][user] += amount;
        sharesSupply[sharesSubject] = initialSupply + amount;

        uint256 nextPrice = getPrice(initialSupply + amount, 1 * TICKET_DECIMALS) + BUY_PRICE_EXTRA_AMOUNT; // next full ticket
        uint256 myShares = sharesBalance[sharesSubject][user];
        uint256 totalShares = initialSupply + amount;

        _sendToSubject(_getUserOrSigner(sharesSubject), subjectFee);

        uint256 refundAmount = msg.value - totalPrice;

        if (refundAmount > 0) {
            _sendToSubject(msg.sender, refundAmount);
        }

        if (referralFee > 0) {
            protocolFee += _sendToReferrers(user, sharesSubject, referralFee);
        }
        _sendToProtocol(protocolFee);
        emit Trade(user, sharesSubject, true /* isBuy */, amount, price, protocolFee, subjectFee, referralFee, totalShares, nextPrice, myShares);
    }

    function sellShares(address sharesSubject, address user, uint256 amount) public payable nonReentrant whenNotPaused notSanctioned(user) {
        _verifySigner(user);
        if (amount == 0) revert Common.ZeroAmount();

        uint256 initialSupply = sharesSupply[sharesSubject];
        if (initialSupply < amount) revert InsufficientShares(amount, initialSupply);
        uint256 initialUserShareBalance = sharesBalance[sharesSubject][user];
        if (initialUserShareBalance < amount) revert InsufficientShares(amount, initialUserShareBalance);
        uint256 price = getPrice(initialSupply - amount, amount);
        uint256 sharesTvl = tvl[sharesSubject];
        // solvency guard
        if(price > sharesTvl) {
            price = sharesTvl;
        }
        
        // Cache admin calls for gas optimization
        uint256 _protocolFeePercent = admin.protocolFeePercent();
        uint256 _referralFeePercent = admin.referralFeePercent();
        
        uint256 protocolFee = price * _protocolFeePercent / WAD;
        uint256 subjectFee = price * getSubjectFeePercent(sharesSubject) / WAD;
        uint256 referralFee = price * _referralFeePercent / WAD;
        
        // Update state (use unchecked for safe subtractions - already validated)
        uint256 newSupply;
        uint256 newUserBalance;
        unchecked {
            tvl[sharesSubject] = sharesTvl - price;
            newUserBalance = initialUserShareBalance - amount;
            newSupply = initialSupply - amount;
            sharesBalance[sharesSubject][user] = newUserBalance;
            sharesSupply[sharesSubject] = newSupply;
        }

        uint256 nextPrice = getPrice(newSupply, 1 * TICKET_DECIMALS) + BUY_PRICE_EXTRA_AMOUNT; // next full ticket
        uint256 myShares = newUserBalance;
        uint256 totalShares = newSupply;

        _sendToSubject(msg.sender, price - protocolFee - subjectFee - referralFee);

        _sendToSubject(_getUserOrSigner(sharesSubject), subjectFee);

        if (referralFee > 0) {
            protocolFee += _sendToReferrers(user, sharesSubject, referralFee);
        }
        _sendToProtocol(protocolFee);

        emit Trade(user, sharesSubject, false /* isBuy */, amount, price, protocolFee, subjectFee, referralFee, totalShares, nextPrice, myShares);
    }

    function migrateSigner(address newSigner, address user) external {
        _verifySigner(user);
        if (newSigner == msg.sender) revert SignerCannotBeSame();
        if (newSigner == user) revert SignerCannotBeUser();
        userToSigner[user] = newSigner;
        emit SignerSet(user, newSigner, msg.sender);
    }

    /// @notice feeAmountInPercent can be 0-8. Upper limit defined by global subjectFeePercent.
    function setIndividualSubjectFee(address user, uint256 feeAmountInPercent) external {
        _verifySigner(user);
        uint256 individualFeePercent = feeAmountInPercent * WAD / 100;
        uint256 maxFee = admin.subjectFeePercent();
        if (individualFeePercent > maxFee) revert IndividualFeeExceedsMax(individualFeePercent, maxFee);
        subjectToFeePercent[user] = individualFeePercent;
        emit IndividualSubjectFeeSet(user, feeAmountInPercent);
    }

    function transferShares(address sharesSubject, address from, address to, uint256 amount) external notSanctioned(from) notSanctioned(to) {
        _verifySigner(from);
        if (amount == 0) revert Common.ZeroAmount();
        if (to == address(0)) revert Common.ZeroAddress();
        if (from == to) revert SelfTransferNotAllowed();
        if (sharesBalance[sharesSubject][from] < amount) revert InsufficientShares(amount, sharesBalance[sharesSubject][from]);
        sharesBalance[sharesSubject][from] -= amount;
        sharesBalance[sharesSubject][to] += amount;
        emit TransferShares(sharesSubject, from, to, amount);
    }

    ///////////////////////////////////////////////////////////
    ///////              READ FUNCTIONS              //////////
    ///////////////////////////////////////////////////////////

    function getSubjectTvl(address sharesSubject) public view returns (uint256) {
        return tvl[sharesSubject];
    }

    function getPrice(uint256 supply, uint256 amount) public view returns (uint256) {
        int128 scaledAmount = ABDKMath64x64.divu(amount, TICKET_DECIMALS);
        int128 scaledSupply = ABDKMath64x64.divu(supply, TICKET_DECIMALS);

        int128 adjustedSupply = ABDKMath64x64.add(  
            scaledSupply,
            DEFAULT_WEIGHT_C_ABDK
        );

        if (ABDKMath64x64.toUInt(adjustedSupply) == 0) {
            return initialPrice;
        }

        int128 sum1 = _calculateSumABDK(adjustedSupply);
        int128 sum2 = _calculateSumABDK(ABDKMath64x64.add(adjustedSupply, scaledAmount));

        int128 subRes = ABDKMath64x64.sub(sum2, sum1);
        subRes = ABDKMath64x64.div(subRes, ABDK_INTEGER_6);

        uint256 intermediateRes = ABDKMath64x64.mulu(subRes, DEFAULT_WEIGHT_A);
        uint256 finalPrice = (intermediateRes * initialPrice * DEFAULT_WEIGHT_B) / (WAD * WAD);
        return finalPrice;
    }

    function getSharesSupply(address sharesSubject) public view returns (uint256) {
        return sharesSupply[sharesSubject];
    }

    function getMyShares(address sharesSubject) public view returns (uint256) {
        return sharesBalance[sharesSubject][msg.sender];
    }

    function getMyShares(address sharesSubject, address user) public view returns (uint256) {
        return sharesBalance[sharesSubject][user];
    }

    function getBuyPrice(address sharesSubject, uint256 amount) public view returns (uint256) {
        return getPrice(sharesSupply[sharesSubject], amount) + BUY_PRICE_EXTRA_AMOUNT;
    }

    function getSellPrice(address sharesSubject, uint256 amount) public view returns (uint256) {
        uint256 subjectSharesSupply = sharesSupply[sharesSubject];
        if (amount == 0 || subjectSharesSupply < amount) {
            return 0;
        }
        else {
            return getPrice(subjectSharesSupply - amount, amount);
        }
    }

    function getBuyPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256) {
        uint256 price = getBuyPrice(sharesSubject, amount);
        uint256 protocolFee = price * admin.protocolFeePercent() / WAD;
        uint256 subjectFee = price * getSubjectFeePercent(sharesSubject) / WAD;
        uint256 referralFee = price * admin.referralFeePercent() / WAD;
        return price + protocolFee + subjectFee + referralFee;
    }

    function getSellPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256) {
        uint256 price = getSellPrice(sharesSubject, amount);
        uint256 protocolFee = price * admin.protocolFeePercent() / WAD;
        uint256 subjectFee = price * getSubjectFeePercent(sharesSubject) / WAD;
        uint256 referralFee = price * admin.referralFeePercent() / WAD;
        return price - protocolFee - subjectFee - referralFee;
    }

    function getSubjectFeePercent(address subject) public view returns (uint256) {
        uint256 individualSubjectFeePercent = subjectToFeePercent[subject];
        if(individualSubjectFeePercent > 0) {
            return individualSubjectFeePercent;
        }
        else{
            return admin.subjectFeePercent();
        }
    }

    /// @notice returns referrer's signer if it exists
    function getReferrer(address user) view external returns (address){
        address referrer = referralManager.getReferrer(user);
        if(referrer == address(0)) {
            return address(0);
        }
        address signerOfReferrer = userToSigner[referrer];
        if(signerOfReferrer != address(0)) {
            return signerOfReferrer;
        }
        else{
            return referrer;
        }
    }

    ///////////////////////////////////////////////////////////
    ///////            INTERNAL FUNCTIONS            //////////
    ///////////////////////////////////////////////////////////

    function _getUserOrSigner(address user) internal view returns (address recipient) {
        recipient = user;
        address signer = userToSigner[user];
        if(signer != address(0)) {
            recipient = signer;
        }
    }

    function _sendToSubject(address sharesSubject, uint256 subjectFee) internal {
        (bool success, bytes memory returnData) = sharesSubject.call{value: subjectFee}("");
        if(!success) {
            revert SendToSubjectFailed(returnData);
        }
    }

    function _sendToProtocol(uint256 protocolFee) internal {
        (bool success, bytes memory returnData) = admin.protocolFeeDestination().call{value: protocolFee}("");
        if(!success) {
            revert SendToProtocolFailed(returnData);
        }
    }

    function _sendToReferrers(address sender, address subject, uint256 referralFee) internal returns(uint256 referrerExcess) {
        uint256 referralFeeHalf = referralFee/2;
        uint256 referralFeeOtherHalf = referralFee - referralFeeHalf; // handles odd case
        address traderReferrer = referralManager.getReferrer(sender);
        address subjectReferrer = referralManager.getReferrer(subject);
        traderReferrer = _getUserOrSigner(traderReferrer);
        subjectReferrer = _getUserOrSigner(subjectReferrer);
        referrerExcess = 0;
        // if the refferral fee recipient is an authorized signer of the user, this is considered self trade
        if (traderReferrer != address(0) && traderReferrer != sender && userToSigner[sender] != traderReferrer) {
            (bool success,) = traderReferrer.call{value: referralFeeOtherHalf, gas: GAS_FORWARD_AMOUNT}("");
            if (!success) {
                referrerExcess += referralFeeOtherHalf;
            }
        } else {
            referrerExcess += referralFeeOtherHalf;
        }

        if (subjectReferrer != address(0) && subjectReferrer != sender && userToSigner[sender] != subjectReferrer) {
            (bool success,) = subjectReferrer.call{value: referralFeeHalf, gas: GAS_FORWARD_AMOUNT}("");
            if (!success) {
                referrerExcess += referralFeeHalf;
            }
        } else {
            referrerExcess += referralFeeHalf;
        }

        return referrerExcess;
    }

    function _calculateSumABDK(int128 adjustedSupply) internal view returns (int128) {
        if (ABDKMath64x64.toUInt(adjustedSupply) == 0) revert AdjustedSupplyMustBePositive();

        int128 term_2_n_3 = ABDKMath64x64.mul(ABDKMath64x64.pow(adjustedSupply, 3), ABDK_INTEGER_2);
        int128 term_3_n_2 = ABDKMath64x64.mul(ABDKMath64x64.pow(adjustedSupply, 2), ABDK_INTEGER_3);
        int128 sum = ABDKMath64x64.sub(term_2_n_3, term_3_n_2);
        int128 intersum = ABDKMath64x64.add(sum, adjustedSupply);
        return intersum;
    }

    function _verifySigner(address user) internal view {
        if(userToSigner[user] != address(0)) {
            if (userToSigner[user] != msg.sender) revert InvalidSigner(userToSigner[user], msg.sender);
        }
        else {
            if (user != msg.sender) revert InvalidSigner(user, msg.sender);
        }
    }
}
