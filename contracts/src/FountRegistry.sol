// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {GovernanceChecks} from "./governance/GovernanceChecks.sol";

/// @title FountRegistry
/// @notice Canonical on-chain list of StockCall Founts (and future programs) for the app and indexers.
///         Owned by the timelock from construction; the initial Founts are listed by the constructor.
contract FountRegistry is Ownable2Step {
    /// @notice Release of the StockCall contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    enum Kind {
        Fount,
        Program
    }

    struct Entry {
        address target;
        Kind kind;
        string ticker;
        bool listed;
    }

    Entry[] private _entries;
    mapping(address target => uint256) public indexPlusOne;

    event Listed(address indexed target, Kind kind, string ticker);
    event Delisted(address indexed target);

    error AlreadyListed();
    error Unknown();

    struct Listing {
        address target;
        Kind kind;
        string ticker;
    }

    constructor(address owner_, Listing[] memory initial) Ownable(owner_) {
        GovernanceChecks.requireTimelock(owner_, msg.sender);
        for (uint256 i; i < initial.length; ++i) {
            _list(initial[i].target, initial[i].kind, initial[i].ticker);
        }
    }

    function list(address target, Kind kind, string calldata ticker) external onlyOwner {
        _list(target, kind, ticker);
    }

    function _list(address target, Kind kind, string memory ticker) private {
        if (target == address(0)) revert Unknown();
        if (indexPlusOne[target] != 0) revert AlreadyListed();
        _entries.push(Entry(target, kind, ticker, true));
        indexPlusOne[target] = _entries.length;
        emit Listed(target, kind, ticker);
    }

    function delist(address target) external onlyOwner {
        uint256 i = indexPlusOne[target];
        if (i == 0) revert Unknown();
        _entries[i - 1].listed = false;
        emit Delisted(target);
    }

    function entries() external view returns (Entry[] memory) {
        return _entries;
    }
}
