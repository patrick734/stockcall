// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {IFountOracle} from "./interfaces/IFountOracle.sol";
import {GovernanceChecks} from "./governance/GovernanceChecks.sol";

/// @title Arena
/// @notice Hourly forecast rounds on tokenized stocks and ETH. Every hour has a card of questions; players answer
///         with probabilities and stake ETH from their Arena balance. After the hour the contract reads 5-minute
///         TWAPs from Uniswap v3 pools quoted in USDG, turns each move into a soft answer, scores every entry with a
///         strictly proper rule (Brier, or the ranked probability score for ordered buckets) and redistributes the
///         stakes by weighted-score wagering: entries scoring above the room's stake-weighted mean gain, those below
///         lose. The fee is a share of profit only and goes to the $CALL buy-and-burn.
/// @dev Round n is the hour [n * P, (n + 1) * P).
///      - Hidden entries: players commit a hash of their forecast from n * P - P - W until n * P - W (the lock), and
///        reveal it from the lock until n * P. Nobody can copy the room. An entry not revealed by n * P forfeits
///        its stake to the burn, which makes revealing only the forecasts that look good strictly worse than
///        revealing all of them. Anyone holding the preimage may reveal, so a relay can reveal for a player.
///      - Play balance: deposits, winnings and refunds sit in a per-player balance that commits draw from.
///        Withdrawals, reveals, settlement and claims are never paused.
///      - Price guard: for assets with a Chainlink feed in the StockFount oracle, the start TWAP is checked against
///        Chainlink read during the start window, and the end TWAP against Chainlink read at settlement. A gap above
///        the round's guard voids the round (full refunds). A round whose guard was live at the start and that is
///        not settled within GUARD_WINDOW of its end is voided too, because a late Chainlink read no longer
///        describes the end window.
///      Safety properties:
///      - ETH leaves only to the wallet that owns a balance, or as fees to the immutable `feeSink`.
///      - The admin is a 48h timelock from the constructor; the deployer holds nothing.
///      - A round keeps the card, fee and guard it had at its first commit; a fee change also waits FEE_DELAY.
///      - Only pools the Uniswap v3 factory vouches for, quoted in USDG, can be registered, and a card is refused
///        unless every pool it reads keeps at least MIN_OBSERVATIONS observations.
///      - If any pool read fails at settlement the round is void and every revealed entry is refunded in full.
contract Arena is AccessControl, Pausable, ReentrancyGuard, Multicall {
    /// @notice Release of the StockCall contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public constant P = 3600; // round length
    uint256 public constant W = 300; // TWAP window, and the reveal window
    uint256 public constant GUARD_WINDOW = 1800; // a guarded round must settle this soon after its end
    uint256 public constant MIN_OBSERVATIONS = P + W + GUARD_WINDOW + 600;
    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant FEE_DELAY = 24 hours;
    uint256 public constant MAX_QUESTIONS = 3;
    uint256 public constant MAX_OPTIONS = 4;
    uint256 public constant MAX_ASSETS = 15;
    uint256 public constant MIN_GAS_PER_READ = 200_000;
    uint256 public constant MAX_STAKE_CAP = 10 ether;
    uint256 public constant MAX_ROUND_CAP = 100 ether;
    uint16 public constant MIN_GUARD_TICKS = 50; // about 0.5%
    uint16 public constant MAX_GUARD_TICKS = 2_000; // about 22%

    uint8 public constant NOUL = 0; // yes/no about a move against a line
    uint8 public constant CHOICE = 1; // which asset moves most
    uint8 public constant SCORE = 2; // ordered buckets of a move

    uint8 public constant GUARD_OFF = 0; // never checked (no Chainlink feed, for example ETH)
    uint8 public constant GUARD_IF_PRICED = 1; // checked whenever the oracle prices the asset
    uint8 public constant GUARD_REQUIRED = 2; // the round is void unless the oracle prices the asset

    uint8 private constant OPEN = 0;
    uint8 private constant SETTLED = 1;
    uint8 private constant VOID = 2;

    struct Question {
        uint8 kind;
        uint8 options; // NOUL: 2; CHOICE: number of assets; SCORE: buckets
        uint8[3] assets; // NOUL and SCORE use assets[0]
        int32[3] lines; // ticks. NOUL: lines[0]. SCORE: options - 1 increasing bucket lines
        uint32 margin; // soft margin in ticks
        bool absMove; // SCORE: bucket the size of the move, either way
    }

    struct SchemaInit {
        uint256 id;
        Question[] questions;
    }

    struct AssetInit {
        uint8 id;
        address pool;
        uint8 guard;
    }

    struct Asset {
        address pool;
        bool flip; // the asset is the pool's token1, so a higher tick means a lower asset price
        uint8 guard;
        uint8 decimals;
        address token;
    }

    struct Round {
        uint64 schemaId; // 0 until the first commit fixes it
        uint16 feeBps;
        uint16 guardTicks;
        uint8 state;
        bool snapped; // Chainlink was read during the start window
        uint32 entries;
        uint32 revealed;
        uint128 pot; // all committed stakes
        uint128 revealedPot; // the stakes that play
    }

    struct Entry {
        uint96 stake;
        bool revealed;
        bool claimed;
        bytes32 commitment;
        uint256 probs;
    }

    struct Snap {
        bool priced;
        int24 tick;
    }

    struct Config {
        address admin;
        address guardian;
        IUniswapV3Factory v3Factory;
        address usdg;
        IFountOracle oracle;
        address payable feeSink;
        uint16 feeBps;
        uint16 guardTicks;
        uint96 minStake;
        uint96 maxStake;
        uint128 roundCap;
        uint64 weekdaySchema;
        uint64 weekendSchema;
        uint256 weekdayHours; // 168-bit hour-of-week bitmap, hour 0 = Monday 00:00 UTC
        AssetInit[] assets;
        SchemaInit[] schemas;
    }

    IUniswapV3Factory public immutable v3Factory;
    address public immutable usdg;
    /// @notice The StockFount Chainlink oracle used by the price guard.
    IFountOracle public immutable oracle;
    /// @notice Receives the fees and forfeits (the $CALL buy-and-burn contract).
    address payable public immutable feeSink;

    uint96 public minStake;
    uint96 public maxStake;
    uint128 public roundCap;
    uint64 public weekdaySchema;
    uint64 public weekendSchema;
    uint16 public guardTicks;
    uint256 public weekdayHours;
    uint256 public feesAccrued;
    /// @notice Sum of all player balances.
    uint256 public totalBalances;

    uint16 private _feeBps;
    uint16 private _pendingFeeBps;
    uint64 private _pendingFeeAt;

    mapping(address player => uint256) public balanceOf;
    mapping(uint8 id => Asset) public assets;
    mapping(uint256 id => Question[]) private _schemas;
    mapping(uint256 n => Round) public rounds;
    mapping(uint256 n => mapping(address player => Entry)) private _entries;
    mapping(uint256 n => mapping(uint8 asset => Snap)) private _snaps;
    /// @dev Running sums per round and question over revealed entries: Q2 = sum w * |u|^2, Q1[j] = sum w * u_j.
    mapping(uint256 n => mapping(uint256 q => uint256)) private _q2;
    mapping(uint256 n => mapping(uint256 slot => uint256)) private _q1;
    /// @dev After settlement: the answer vector v per question (16 bits per option) and the room's total loss T.
    mapping(uint256 n => mapping(uint256 q => uint256)) private _answer;
    mapping(uint256 n => mapping(uint256 q => int256)) private _total;

    event Deposited(address indexed player, uint256 amount);
    event Withdrawn(address indexed player, uint256 amount);
    event Committed(uint256 indexed round, address indexed player, uint256 stake, bytes32 commitment);
    event Revealed(uint256 indexed round, address indexed player, uint256 probs);
    event Snapshot(uint256 indexed round);
    event Settled(uint256 indexed round, int256[] moves, bool isVoid, uint8 reason);
    event Claimed(uint256 indexed round, address indexed player, uint256 paid, uint256 fee);
    event FeesFlushed(uint256 amount);
    event FeeScheduled(uint16 bps, uint64 effectiveAt);
    event GuardSet(uint16 ticks);
    event LimitsSet(uint96 minStake, uint96 maxStake, uint128 roundCap);
    event ScheduleSet(uint64 weekdaySchema, uint64 weekendSchema, uint256 weekdayHours);
    event SchemaSet(uint256 indexed id);
    event AssetSet(uint8 indexed id, address pool, bool flip, uint8 guard);

    /// @notice Why a round was voided (0 = settled normally).
    uint8 public constant VOID_NO_REVEALS = 1;
    uint8 public constant VOID_POOL_READ = 2;
    uint8 public constant VOID_GUARD_START = 3;
    uint8 public constant VOID_GUARD_END = 4;
    uint8 public constant VOID_GUARD_LATE = 5;

    error InvalidConfig();
    error InvalidAsset(uint8 id);
    error InvalidSchema(uint256 id);
    error RoundNotOpen(uint256 round);
    error NotRevealWindow(uint256 round);
    error WrongSchema(uint256 expected);
    error BadStake();
    error RoundFull();
    error AlreadyEntered();
    error NoCommitment();
    error AlreadyRevealed();
    error BadReveal();
    error BadProbabilities();
    error InsufficientBalance();
    error NotEnded(uint256 round);
    error AlreadySettled(uint256 round);
    error NothingToClaim(uint256 round);
    error PoolTooShallow(address pool);
    error LowGas();
    error TransferFailed();

    constructor(Config memory c) {
        if (
            address(c.v3Factory) == address(0) || c.usdg == address(0) || c.feeSink == address(0)
                || address(c.oracle) == address(0) || c.guardian == address(0) || c.guardian == c.admin
                || c.guardian == msg.sender
        ) revert InvalidConfig();
        GovernanceChecks.requireTimelock(c.admin, msg.sender);
        v3Factory = c.v3Factory;
        usdg = c.usdg;
        oracle = c.oracle;
        feeSink = c.feeSink;
        if (c.feeBps > MAX_FEE_BPS) revert InvalidConfig();
        _feeBps = c.feeBps;
        _setGuard(c.guardTicks);
        for (uint256 i; i < c.assets.length; ++i) {
            _setAsset(c.assets[i].id, c.assets[i].pool, c.assets[i].guard);
        }
        for (uint256 i; i < c.schemas.length; ++i) {
            _setSchema(c.schemas[i].id, c.schemas[i].questions);
        }
        _setLimits(c.minStake, c.maxStake, c.roundCap);
        _setSchedule(c.weekdaySchema, c.weekendSchema, c.weekdayHours);
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(GUARDIAN_ROLE, c.guardian);
    }

    // ---------------------------------------------------------------- timing

    /// @notice The round taking commits at time `t`.
    function openRound(uint256 t) public pure returns (uint256) {
        return (t + W) / P + 1;
    }

    function openRound() external view returns (uint256) {
        return openRound(block.timestamp);
    }

    /// @notice opens, locks (commits close, reveals and the start TWAP begin), start (reveals close), end.
    function timing(uint256 n) public pure returns (uint256 opens, uint256 locks, uint256 start, uint256 end) {
        start = n * P;
        end = start + P;
        locks = start - W;
        opens = locks - P;
    }

    /// @notice The card round `n` uses: fixed at its first commit, otherwise the schedule's.
    function schemaFor(uint256 n) public view returns (uint256) {
        uint256 fixedId = rounds[n].schemaId;
        if (fixedId != 0) return fixedId;
        uint256 hourOfWeek = (n + 72) % 168; // 1 Jan 1970 was a Thursday, 72 hours after a Monday
        return (weekdayHours >> hourOfWeek) & 1 == 1 ? weekdaySchema : weekendSchema;
    }

    function feeBps() public view returns (uint16) {
        if (_pendingFeeAt != 0 && block.timestamp >= _pendingFeeAt) return _pendingFeeBps;
        return _feeBps;
    }

    function schema(uint256 id) external view returns (Question[] memory) {
        return _schemas[id];
    }

    function entryOf(uint256 n, address player) external view returns (Entry memory) {
        return _entries[n][player];
    }

    function snapOf(uint256 n, uint8 asset) external view returns (Snap memory) {
        return _snaps[n][asset];
    }

    /// @notice The hash a player commits for round `n`. Keep `salt` secret and random until the reveal.
    function commitmentFor(uint256 n, address player, uint256 probs, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), n, player, probs, salt));
    }

    // ---------------------------------------------------------------- balance

    function deposit() external payable whenNotPaused {
        _credit(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraws from the balance. Never paused.
    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(msg.sender, amount);
    }

    // ---------------------------------------------------------------- play

    /// @notice Commits a hidden entry to round `n`, drawing `stake` from the balance after adding any ETH sent.
    ///         `commitment` is `commitmentFor(n, msg.sender, probs, salt)`.
    function commit(uint256 n, uint256 schemaId, uint256 stake, bytes32 commitment)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (msg.value != 0) {
            _credit(msg.sender, msg.value);
            emit Deposited(msg.sender, msg.value);
        }
        if (n != openRound(block.timestamp)) revert RoundNotOpen(n);
        Round storage r = rounds[n];
        if (r.schemaId == 0) {
            uint256 due = schemaFor(n);
            if (schemaId != due) revert WrongSchema(due);
            _requireDeepPools(due);
            r.schemaId = uint64(due);
            r.feeBps = feeBps();
            r.guardTicks = guardTicks;
        } else if (schemaId != r.schemaId) {
            revert WrongSchema(r.schemaId);
        }
        if (stake < minStake || stake > maxStake) revert BadStake();
        if (r.pot + stake > roundCap) revert RoundFull();
        if (commitment == bytes32(0)) revert NoCommitment();
        Entry storage e = _entries[n][msg.sender];
        if (e.stake != 0) revert AlreadyEntered();
        uint256 bal = balanceOf[msg.sender];
        if (bal < stake) revert InsufficientBalance();
        balanceOf[msg.sender] = bal - stake;
        totalBalances -= stake;

        e.stake = uint96(stake);
        e.commitment = commitment;
        r.pot += uint128(stake);
        r.entries += 1;
        emit Committed(n, msg.sender, stake, commitment);
    }

    /// @notice Reveals `player`'s entry to round `n`, between the lock and the start. Anyone with the preimage may
    ///         call it. Never paused. Probabilities are packed: option i of the card (questions in order, options
    ///         in order) is bits 16i..16i+15, in basis points; each question's options sum to exactly 10,000.
    function reveal(uint256 n, address player, uint256 probs, bytes32 salt) external {
        (, uint256 locks, uint256 start,) = timing(n);
        if (block.timestamp < locks || block.timestamp >= start) revert NotRevealWindow(n);
        Entry storage e = _entries[n][player];
        if (e.stake == 0) revert NoCommitment();
        if (e.revealed) revert AlreadyRevealed();
        if (commitmentFor(n, player, probs, salt) != e.commitment) revert BadReveal();
        Round storage r = rounds[n];
        if (!r.snapped) _snapshot(n, r);

        Question[] storage qs = _schemas[r.schemaId];
        uint256 w = e.stake;
        uint256 bit;
        for (uint256 q; q < qs.length; ++q) {
            uint256[MAX_OPTIONS] memory u = _forecast(qs[q], probs, bit);
            bit += qs[q].options;
            uint256 sq;
            for (uint256 j; j < _uLength(qs[q]); ++j) {
                sq += u[j] * u[j];
                _q1[n][q * MAX_OPTIONS + j] += w * u[j];
            }
            _q2[n][q] += w * sq;
        }
        if (probs >> (16 * bit) != 0) revert BadProbabilities();

        e.revealed = true;
        e.probs = probs;
        r.revealed += 1;
        r.revealedPot += uint128(w);
        emit Revealed(n, player, probs);
    }

    /// @notice Reads Chainlink for round `n`'s guarded assets during its start window. Reveals do this on their
    ///         own; anyone may call it.
    function snapshot(uint256 n) external {
        (, uint256 locks, uint256 start,) = timing(n);
        if (block.timestamp < locks || block.timestamp >= start) revert NotRevealWindow(n);
        Round storage r = rounds[n];
        if (r.schemaId == 0 || r.snapped) return;
        _snapshot(n, r);
    }

    /// @notice Reads the pools and freezes round `n`'s answer. Anyone may call it once the hour has ended.
    function settle(uint256 n) public {
        Round storage r = rounds[n];
        if (r.state != OPEN) revert AlreadySettled(n);
        (, uint256 locks, uint256 start, uint256 end) = timing(n);
        if (block.timestamp < end) revert NotEnded(n);
        // Unrevealed stakes are forfeited in every outcome.
        feesAccrued += r.pot - r.revealedPot;
        if (r.revealed == 0) {
            _void(n, r, new int256[](0), VOID_NO_REVEALS);
            return;
        }
        Question[] storage qs = _schemas[r.schemaId];

        // One observe per asset: cumulatives at start - W, start, end - W, end.
        int256[] memory moves = new int256[](MAX_ASSETS + 1);
        bool[] memory read = new bool[](MAX_ASSETS + 1);
        uint32[] memory ago = new uint32[](4);
        ago[0] = uint32(block.timestamp - locks);
        ago[1] = uint32(block.timestamp - start);
        ago[2] = uint32(block.timestamp - (end - W));
        ago[3] = uint32(block.timestamp - end);
        bool late = block.timestamp > end + GUARD_WINDOW;
        for (uint256 q; q < qs.length; ++q) {
            uint256 count = qs[q].kind == CHOICE ? qs[q].options : 1;
            for (uint256 a; a < count; ++a) {
                uint8 id = qs[q].assets[a];
                if (read[id]) continue;
                read[id] = true;
                // Refuse to run short instead of letting an out-of-gas read void the round.
                if (gasleft() < MIN_GAS_PER_READ) revert LowGas();
                Asset memory asset = assets[id];
                int256 startCum;
                int256 endCum;
                try IUniswapV3Pool(asset.pool).observe(ago) returns (int56[] memory c, uint160[] memory) {
                    startCum = int256(c[1]) - int256(c[0]);
                    endCum = int256(c[3]) - int256(c[2]);
                } catch {
                    _void(n, r, moves, VOID_POOL_READ);
                    return;
                }
                if (asset.flip) (startCum, endCum) = (-startCum, -endCum);
                moves[id] = endCum - startCum;
                if (asset.guard != GUARD_OFF) {
                    uint8 reason = _guard(n, id, asset, startCum, endCum, late, r.guardTicks);
                    if (reason != 0) {
                        _void(n, r, moves, reason);
                        return;
                    }
                }
            }
        }

        uint256 pot = r.revealedPot;
        for (uint256 q; q < qs.length; ++q) {
            uint256[MAX_OPTIONS] memory v = _answerFor(qs[q], moves);
            uint256 len = _uLength(qs[q]);
            int256 cross;
            uint256 vv;
            uint256 packed;
            for (uint256 j; j < len; ++j) {
                cross += int256(v[j] * _q1[n][q * MAX_OPTIONS + j]);
                vv += v[j] * v[j];
                packed |= v[j] << (16 * j);
            }
            _answer[n][q] = packed;
            _total[n][q] = int256(_q2[n][q]) - 2 * cross + int256(pot * vv);
        }
        r.state = SETTLED;
        emit Settled(n, moves, false, 0);
    }

    /// @notice Credits every listed round to the balance, settling any that ended but were not settled yet. With
    ///         `toWallet` the whole balance is then sent to the caller.
    function claim(uint256[] calldata ns, bool toWallet) external nonReentrant returns (uint256 paid) {
        for (uint256 i; i < ns.length; ++i) {
            uint256 n = ns[i];
            if (rounds[n].state == OPEN) settle(n);
            Entry storage e = _entries[n][msg.sender];
            if (!e.revealed || e.claimed) revert NothingToClaim(n);
            e.claimed = true;
            (uint256 payout, uint256 fee) = _payout(n, e);
            feesAccrued += fee;
            paid += payout - fee;
            emit Claimed(n, msg.sender, payout - fee, fee);
        }
        _credit(msg.sender, paid);
        if (toWallet) _withdraw(msg.sender, balanceOf[msg.sender]);
    }

    /// @notice What `player` would receive from round `n` now (0 before settlement or if unrevealed), and the fee.
    function previewPayout(uint256 n, address player) external view returns (uint256 received, uint256 fee) {
        Entry storage e = _entries[n][player];
        if (!e.revealed || e.claimed || rounds[n].state == OPEN) return (0, 0);
        (uint256 payout, uint256 f) = _payout(n, e);
        return (payout - f, f);
    }

    /// @notice The frozen answer of a settled round: one vector per question, in basis points. For a SCORE question
    ///         it is cumulative (the ranked probability score works on cumulative probabilities).
    function answerOf(uint256 n) external view returns (uint256[] memory packed) {
        uint256 len = _schemas[rounds[n].schemaId].length;
        packed = new uint256[](len);
        for (uint256 q; q < len; ++q) {
            packed[q] = _answer[n][q];
        }
    }

    /// @notice Sends accrued fees and forfeits to the $CALL buy-and-burn. Anyone may call it.
    function flushFees() external nonReentrant {
        uint256 amount = feesAccrued;
        feesAccrued = 0;
        emit FeesFlushed(amount);
        _send(feeSink, amount);
    }

    // ---------------------------------------------------------------- price guard

    /// @notice The oracle's price of an asset as a tick of the asset quoted in USDG (asset as token0).
    function oracleTick(uint8 id) public view returns (bool priced, int24 tick) {
        Asset memory a = assets[id];
        if (a.token == address(0)) return (false, 0);
        try oracle.isFresh(a.token) returns (bool fresh) {
            if (!fresh) return (false, 0);
        } catch {
            return (false, 0);
        }
        uint256 unit = 10 ** a.decimals;
        uint256 value;
        try oracle.usdgValue(a.token, unit) returns (uint256 v) {
            value = v;
        } catch {
            return (false, 0);
        }
        if (value == 0 || value / unit >= type(uint64).max) return (false, 0);
        uint256 sqrtP = Math.sqrt(Math.mulDiv(value, 1 << 192, unit));
        if (sqrtP < TickMath.MIN_SQRT_PRICE || sqrtP >= TickMath.MAX_SQRT_PRICE) return (false, 0);
        return (true, TickMath.getTickAtSqrtPrice(uint160(sqrtP)));
    }

    function _snapshot(uint256 n, Round storage r) private {
        r.snapped = true;
        Question[] storage qs = _schemas[r.schemaId];
        for (uint256 q; q < qs.length; ++q) {
            uint256 count = qs[q].kind == CHOICE ? qs[q].options : 1;
            for (uint256 a; a < count; ++a) {
                uint8 id = qs[q].assets[a];
                if (assets[id].guard == GUARD_OFF || _snaps[n][id].priced) continue;
                (bool priced, int24 tick) = oracleTick(id);
                if (priced) _snaps[n][id] = Snap(true, tick);
            }
        }
        emit Snapshot(n);
    }

    /// @dev 0 when the asset passes, otherwise the void reason. Cumulatives are in the asset's direction.
    function _guard(uint256 n, uint8 id, Asset memory a, int256 startCum, int256 endCum, bool late, uint16 maxGap)
        private
        view
        returns (uint8)
    {
        bool required = a.guard == GUARD_REQUIRED;
        Snap memory s = _snaps[n][id];
        if (s.priced) {
            if (_gap(startCum, s.tick) > maxGap) return VOID_GUARD_START;
        } else if (required) {
            return VOID_GUARD_START;
        }
        // Late, a Chainlink read no longer describes the end window. That matters only where the guard is live.
        if (late) return s.priced || required ? VOID_GUARD_LATE : 0;
        (bool priced, int24 tick) = oracleTick(id);
        if (priced) {
            if (_gap(endCum, tick) > maxGap) return VOID_GUARD_END;
        } else if (required) {
            return VOID_GUARD_END;
        }
        return 0;
    }

    function _gap(int256 cum, int24 tick) private pure returns (uint256) {
        int256 d = cum / int256(W) - int256(tick);
        return d < 0 ? uint256(-d) : uint256(d);
    }

    function _void(uint256 n, Round storage r, int256[] memory moves, uint8 reason) private {
        r.state = VOID;
        emit Settled(n, moves, true, reason);
    }

    // ---------------------------------------------------------------- scoring

    /// @dev u for one question: the probabilities (Brier) or their cumulative sums (ranked probability score).
    function _forecast(Question storage qn, uint256 probs, uint256 bit)
        private
        view
        returns (uint256[MAX_OPTIONS] memory u)
    {
        uint256 k = qn.options;
        uint256 sum;
        for (uint256 j; j < k; ++j) {
            uint256 p = (probs >> (16 * (bit + j))) & 0xffff;
            sum += p;
            u[j] = qn.kind == SCORE ? sum : p;
        }
        if (sum != 10_000) revert BadProbabilities();
    }

    function _uLength(Question storage qn) private view returns (uint256) {
        return qn.kind == SCORE ? qn.options - 1 : qn.options;
    }

    function _normaliser(Question storage qn) private view returns (uint256) {
        return qn.kind == SCORE ? (qn.options - 1) * 1e8 : 2e8;
    }

    /// @dev The chain's soft answer to one question, given each asset's move in tick-seconds.
    function _answerFor(Question storage qn, int256[] memory moves) private view returns (uint256[MAX_OPTIONS] memory v) {
        int256 mw = int256(uint256(qn.margin) * W);
        if (qn.kind == NOUL) {
            int256 x = moves[qn.assets[0]] - int256(qn.lines[0]) * int256(W);
            uint256 yes = _clamp(5_000 + _floorDiv(5_000 * x, mw));
            v[0] = yes;
            v[1] = 10_000 - yes;
        } else if (qn.kind == CHOICE) {
            uint256 k = qn.options;
            int256 best = type(int256).min;
            uint256 leader;
            for (uint256 i; i < k; ++i) {
                int256 d = moves[qn.assets[i]];
                if (d > best) (best, leader) = (d, i);
            }
            uint256[MAX_OPTIONS] memory g;
            uint256 sum;
            for (uint256 i; i < k; ++i) {
                int256 gi = mw - (best - moves[qn.assets[i]]);
                g[i] = gi > 0 ? uint256(gi) : 0;
                sum += g[i];
            }
            uint256 assigned;
            for (uint256 i; i < k; ++i) {
                v[i] = (10_000 * g[i]) / sum;
                assigned += v[i];
            }
            v[leader] += 10_000 - assigned;
        } else {
            int256 d = moves[qn.assets[0]];
            int256 x = qn.absMove && d < 0 ? -d : d;
            uint256 lines = qn.options - 1;
            for (uint256 m; m < lines; ++m) {
                v[m] = _clamp(5_000 + _floorDiv(5_000 * (int256(qn.lines[m]) * int256(W) - x), mw));
            }
        }
    }

    function _payout(uint256 n, Entry storage e) private view returns (uint256 payout, uint256 fee) {
        Round storage r = rounds[n];
        uint256 w = e.stake;
        if (r.state == VOID) return (w, 0);
        Question[] storage qs = _schemas[r.schemaId];
        uint256 lambda = 1;
        for (uint256 q; q < qs.length; ++q) {
            uint256 nq = _normaliser(qs[q]);
            lambda = (lambda / _gcd(lambda, nq)) * nq;
        }
        int256 pot = int256(uint256(r.revealedPot));
        int256 num;
        uint256 bit;
        for (uint256 q; q < qs.length; ++q) {
            uint256[MAX_OPTIONS] memory u = _forecast(qs[q], e.probs, bit);
            bit += qs[q].options;
            uint256 v = _answer[n][q];
            uint256 loss;
            for (uint256 j; j < _uLength(qs[q]); ++j) {
                int256 diff = int256(u[j]) - int256((v >> (16 * j)) & 0xffff);
                loss += uint256(diff * diff);
            }
            num += (_total[n][q] - pot * int256(loss)) * int256(lambda / _normaliser(qs[q]));
        }
        int256 den = int256(qs.length) * pot * int256(lambda);
        int256 p = int256(w) + _floorDiv(int256(w) * num, den);
        payout = p > 0 ? uint256(p) : 0;
        if (payout > w) fee = ((payout - w) * r.feeBps) / 10_000;
    }

    function _clamp(int256 x) private pure returns (uint256) {
        if (x < 0) return 0;
        if (x > 10_000) return 10_000;
        return uint256(x);
    }

    /// @dev Division rounding toward minus infinity (Solidity's `/` truncates toward zero).
    function _floorDiv(int256 a, int256 b) private pure returns (int256 q) {
        q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
    }

    function _gcd(uint256 a, uint256 b) private pure returns (uint256) {
        while (b != 0) (a, b) = (b, a % b);
        return a;
    }

    function _requireDeepPools(uint256 id) private view {
        Question[] storage qs = _schemas[id];
        for (uint256 q; q < qs.length; ++q) {
            uint256 count = qs[q].kind == CHOICE ? qs[q].options : 1;
            for (uint256 a; a < count; ++a) {
                address pool = assets[qs[q].assets[a]].pool;
                (,,, uint16 cardinality,,,) = IUniswapV3Pool(pool).slot0();
                if (cardinality < MIN_OBSERVATIONS) revert PoolTooShallow(pool);
            }
        }
    }

    function _credit(address player, uint256 amount) private {
        if (amount == 0) return;
        balanceOf[player] += amount;
        totalBalances += amount;
    }

    function _withdraw(address player, uint256 amount) private {
        if (amount == 0) return;
        uint256 bal = balanceOf[player];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[player] = bal - amount;
        totalBalances -= amount;
        emit Withdrawn(player, amount);
        _send(payable(player), amount);
    }

    function _send(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- governance (48h timelock)

    /// @notice Registers a new asset id. Ids are permanent; a new pool or guard mode gets a new id.
    function setAsset(uint8 id, address pool, uint8 guard) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setAsset(id, pool, guard);
    }

    /// @notice Defines a new card. Cards are permanent; changing the questions means a new id and a new schedule.
    function setSchema(uint256 id, Question[] calldata questions) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSchema(id, questions);
    }

    /// @notice Changes which card future rounds get. A round that already has a commit keeps its card.
    function setSchedule(uint64 weekday, uint64 weekend, uint256 hoursBitmap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSchedule(weekday, weekend, hoursBitmap);
    }

    function setLimits(uint96 min_, uint96 max_, uint128 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setLimits(min_, max_, cap);
    }

    /// @notice Sets the price guard for future rounds, within hard limits. It can never be switched off.
    function setGuard(uint16 ticks) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setGuard(ticks);
    }

    /// @notice Schedules a new fee rate, effective FEE_DELAY later; each round keeps the rate at its first commit.
    function setFeeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert InvalidConfig();
        _feeBps = feeBps();
        _pendingFeeBps = bps;
        _pendingFeeAt = uint64(block.timestamp + FEE_DELAY);
        emit FeeScheduled(bps, _pendingFeeAt);
    }

    /// @notice Stops new deposits and commits. Reveals, settling, claims and withdrawals keep working.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _setAsset(uint8 id, address pool, uint8 guard) private {
        // An asset id is permanent: repointing it could change the answer of a round already in play.
        if (id == 0 || id > MAX_ASSETS || pool == address(0) || assets[id].pool != address(0) || guard > GUARD_REQUIRED) {
            revert InvalidAsset(id);
        }
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        if (v3Factory.getPool(t0, t1, p.fee()) != pool || (t0 != usdg && t1 != usdg)) revert InvalidAsset(id);
        bool flip = t0 == usdg; // the asset is token1
        address token = flip ? t1 : t0;
        uint8 decimals = IERC20Metadata(token).decimals();
        if (decimals > 36) revert InvalidAsset(id);
        assets[id] = Asset(pool, flip, guard, decimals, token);
        emit AssetSet(id, pool, flip, guard);
    }

    function _setSchema(uint256 id, Question[] memory questions) private {
        // A card is permanent once defined: rounds already in play keep exactly the questions they were entered on.
        if (
            id == 0 || id > type(uint64).max || questions.length == 0 || questions.length > MAX_QUESTIONS
                || _schemas[id].length != 0
        ) revert InvalidSchema(id);
        uint256 totalOptions;
        for (uint256 q; q < questions.length; ++q) {
            Question memory qn = questions[q];
            uint256 k = qn.options;
            totalOptions += k;
            bool ok = qn.margin > 0 && k >= 2 && k <= MAX_OPTIONS;
            if (qn.kind == NOUL) {
                ok = ok && k == 2 && _known(qn.assets[0]);
            } else if (qn.kind == CHOICE) {
                ok = ok && k <= 3;
                for (uint256 a; a < k && ok; ++a) {
                    ok = _known(qn.assets[a]);
                    for (uint256 b; b < a && ok; ++b) {
                        ok = qn.assets[a] != qn.assets[b];
                    }
                }
            } else if (qn.kind == SCORE) {
                ok = ok && _known(qn.assets[0]);
                for (uint256 m = 1; m + 1 < k && ok; ++m) {
                    ok = qn.lines[m] > qn.lines[m - 1];
                }
                if (qn.absMove && ok) ok = qn.lines[0] >= 0;
            } else {
                ok = false;
            }
            if (!ok) revert InvalidSchema(id);
            _schemas[id].push(qn);
        }
        if (totalOptions > 16) revert InvalidSchema(id);
        emit SchemaSet(id);
    }

    function _known(uint8 id) private view returns (bool) {
        return id != 0 && id <= MAX_ASSETS && assets[id].pool != address(0);
    }

    function _setSchedule(uint64 weekday, uint64 weekend, uint256 hoursBitmap) private {
        if (_schemas[weekday].length == 0 || _schemas[weekend].length == 0 || hoursBitmap >> 168 != 0) {
            revert InvalidConfig();
        }
        weekdaySchema = weekday;
        weekendSchema = weekend;
        weekdayHours = hoursBitmap;
        emit ScheduleSet(weekday, weekend, hoursBitmap);
    }

    function _setLimits(uint96 min_, uint96 max_, uint128 cap) private {
        if (min_ == 0 || min_ > max_ || max_ > MAX_STAKE_CAP || cap < max_ || cap > MAX_ROUND_CAP) revert InvalidConfig();
        minStake = min_;
        maxStake = max_;
        roundCap = cap;
        emit LimitsSet(min_, max_, cap);
    }

    function _setGuard(uint16 ticks) private {
        if (ticks < MIN_GUARD_TICKS || ticks > MAX_GUARD_TICKS) revert InvalidConfig();
        guardTicks = ticks;
        emit GuardSet(ticks);
    }
}
