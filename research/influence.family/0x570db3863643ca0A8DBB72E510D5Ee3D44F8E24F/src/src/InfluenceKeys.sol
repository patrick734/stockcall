// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInfluenceStaking} from "./interfaces/IInfluenceStaking.sol";

/// @title InfluenceKeys
/// @notice Fractional creator keys priced in ETH on the Arena / BOI bonding curve. One key is
///         UNIT (100) units, so the smallest trade is 0.01 key. With supply S and amount x in
///         units, A = S + 2 * UNIT and G(A) = 2A^3 - 300A^2 + 10000A, the pre-fee price is
///         INITIAL_PRICE * (G(A + x) - G(A)) / 15_000_000. The first whole key costs
///         1.6 * INITIAL_PRICE and whole key number n (n keys already out) costs
///         0.4 * INITIAL_PRICE * (n + 2)^2.
///
///         No activation step: anyone may buy any amount of any creator's keys from supply 0,
///         the creator included, and a sell may take the supply back to 0. Exactly like The
///         Arena, the next buy at supply 0 is priced from A = 2 * UNIT again.
///
///         Every trade pays three fees on the pre-fee price: a protocol fee, a creator fee and a
///         referral fee. The referral fee is split in two halves, exactly like BOI: one half goes
///         to the trader's bound referrer and the other to the creator's bound referrer
///         (referrerOf[creator]). A half with nobody to pay (no referrer bound, or the referrer is
///         the trader or the creator of that trade) is added to the protocol fee instead. The
///         protocol fee is split between token stakers and the treasury. Traders who stake the
///         platform token pay a reduced protocol fee, and a creator may lower their own creator fee.
///
///         Referrers are bound on an account's first trade with a non-zero referrer, never to
///         themselves and never overwritten. A creator's referrer is whoever referred them when
///         they first traded any keys, including their own.
/// @dev    Rounding: buys round the pre-fee price up, sells round it down, and a sell can never
///         take more than the ETH held on that creator's curve (tvl), so the contract always holds
///         every curve reserve plus every unclaimed fee. The tvl cap is what keeps the contract
///         solvent when a curve is sold all the way down to supply 0.
///
///         Creator, referrer and treasury earnings are pull payments so that a recipient that
///         rejects ETH can never block other people's trades.
///
///         Chain pinned: the constructor reverts unless block.chainid equals the CHAIN_ID
///         argument, so an artefact built for one chain cannot land on another.
///
///         Pause scope: pause() only blocks buyKeys. Sells and claims always work, so a pause can
///         never trap a holder's ETH or a creator's earnings.
///
///         Launch window: for LAUNCH_WINDOW after a creator's keys are first bought (supply goes
///         from 0 to above 0, launchedAt[creator] records the time) one buyer may hold at most
///         LAUNCH_CAP units of that creator, so nobody can corner a fresh curve. After the window
///         there is no cap. A curve sold back to 0 starts a new window on its next first buy.
///
///         Staking is optional: the contract may be deployed with staking unset (address(0)) so
///         that keys can trade before the platform token exists. While it is unset nobody has a
///         tier, so every trader pays the full protocol fee, and the stakers' share of that fee
///         goes to the treasury's claimable balance. The owner attaches the staking contract once
///         with setStaking; after that it can never change and the discount and the staker share
///         work as described above.
contract InfluenceKeys is Ownable2Step, Pausable, ReentrancyGuard {
    /// @notice Units per key. Supplies, balances and every amount argument are in units.
    uint256 public constant UNIT = 100;
    /// @notice How long the per-buyer cap lasts after a creator's first buy.
    uint256 public constant LAUNCH_WINDOW = 5 minutes;
    /// @notice The most one buyer may hold of a creator inside the launch window: 10 keys.
    uint256 public constant LAUNCH_CAP = 10 * UNIT;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 400;
    uint256 public constant MAX_CREATOR_FEE_BPS = 800;
    uint256 public constant MAX_REFERRAL_FEE_BPS = 200;
    /// @notice Lowest creator fee a creator may set for themselves.
    uint256 public constant MIN_CREATOR_FEE_BPS = 100;
    /// @dev Divisor of the curve polynomial; see the contract notice.
    uint256 public constant CURVE_DIVISOR = 15_000_000;

    /// @notice The chain this deployment was built for (4663 mainnet, 46630 testnet, 31337 local).
    uint256 public immutable CHAIN_ID;
    /// @notice Curve scale in wei. The first whole key costs 1.6 times this.
    uint256 public immutable INITIAL_PRICE;
    /// @notice The staking contract, or address(0) until the owner attaches it with setStaking.
    ///         Set once (in the constructor or by setStaking) and never changed afterwards.
    IInfluenceStaking public staking;

    address public treasury;
    uint256 public protocolFeeBps;
    uint256 public creatorFeeBps;
    uint256 public referralFeeBps;
    /// @notice Share of the protocol fee paid to token stakers; the rest goes to the treasury.
    uint256 public stakerShareBps;
    /// @notice Protocol fee discount per staking tier (index 0 = no tier).
    uint256[] private _tierDiscountBps;

    mapping(address creator => mapping(address holder => uint256)) public keysBalance;
    mapping(address creator => uint256) public keysSupply;
    /// @notice ETH held on a creator's curve: buys add the pre-fee price, sells subtract it.
    mapping(address creator => uint256) public tvl;
    /// @notice When a creator's keys were last first bought (supply went from 0 to above 0).
    mapping(address creator => uint256) public launchedAt;
    /// @notice A creator's own creator fee; 0 means the default creatorFeeBps.
    mapping(address creator => uint256) public creatorFeeBpsOf;
    /// @notice Referrer bound to an account on its first trade with a non-zero referrer. Read for
    ///         the trader and for the creator on every trade (see _distributeFees).
    mapping(address trader => address) public referrerOf;
    mapping(address account => uint256) public claimable;

    /// @param ethAmount Pre-fee price of the trade.
    /// @param protocolFee Protocol fee charged on the price, before any unpaid referral half is
    ///        added to it.
    /// @param referralFee Referral fee actually credited to referrers: the sum of the paid halves.
    /// @param supply Supply of the creator's keys after the trade, in units.
    /// @param nextPrice Price of the next whole key after the trade, getPrice(supply, UNIT).
    /// @param holderBalance The trader's balance of the creator's keys after the trade, in units.
    event Trade(
        address indexed trader,
        address indexed creator,
        bool isBuy,
        uint256 amount,
        uint256 ethAmount,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 referralFee,
        uint256 supply,
        uint256 nextPrice,
        uint256 holderBalance
    );
    event ReferrerSet(address indexed trader, address indexed referrer);
    event Claimed(address indexed account, uint256 amount);
    event CreatorFeeSet(address indexed creator, uint256 bps);
    event FeesUpdated(uint256 protocolFeeBps, uint256 creatorFeeBps, uint256 referralFeeBps, uint256 stakerShareBps);
    event TierDiscountsUpdated(uint256[] discounts);
    event TreasuryUpdated(address treasury);
    event StakingSet(address staking);

    error WrongChain(uint256 expected, uint256 actual);
    error ZeroAmount();
    error ZeroAddress();
    error ZeroPrice();
    error InsufficientPayment(uint256 required);
    error InsufficientKeys();
    error LaunchCap(uint256 maxUnits);
    error Slippage(uint256 proceeds);
    error InvalidFees();
    error NothingToClaim();
    error EthTransferFailed();
    error NotTreasury();
    error StakingAlreadySet();

    /// @param chainId_ Expected chain id; the constructor reverts with WrongChain on any other chain.
    /// @param staking_ The staking contract, or address(0) to deploy without one and attach it
    ///        later with setStaking.
    /// @param initialPrice_ Curve scale in wei (0.000048 ether on the ETH chains BOI runs on).
    constructor(uint256 chainId_, address staking_, address treasury_, address owner_, uint256 initialPrice_)
        Ownable(owner_)
    {
        if (block.chainid != chainId_) revert WrongChain(chainId_, block.chainid);
        if (treasury_ == address(0)) revert ZeroAddress();
        if (initialPrice_ == 0) revert ZeroPrice();
        CHAIN_ID = chainId_;
        INITIAL_PRICE = initialPrice_;
        if (staking_ != address(0)) {
            staking = IInfluenceStaking(staking_);
            emit StakingSet(staking_);
        }
        treasury = treasury_;

        protocolFeeBps = 200;
        creatorFeeBps = 700;
        referralFeeBps = 100;
        stakerShareBps = 5_000;

        _tierDiscountBps = [0, 1_000, 2_500, 5_000, 7_500];
    }

    // ---------------------------------------------------------------- pricing

    /// @notice Pre-fee price of `amount` units when `supply` units already exist, rounded down.
    ///         The reference for the TypeScript mirror; trades use getBuyPrice and getSellPrice.
    function getPrice(uint256 supply, uint256 amount) public view returns (uint256) {
        return _priceNumerator(supply, amount) / CURVE_DIVISOR;
    }

    /// @notice Pre-fee cost of buying `amount` units of `creator`, rounded up.
    function getBuyPrice(address creator, uint256 amount) public view returns (uint256) {
        uint256 numerator = _priceNumerator(keysSupply[creator], amount);
        return numerator == 0 ? 0 : (numerator - 1) / CURVE_DIVISOR + 1;
    }

    /// @notice Pre-fee proceeds of selling `amount` units of `creator`, rounded down and never
    ///         more than the ETH held on that creator's curve. 0 when `amount` exceeds the supply.
    function getSellPrice(address creator, uint256 amount) public view returns (uint256) {
        uint256 supply = keysSupply[creator];
        if (amount > supply) return 0;
        uint256 price = getPrice(supply - amount, amount);
        uint256 reserve = tvl[creator];
        return price > reserve ? reserve : price;
    }

    /// @notice Price of the next whole key of `creator`, for display.
    function getNextKeyPrice(address creator) external view returns (uint256) {
        return getPrice(keysSupply[creator], UNIT);
    }

    /// @notice Total ETH `trader` must send to buy `amount` units of `creator`.
    function getBuyCost(address creator, uint256 amount, address trader) external view returns (uint256) {
        uint256 price = getBuyPrice(creator, amount);
        (uint256 protocolFee, uint256 creatorFee, uint256 referralFee) = _fees(price, trader, creator);
        return price + protocolFee + creatorFee + referralFee;
    }

    /// @notice ETH `trader` receives for selling `amount` units of `creator`; 0 when `amount`
    ///         exceeds the supply.
    function getSellProceeds(address creator, uint256 amount, address trader) external view returns (uint256) {
        uint256 price = getSellPrice(creator, amount);
        (uint256 protocolFee, uint256 creatorFee, uint256 referralFee) = _fees(price, trader, creator);
        return price - protocolFee - creatorFee - referralFee;
    }

    /// @notice Protocol fee for `trader` after their staking tier discount. The full
    ///         protocolFeeBps while staking is unset: nobody has a tier yet.
    function protocolFeeBpsFor(address trader) public view returns (uint256) {
        IInfluenceStaking staking_ = staking;
        if (address(staking_) == address(0)) return protocolFeeBps;
        uint256 tier = staking_.tierOf(trader);
        uint256 len = _tierDiscountBps.length;
        if (len == 0) return protocolFeeBps;
        if (tier >= len) tier = len - 1;
        return (protocolFeeBps * (BPS - _tierDiscountBps[tier])) / BPS;
    }

    /// @notice Creator fee charged on `creator`'s keys: their own setting when it is below the
    ///         default, otherwise the default.
    function creatorFeeBpsFor(address creator) public view returns (uint256) {
        uint256 own = creatorFeeBpsOf[creator];
        return own == 0 || own > creatorFeeBps ? creatorFeeBps : own;
    }

    function tierDiscounts() external view returns (uint256[] memory) {
        return _tierDiscountBps;
    }

    /// @notice Units `buyer` may still buy of `creator` under the launch cap: LAUNCH_CAP less what
    ///         they hold while the window is open (or before the first buy, which opens it), and
    ///         type(uint256).max once the window has passed.
    function launchCapRemaining(address creator, address buyer) external view returns (uint256) {
        if (!_inLaunchWindow(creator)) return type(uint256).max;
        uint256 held = keysBalance[creator][buyer];
        return held >= LAUNCH_CAP ? 0 : LAUNCH_CAP - held;
    }

    // ---------------------------------------------------------------- trading

    /// @notice Buy `amount` units of `creator`. Blocked while paused.
    /// @param referrer Bound to the caller on their first trade only; pass address(0) for none.
    /// @dev   Anyone may make the first buy, of any amount. The first buy (supply 0) opens the
    ///        launch window, inside which one buyer may hold at most LAUNCH_CAP units.
    ///        `msg.value` is the maximum the caller is willing to pay; any excess is refunded.
    function buyKeys(address creator, uint256 amount, address referrer) external payable nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (creator == address(0)) revert ZeroAddress();
        uint256 supply = keysSupply[creator];
        if (supply == 0) launchedAt[creator] = block.timestamp;
        uint256 heldAfter = keysBalance[creator][msg.sender] + amount;
        if (heldAfter > LAUNCH_CAP && _inLaunchWindow(creator)) revert LaunchCap(LAUNCH_CAP);

        uint256 price = getBuyPrice(creator, amount);
        (uint256 protocolFee, uint256 creatorFee, uint256 referralFee) = _fees(price, msg.sender, creator);
        uint256 refund;
        {
            uint256 total = price + protocolFee + creatorFee + referralFee;
            if (msg.value < total) revert InsufficientPayment(total);
            refund = msg.value - total;
        }

        _bindReferrer(msg.sender, referrer);

        supply += amount;
        keysBalance[creator][msg.sender] = heldAfter;
        keysSupply[creator] = supply;
        tvl[creator] += price;

        uint256 referralPaid = _distributeFees(creator, msg.sender, protocolFee, creatorFee, referralFee);
        _emitTrade(creator, true, amount, price, protocolFee, creatorFee, referralPaid, supply, heldAfter);

        if (refund != 0) _sendEth(msg.sender, refund);
    }

    /// @notice Sell `amount` units of `creator` back down the curve. Never pausable.
    /// @dev   A sell may take the supply all the way to 0; the proceeds are capped at tvl.
    function sellKeys(address creator, uint256 amount, uint256 minProceeds) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (keysBalance[creator][msg.sender] < amount) revert InsufficientKeys();
        uint256 supply = keysSupply[creator];

        uint256 price = getSellPrice(creator, amount);
        (uint256 protocolFee, uint256 creatorFee, uint256 referralFee) = _fees(price, msg.sender, creator);
        uint256 proceeds = price - protocolFee - creatorFee - referralFee;
        if (proceeds < minProceeds) revert Slippage(proceeds);

        supply -= amount;
        uint256 heldAfter = keysBalance[creator][msg.sender] - amount;
        keysBalance[creator][msg.sender] = heldAfter;
        keysSupply[creator] = supply;
        tvl[creator] -= price;

        uint256 referralPaid = _distributeFees(creator, msg.sender, protocolFee, creatorFee, referralFee);
        _emitTrade(creator, false, amount, price, protocolFee, creatorFee, referralPaid, supply, heldAfter);

        _sendEth(msg.sender, proceeds);
    }

    /// @notice Withdraw accumulated creator fees, referral fees or treasury revenue. Never pausable.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        _sendEth(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Set the creator fee on the caller's own keys, between MIN_CREATOR_FEE_BPS and the
    ///         default creatorFeeBps. Pass 0 to go back to the default.
    function setCreatorFee(uint256 bps) external {
        if (bps != 0 && (bps < MIN_CREATOR_FEE_BPS || bps > creatorFeeBps)) revert InvalidFees();
        creatorFeeBpsOf[msg.sender] = bps;
        emit CreatorFeeSet(msg.sender, bps);
    }

    // ------------------------------------------------------------------ admin

    function setFees(uint256 protocolFeeBps_, uint256 creatorFeeBps_, uint256 referralFeeBps_, uint256 stakerShareBps_)
        external
        onlyOwner
    {
        if (
            protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS || creatorFeeBps_ > MAX_CREATOR_FEE_BPS
                || referralFeeBps_ > MAX_REFERRAL_FEE_BPS || stakerShareBps_ > BPS
        ) revert InvalidFees();
        protocolFeeBps = protocolFeeBps_;
        creatorFeeBps = creatorFeeBps_;
        referralFeeBps = referralFeeBps_;
        stakerShareBps = stakerShareBps_;
        emit FeesUpdated(protocolFeeBps_, creatorFeeBps_, referralFeeBps_, stakerShareBps_);
    }

    function setTierDiscounts(uint256[] calldata discounts) external onlyOwner {
        uint256 len = discounts.length;
        if (len > 9) revert InvalidFees();
        for (uint256 i = 0; i < len; ++i) {
            if (discounts[i] > BPS) revert InvalidFees();
        }
        _tierDiscountBps = discounts;
        emit TierDiscountsUpdated(discounts);
    }

    /// @notice Hand the treasury role to another address. Only the current treasury may call it
    ///         (like BOI's setFeeDestination), not the owner, so a compromised owner key cannot
    ///         redirect protocol revenue. Earnings already credited to the old treasury stay
    ///         claimable by it.
    function setTreasury(address treasury_) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Attach the staking contract. Allowed once, and only while staking is unset: after
    ///         this call (or a constructor that was given a staking address) it can never change.
    ///         From the next trade on, stakers get their tier discount and their share of the
    ///         protocol fee. Fees already credited to the treasury stay with the treasury.
    /// @dev   The tierOf call is a probe: it makes the transaction revert when `staking_` is not
    ///        a contract that answers the staking interface, because a wrong address here could
    ///        never be corrected and would make every later trade revert.
    function setStaking(address staking_) external onlyOwner {
        if (address(staking) != address(0)) revert StakingAlreadySet();
        if (staking_ == address(0)) revert ZeroAddress();
        IInfluenceStaking(staking_).tierOf(address(this));
        staking = IInfluenceStaking(staking_);
        emit StakingSet(staking_);
    }

    /// @notice Stops new buys. Sells, claims and every view keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --------------------------------------------------------------- internal

    /// @dev G(a) = 2a^3 - 300a^2 + 10000a, evaluated so that no intermediate underflows. For every
    ///      a >= 2 * UNIT the polynomial is positive and increasing. Checked uint256 math cannot
    ///      overflow for any supply below about 1e25 units.
    function _curve(uint256 a) private pure returns (uint256) {
        return 2 * a * a * a + 10_000 * a - 300 * a * a;
    }

    /// @dev INITIAL_PRICE * (G(A + amount) - G(A)) with A = supply + 2 * UNIT; callers divide by
    ///      CURVE_DIVISOR rounding whichever way keeps the contract solvent.
    function _priceNumerator(uint256 supply, uint256 amount) private view returns (uint256) {
        uint256 a = supply + 2 * UNIT;
        return INITIAL_PRICE * (_curve(a + amount) - _curve(a));
    }

    /// @dev True before a creator's first buy (the next buy opens the window) and for LAUNCH_WINDOW
    ///      after it. Called from buyKeys after launchedAt has been stamped for a first buy.
    function _inLaunchWindow(address creator) private view returns (bool) {
        if (keysSupply[creator] == 0) return true;
        return block.timestamp < launchedAt[creator] + LAUNCH_WINDOW;
    }

    function _fees(uint256 price, address trader, address creator)
        private
        view
        returns (uint256 protocolFee, uint256 creatorFee, uint256 referralFee)
    {
        protocolFee = (price * protocolFeeBpsFor(trader)) / BPS;
        creatorFee = (price * creatorFeeBpsFor(creator)) / BPS;
        referralFee = (price * referralFeeBps) / BPS;
    }

    function _bindReferrer(address trader, address referrer) private {
        if (referrer == address(0) || referrer == trader || referrerOf[trader] != address(0)) return;
        referrerOf[trader] = referrer;
        emit ReferrerSet(trader, referrer);
    }

    /// @dev Credits the creator, then splits the referral fee in two halves: the larger half (on
    ///      an odd fee) to the trader's referrer and the other to the creator's referrer. A half
    ///      without a payable referrer (none bound, or the referrer is the trader or the creator of
    ///      this trade) joins the protocol fee, which is then split between stakers and the treasury.
    ///      While staking is unset the whole protocol fee is credited to the treasury and no
    ///      external call is made.
    /// @return referralPaid The referral fee actually credited to referrers: the sum of the paid
    ///         halves, 0 when there is nobody to pay.
    function _distributeFees(
        address creator,
        address trader,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 referralFee
    ) private returns (uint256 referralPaid) {
        if (creatorFee != 0) claimable[creator] += creatorFee;

        uint256 creatorHalf = referralFee / 2;
        uint256 traderHalf = referralFee - creatorHalf;
        address traderReferrer = referrerOf[trader];
        if (_payableReferrer(traderReferrer, trader, creator)) {
            referralPaid = traderHalf;
            if (traderHalf != 0) claimable[traderReferrer] += traderHalf;
        } else {
            protocolFee += traderHalf;
        }
        address creatorReferrer = referrerOf[creator];
        if (_payableReferrer(creatorReferrer, trader, creator)) {
            referralPaid += creatorHalf;
            if (creatorHalf != 0) claimable[creatorReferrer] += creatorHalf;
        } else {
            protocolFee += creatorHalf;
        }
        if (protocolFee == 0) return referralPaid;

        IInfluenceStaking staking_ = staking;
        if (address(staking_) == address(0)) {
            claimable[treasury] += protocolFee;
            return referralPaid;
        }
        uint256 toStakers = (protocolFee * stakerShareBps) / BPS;
        uint256 toTreasury = protocolFee - toStakers;
        if (toTreasury != 0) claimable[treasury] += toTreasury;
        if (toStakers != 0) staking_.notifyEthReward{value: toStakers}();
    }

    /// @dev Emits Trade for msg.sender with the price of the next whole key after the trade. Kept
    ///      out of buyKeys and sellKeys so the eleven event fields do not push them over the EVM
    ///      stack limit (the project builds without via-IR).
    function _emitTrade(
        address creator,
        bool isBuy,
        uint256 amount,
        uint256 price,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 referralPaid,
        uint256 newSupply,
        uint256 heldAfter
    ) private {
        emit Trade(
            msg.sender,
            creator,
            isBuy,
            amount,
            price,
            protocolFee,
            creatorFee,
            referralPaid,
            newSupply,
            getPrice(newSupply, UNIT),
            heldAfter
        );
    }

    /// @dev A referrer earns their half only when they are a third party to the trade.
    function _payableReferrer(address referrer, address trader, address creator) private pure returns (bool) {
        return referrer != address(0) && referrer != trader && referrer != creator;
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
