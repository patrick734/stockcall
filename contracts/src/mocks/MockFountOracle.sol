// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFountOracle} from "../interfaces/IFountOracle.sol";

// Test double only. Never deploy to a live network.
// Prices a token at a fixed USDG value per whole token (`unit` = 10 ** decimals), or reports it unpriced.

contract MockFountOracle is IFountOracle {
    mapping(address => uint256) public valuePerUnit;
    mapping(address => uint256) public unitOf;
    mapping(address => bool) public fresh;
    bool public reverts;

    function setPrice(address token, uint256 unit, uint256 value) external {
        unitOf[token] = unit;
        valuePerUnit[token] = value;
        fresh[token] = true;
    }

    function setFresh(address token, bool f) external {
        fresh[token] = f;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function isFresh(address token) external view returns (bool) {
        require(!reverts, "oracle down");
        return fresh[token];
    }

    function usdgValue(address token, uint256 amount) external view returns (uint256) {
        require(fresh[token], "unpriced");
        return (amount * valuePerUnit[token]) / unitOf[token];
    }

    function fromUsdgValue(address token, uint256 usdgAmount) external view returns (uint256) {
        require(fresh[token], "unpriced");
        return (usdgAmount * unitOf[token]) / valuePerUnit[token];
    }
}
